"use strict";

require("dotenv").config();
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { DEFAULT_DEVELOPMENT_JWT_SECRET, extractBearerToken, parseAllowedOrigins, isLegacyBearerAllowed } = require("../security/securityControls");
const { getSessionCookieToken, isTrustedCookieMutationOrigin, clearSessionCookie } = require("../security/sessionCookies");

function clearInvalidCookieSession(res) {
  try { clearSessionCookie(res, process.env); } catch { /* Do not mask the authentication failure. */ }
}

// The development fallback keeps local setup easy. server.js refuses to start in
// production unless a unique, sufficiently long JWT_SECRET is configured.
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : DEFAULT_DEVELOPMENT_JWT_SECRET);

/** Verify the token and re-check current account status and role in the database. */
async function verifyToken(req, res, next) {
  const bearerToken = extractBearerToken(req.headers.authorization);
  if (bearerToken && !isLegacyBearerAllowed(process.env)) {
    return res.status(401).json({ success: false, message: "Bearer-token authentication is disabled on this production deployment. Sign in through the CORNESTONE web application." });
  }
  const cookieToken = bearerToken ? null : getSessionCookieToken(req.headers.cookie);
  const token = bearerToken || cookieToken;
  const tokenSource = bearerToken ? "bearer" : (cookieToken ? "cookie" : null);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: req.headers.authorization ? "Access denied. Use a valid Bearer token." : "Access denied. No valid session was provided.",
    });
  }
  // Cookie authentication is protected against cross-site request forgery by
  // requiring an exact configured frontend Origin on every unsafe HTTP method.
  // Bearer clients are not subject to this browser-cookie CSRF check.
  if (tokenSource === "cookie") {
    let allowedOrigins;
    try {
      allowedOrigins = parseAllowedOrigins(process.env);
    } catch {
      return res.status(503).json({ success: false, message: "Session security is not configured correctly." });
    }
    if (!isTrustedCookieMutationOrigin(req, allowedOrigins)) {
      return res.status(403).json({ success: false, message: "The request origin is not allowed to use this session." });
    }
  }
  if (!JWT_SECRET) {
    return res.status(503).json({ success: false, message: "Authentication is not configured on this server." });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    if (tokenSource === "cookie") clearInvalidCookieSession(res);
    return res.status(401).json({ success: false, message: "Your session is invalid or has expired. Please sign in again." });
  }

  const tokenUserId = Number(decoded?.id);
  if (!Number.isSafeInteger(tokenUserId) || tokenUserId <= 0) {
    return res.status(401).json({ success: false, message: "Your session is invalid. Please sign in again." });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, group_id, role, email, phone_number, COALESCE(is_active, 1) AS is_active,
              COALESCE(approval_status, 'APPROVED') AS approval_status,
              COALESCE(token_version, 0) AS token_version
       FROM users WHERE id = ? LIMIT 1`,
      [tokenUserId],
    );
    const account = rows[0];
    if (!account || Number(account.is_active) !== 1 || String(account.approval_status).toUpperCase() !== "APPROVED") {
      if (tokenSource === "cookie") clearInvalidCookieSession(res);
      return res.status(401).json({ success: false, message: "This account is inactive or no longer available. Please contact group leadership." });
    }

    // Password resets increment token_version to revoke all previously issued JWTs.
    if (Number(decoded?.tokenVersion ?? 0) !== Number(account.token_version ?? 0)) {
      if (tokenSource === "cookie") clearInvalidCookieSession(res);
      return res.status(401).json({ success: false, message: "Your session was invalidated. Please sign in again." });
    }

    // Use current database values instead of stale role/group claims from the JWT.
    req.user = {
      id: Number(account.id),
      groupId: Number(account.group_id),
      role: account.role,
      email: account.email,
      phoneNumber: account.phone_number,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    return next();
  } catch (error) {
    console.error("[auth-account-check-failed]", String(error.code || "UNKNOWN"));
    return res.status(503).json({ success: false, message: "Could not verify your account right now. Please try again." });
  }
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access forbidden. Required role(s): ${allowedRoles.join(", ")}`,
      });
    }
    return next();
  };
}

function verifyGroupOwnership(req, res, next) {
  const requestedGroupId = req.params.groupId || req.params.id;
  if (!req.user || !req.user.groupId || !requestedGroupId) {
    return res.status(403).json({ success: false, message: "Access forbidden. Missing user or group association." });
  }
  if (String(req.user.groupId) !== String(requestedGroupId)) {
    return res.status(403).json({ success: false, message: "Access forbidden. You do not have permission to access data for this association." });
  }
  return next();
}

module.exports = { verifyToken, requireRole, verifyGroupOwnership, JWT_SECRET, extractBearerToken };
