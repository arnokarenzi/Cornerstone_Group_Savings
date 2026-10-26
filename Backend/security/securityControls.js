"use strict";

const DEFAULT_DEVELOPMENT_JWT_SECRET = "dev-only-secret-do-not-use-in-production";

function parseAllowedOrigins(env = process.env) {
  const raw = String(env.FRONTEND_ORIGINS || "").trim();
  if (raw) {
    return [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
      try {
        const parsed = new URL(item);
        if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== item.replace(/\/$/, "")) {
          throw new Error();
        }
        return parsed.origin;
      } catch {
        throw new Error(`Invalid FRONTEND_ORIGINS entry: ${item}. Provide an origin only, without a path.`);
      }
    }))];
  }
  if (env.NODE_ENV === "production") return [];
  return ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"];
}

function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const problems = [];
  const secret = String(env.JWT_SECRET || "");
  const looksLikePlaceholder = /(replace.?this|change.?me|example|placeholder|your.?secret|secret.?here|cornestone_super_secret_key_2026)/i.test(secret);
  const obviouslyRepeated = secret.length > 0 && /^(.)\1+$/.test(secret);
  if (secret.length < 32 || secret === DEFAULT_DEVELOPMENT_JWT_SECRET || looksLikePlaceholder || obviouslyRepeated) {
    problems.push("JWT_SECRET must be a unique, non-placeholder secret of at least 32 characters.");
  }
  if (!String(env.FRONTEND_ORIGINS || "").trim()) {
    problems.push("FRONTEND_ORIGINS must list the exact deployed frontend origins, comma-separated.");
  }
  for (const name of ["DB_HOST", "DB_USER", "DB_NAME", "DB_PASSWORD"]) {
    if (!String(env[name] || "").trim()) problems.push(`${name} must be set in production.`);
  }
  if (String(env.DB_USER || "").trim().toLowerCase() === "root") {
    problems.push("DB_USER must be a dedicated least-privilege application account, not root.");
  }
  if (/itsinda/i.test(String(env.DB_NAME || ""))) {
    problems.push("DB_NAME must point to the independent CORNESTONE database, never an Itsinda database.");
  }
  if (/(replace.?with|password.?here|example|placeholder|change.?me)/i.test(String(env.DB_PASSWORD || ""))) {
    problems.push("DB_PASSWORD still appears to contain a placeholder value.");
  }
  if (String(env.DB_SSL_ENABLED || "false").trim().toLowerCase() !== "true") {
    problems.push("DB_SSL_ENABLED must be true in production so the database connection uses TLS with certificate verification.");
  }
  const proxyRaw = String(env.TRUST_PROXY_HOPS ?? "").trim();
  const proxyHops = Number(proxyRaw);
  if (!proxyRaw || !Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) {
    problems.push("TRUST_PROXY_HOPS must be explicitly set to an integer from 0 to 5 that matches the real hosting proxy topology.");
  }
  const cookieSecure = String(env.SESSION_COOKIE_SECURE || "true").trim().toLowerCase();
  if (cookieSecure !== "true") problems.push("SESSION_COOKIE_SECURE must be true in production.");
  const cookieSameSite = String(env.SESSION_COOKIE_SAME_SITE || "Lax").trim().toLowerCase();
  if (!["lax", "strict", "none"].includes(cookieSameSite)) problems.push("SESSION_COOKIE_SAME_SITE must be Lax, Strict, or None.");
  if (!String(env.SMTP_HOST || "").trim()) problems.push("SMTP_HOST must be configured for email verification and password recovery in production.");
  if (!String(env.SMTP_USER || "").trim()) problems.push("SMTP_USER must be configured for production email delivery.");
  if (!String(env.SMTP_PASSWORD || "").trim()) problems.push("SMTP_PASSWORD must be configured for production email delivery.");
  const smtpSecure = String(env.SMTP_SECURE ?? "false").trim().toLowerCase();
  if (!["true", "false"].includes(smtpSecure)) problems.push("SMTP_SECURE must be true or false.");
  if (!String(env.SMTP_FROM || "").trim() || /example\.com|\.example(?:\s|>|$)/i.test(String(env.SMTP_FROM || ""))) problems.push("SMTP_FROM must use a real sender address in production.");
  try {
    const rawAppUrl = String(env.PUBLIC_APP_URL || "").trim();
    const appUrl = new URL(rawAppUrl);
    if (appUrl.protocol !== "https:") problems.push("PUBLIC_APP_URL must use HTTPS in production.");
    if (appUrl.origin !== rawAppUrl.replace(/\/$/, "")) problems.push("PUBLIC_APP_URL must be the frontend origin only, without a path or query string.");
  } catch {
    problems.push("PUBLIC_APP_URL must be set to the deployed frontend URL in production.");
  }
  const smtpPort = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) problems.push("SMTP_PORT must be a valid TCP port.");
  try {
    parseAllowedOrigins(env);
  } catch (error) {
    problems.push(error.message);
  }
  return problems;
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return true; // Allow non-browser clients and platform health checks.
  return allowedOrigins.includes(origin);
}

function isLegacyBearerAllowed(env = process.env) {
  // The production web client uses HttpOnly cookies. Bearer tokens are retained
  // for local development/tests only and must not remain a production bypass.
  return String(env.NODE_ENV || "development").toLowerCase() !== "production";
}

function extractBearerToken(authHeader) {
  if (typeof authHeader !== "string") return null;
  const match = authHeader.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

class FixedWindowLimiter {
  constructor({ windowMs, max }) {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new TypeError("windowMs must be a positive integer");
    if (!Number.isSafeInteger(max) || max <= 0) throw new TypeError("max must be a positive integer");
    this.windowMs = windowMs;
    this.max = max;
    this.windows = new Map();
    this.calls = 0;
  }

  consume(key, now = Date.now()) {
    const normalizedKey = String(key || "unknown");
    let state = this.windows.get(normalizedKey);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(normalizedKey, state);
    }
    state.count += 1;
    this.calls += 1;
    if (this.calls % 1000 === 0 || this.windows.size > 10000) {
      for (const [storedKey, storedState] of this.windows) {
        if (now >= storedState.resetAt) this.windows.delete(storedKey);
      }
      // Keep the in-process limiter bounded if many distinct client IPs appear.
      while (this.windows.size > 10000) {
        const oldestKey = this.windows.keys().next().value;
        if (oldestKey === undefined) break;
        this.windows.delete(oldestKey);
      }
    }
    return {
      allowed: state.count <= this.max,
      limit: this.max,
      remaining: Math.max(0, this.max - state.count),
      resetAt: state.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
    };
  }

  middleware({ message = "Too many requests. Please try again later." } = {}) {
    return (req, res, next) => {
      const key = req.ip || req.socket?.remoteAddress || "unknown";
      const result = this.consume(key);
      res.setHeader("RateLimit-Limit", String(result.limit));
      res.setHeader("RateLimit-Remaining", String(result.remaining));
      res.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        return res.status(429).json({ success: false, message });
      }
      return next();
    };
  }
}

module.exports = {
  DEFAULT_DEVELOPMENT_JWT_SECRET,
  parseAllowedOrigins,
  validateProductionConfig,
  isAllowedOrigin,
  isLegacyBearerAllowed,
  extractBearerToken,
  FixedWindowLimiter,
};
