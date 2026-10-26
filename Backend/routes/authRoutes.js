"use strict";

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { loginRateLimit, registrationRateLimit, emailActionRateLimit, tokenVerificationRateLimit } = require("../middleware/rateLimits");
const { JWT_SECRET, verifyToken, requireRole } = require("../middleware/auth");
const { sendRouteError } = require("../utils/routeErrors");
const { sendVerificationEmail, sendPasswordResetEmail, sendApprovalEmail } = require("../services/emailService");
const { normalizeEmail, isValidEmail, isValidPassword, createRawToken, hashToken } = require("../security/authHelpers");
const { setSessionCookie, clearSessionCookie } = require("../security/sessionCookies");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const COMPANY_KEY = "cornestone";
const GENERIC_REGISTRATION_MESSAGE = "If this email address can be registered, a verification email will be sent. Verify your email, then wait for committee approval before signing in.";
const GENERIC_RECOVERY_MESSAGE = "If an account exists for that email address, instructions will be sent shortly.";

function getRequestMeta(req) {
  return {
    ip: String(req.ip || req.socket?.remoteAddress || "").slice(0, 64) || null,
    userAgent: String(req.get("user-agent") || "").slice(0, 500) || null,
  };
}

async function logAuthEvent({ userId = null, email = null, eventType, success = false, req, details = {} }) {
  const meta = req ? getRequestMeta(req) : {};
  try {
    await db.query(
      `INSERT INTO auth_audit_events
       (user_id, email, event_type, success, ip_address, user_agent, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, email, eventType, success ? 1 : 0, meta.ip || null, meta.userAgent || null, JSON.stringify(details)],
    );
  } catch (error) {
    console.error("[auth-audit-write-failed]", String(error.code || "UNKNOWN"));
  }
}

function inputEmail(body) {
  return normalizeEmail(body && body.email);
}

async function createVerificationToken(userId) {
  const token = createRawToken();
  await db.query(
    "UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL",
    [userId],
  );
  await db.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 24 HOUR))`,
    [userId, hashToken(token)],
  );
  return token;
}

async function createPasswordResetToken(userId) {
  const token = createRawToken();
  await db.query(
    "UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL",
    [userId],
  );
  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 MINUTE))`,
    [userId, hashToken(token)],
  );
  return token;
}

// Public self-registration. Users cannot choose their company or role, and new
// accounts remain PENDING until email verification and committee approval.
router.post("/register", registrationRateLimit, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const fullName = String(body.fullName ?? body.full_name ?? "").trim();
  const email = inputEmail(body);
  const phoneNumber = String(body.phoneNumber ?? body.phone_number ?? "").trim();
  const password = body.password;

  if (!fullName || fullName.length > 255 || !isValidEmail(email)) {
    return res.status(400).json({ success: false, message: "Enter your full name and a valid email address." });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ success: false, message: "Password must be between 12 and 128 characters." });
  }
  if (phoneNumber.length > 50) {
    return res.status(400).json({ success: false, message: "Phone number must not exceed 50 characters." });
  }

  let userId = null;
  try {
    const [existing] = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (existing.length) {
      await logAuthEvent({ userId: existing[0].id, email, eventType: "REGISTRATION_DUPLICATE_EMAIL", success: false, req });
      // Avoid exposing account existence; the unique database key is the final race-safe guard.
      return res.status(202).json({ success: true, message: GENERIC_REGISTRATION_MESSAGE });
    }
    const [companyRows] = await db.query("SELECT id FROM `groups` WHERE company_key = ? LIMIT 1", [COMPANY_KEY]);
    if (!companyRows.length) {
      return res.status(503).json({ success: false, message: "Company setup is incomplete. Please contact CORNESTONE Co.LTD. leadership." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [insertResult] = await db.query(
      `INSERT INTO users
       (group_id, full_name, email, phone_number, password_hash, role, is_active, approval_status)
       VALUES (?, ?, ?, ?, ?, 'MEMBER', 1, 'PENDING')`,
      [companyRows[0].id, fullName, email, phoneNumber || null, passwordHash],
    );
    userId = Number(insertResult.insertId);
    const verificationToken = await createVerificationToken(userId);
    await logAuthEvent({ userId, email, eventType: "SELF_REGISTRATION_CREATED", success: true, req, details: { role: "MEMBER", approvalStatus: "PENDING" } });
    try {
      const delivery = await sendVerificationEmail({ to: email, fullName, token: verificationToken });
      return res.status(201).json({
        success: true,
        message: delivery.mode === "console"
          ? "Your registration is saved. In development, the verification link is printed in the backend terminal. Verify your email and then wait for committee approval."
          : "Your registration is saved. Check your email for a verification link, then wait for committee approval.",
      });
    } catch (mailError) {
      console.error("[verification-email-send-failed]", String(mailError.code || mailError.message || "UNKNOWN"));
      return res.status(502).json({ success: false, message: "Your account was created, but the verification email could not be sent. Configure email delivery or use Resend verification on the sign-in page." });
    }
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(202).json({ success: true, message: GENERIC_REGISTRATION_MESSAGE });
    }
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "Registration could not be completed. Please try again later." });
  }
});

router.post("/verify-email", tokenVerificationRateLimit, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).json({ success: false, message: "This verification link is invalid or has expired. Request a new verification email." });
  }

  const connection = await db.getConnection();
  let user = null;
  try {
    await connection.beginTransaction();
    const [tokenRows] = await connection.query(
      `SELECT evt.id AS token_id, evt.user_id, u.email, u.full_name, u.email_verified_at
       FROM email_verification_tokens evt JOIN users u ON u.id = evt.user_id
       WHERE evt.token_hash = ? AND evt.used_at IS NULL AND evt.expires_at > CURRENT_TIMESTAMP
       LIMIT 1 FOR UPDATE`,
      [hashToken(token)],
    );
    if (!tokenRows.length) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: "This verification link is invalid or has expired. Request a new verification email." });
    }
    user = tokenRows[0];
    await connection.query("UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?", [user.token_id]);
    await connection.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = ?", [user.user_id]);
    await connection.commit();
    await logAuthEvent({ userId: user.user_id, email: user.email, eventType: "EMAIL_VERIFIED", success: true, req });
    return res.status(200).json({ success: true, message: "Email verified. Your account is now waiting for committee approval." });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "Email verification could not be completed." });
  } finally {
    connection.release();
  }
});

router.post("/resend-verification", emailActionRateLimit, async (req, res) => {
  const email = inputEmail(req.body || {});
  if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Enter a valid email address." });
  try {
    const [rows] = await db.query(
      `SELECT id, full_name, email, email_verified_at FROM users
       WHERE email = ? AND approval_status = 'PENDING' AND is_active = 1 LIMIT 1`,
      [email],
    );
    if (rows.length && !rows[0].email_verified_at) {
      const token = await createVerificationToken(rows[0].id);
      let deliveryOk = false;
      let deliveryMode = "smtp";
      try {
        const delivery = await sendVerificationEmail({ to: rows[0].email, fullName: rows[0].full_name, token });
        deliveryMode = delivery.mode;
        deliveryOk = true;
      } catch (mailError) {
        console.error("[verification-email-resend-failed]", String(mailError.code || mailError.message || "UNKNOWN"));
      }
      await logAuthEvent({ userId: rows[0].id, email, eventType: "VERIFICATION_EMAIL_RESEND_REQUESTED", success: deliveryOk, req, details: { deliveryMode } });
    }
    return res.status(200).json({ success: true, message: GENERIC_RECOVERY_MESSAGE });
  } catch (error) {
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The request could not be completed." });
  }
});

router.post("/forgot-password", emailActionRateLimit, async (req, res) => {
  const email = inputEmail(req.body || {});
  if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Enter a valid email address." });
  try {
    const [rows] = await db.query(
      "SELECT id, full_name, email FROM users WHERE email = ? AND is_active = 1 LIMIT 1",
      [email],
    );
    if (rows.length) {
      const user = rows[0];
      const token = await createPasswordResetToken(user.id);
      try {
        await sendPasswordResetEmail({ to: user.email, fullName: user.full_name, token });
        await logAuthEvent({ userId: user.id, email, eventType: "PASSWORD_RESET_REQUESTED", success: true, req });
      } catch (mailError) {
        console.error("[password-reset-email-send-failed]", String(mailError.code || mailError.message || "UNKNOWN"));
        await logAuthEvent({ userId: user.id, email, eventType: "PASSWORD_RESET_EMAIL_FAILED", success: false, req });
      }
    }
    return res.status(200).json({ success: true, message: GENERIC_RECOVERY_MESSAGE });
  } catch (error) {
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The request could not be completed." });
  }
});

router.post("/reset-password", tokenVerificationRateLimit, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const password = req.body?.password;
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).json({ success: false, message: "This reset link is invalid or has expired. Request a new one." });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ success: false, message: "Password must be between 12 and 128 characters." });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT prt.id AS token_id, prt.user_id, u.email
       FROM password_reset_tokens prt JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = ? AND prt.used_at IS NULL AND prt.expires_at > CURRENT_TIMESTAMP
       AND u.is_active = 1 LIMIT 1 FOR UPDATE`,
      [hashToken(token)],
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: "This reset link is invalid or has expired. Request a new one." });
    }
    const record = rows[0];
    const passwordHash = await bcrypt.hash(password, 12);
    await connection.query("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?", [record.token_id]);
    await connection.query("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?", [passwordHash, record.user_id]);
    await connection.query("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL", [record.user_id]);
    await connection.commit();
    clearSessionCookie(res, process.env);
    await logAuthEvent({ userId: record.user_id, email: record.email, eventType: "PASSWORD_RESET_SUCCEEDED", success: true, req });
    return res.status(200).json({ success: true, message: "Password updated. You can now sign in with your new password." });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The password could not be updated." });
  } finally {
    connection.release();
  }
});

// Leadership may see applications, but can only approve an applicant after email
// verification. Members cannot self-assign their role or approve themselves.
router.get("/registrations", verifyToken, requireRole(LEADERSHIP_ROLES), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, full_name, email, phone_number, role, is_active, approval_status,
              email_verified_at, created_at
       FROM users WHERE group_id = ? ORDER BY
         CASE approval_status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'REJECTED' THEN 2 ELSE 3 END,
         created_at DESC`,
      [req.user.groupId],
    );
    return res.status(200).json({ success: true, members: rows });
  } catch (error) {
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "Registrations could not be loaded." });
  }
});

router.patch("/registrations/:userId/decision", verifyToken, requireRole(LEADERSHIP_ROLES), async (req, res) => {
  const userId = Number(req.params.userId);
  const decision = String(req.body?.decision || "").trim().toUpperCase();
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !["APPROVE", "REJECT", "SUSPEND", "REACTIVATE"].includes(decision)) {
    return res.status(400).json({ success: false, message: "A valid account and APPROVE, REJECT, SUSPEND or REACTIVATE decision are required." });
  }
  if (userId === Number(req.user.id) && ["SUSPEND", "REJECT"].includes(decision)) {
    return res.status(400).json({ success: false, message: "You cannot suspend or reject your own signed-in account." });
  }

  const connection = await db.getConnection();
  let applicant;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, group_id, full_name, email, role, approval_status, email_verified_at
       FROM users WHERE id = ? AND group_id = ? LIMIT 1 FOR UPDATE`,
      [userId, req.user.groupId],
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Application not found." });
    }
    applicant = rows[0];
    const currentStatus = String(applicant.approval_status).toUpperCase();
    if (["APPROVE", "REJECT"].includes(decision) && currentStatus !== "PENDING") {
      await connection.rollback();
      return res.status(409).json({ success: false, message: "Only pending applications can be approved or rejected." });
    }
    if (decision === "SUSPEND" && currentStatus !== "APPROVED") {
      await connection.rollback();
      return res.status(409).json({ success: false, message: "Only an approved account can be suspended." });
    }
    if (decision === "REACTIVATE" && currentStatus !== "SUSPENDED") {
      await connection.rollback();
      return res.status(409).json({ success: false, message: "Only a suspended account can be reactivated." });
    }
    if (["APPROVE", "REACTIVATE"].includes(decision) && !applicant.email_verified_at) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: "This member must verify their email before account access can be enabled." });
    }
    const statusByDecision = { APPROVE: "APPROVED", REJECT: "REJECTED", SUSPEND: "SUSPENDED", REACTIVATE: "APPROVED" };
    const newStatus = statusByDecision[decision];
    const isActive = ["APPROVE", "REACTIVATE"].includes(decision) ? 1 : 0;
    const invalidateSessions = ["REJECT", "SUSPEND", "REACTIVATE"].includes(decision) ? 1 : 0;
    await connection.query(
      "UPDATE users SET approval_status = ?, is_active = ?, token_version = token_version + ? WHERE id = ?",
      [newStatus, isActive, invalidateSessions, userId],
    );
    await connection.query(
      `INSERT INTO auth_audit_events
       (user_id, email, event_type, success, ip_address, user_agent, details_json)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      [userId, applicant.email, ["SUSPEND", "REACTIVATE"].includes(decision) ? `ACCOUNT_${decision === "SUSPEND" ? "SUSPENDED" : "REACTIVATED"}` : `REGISTRATION_${newStatus}`, getRequestMeta(req).ip, getRequestMeta(req).userAgent,
        JSON.stringify({ reviewedBy: req.user.id, reviewerRole: req.user.role, decision, reason: reason || null })],
    );
    await connection.commit();
    // Do not send committee-decision mail to an address the applicant has not verified.
    if (applicant.email_verified_at && ["APPROVE", "REJECT", "REACTIVATE"].includes(decision)) {
      try {
        await sendApprovalEmail({ to: applicant.email, fullName: applicant.full_name, approved: ["APPROVE", "REACTIVATE"].includes(decision) });
      } catch (mailError) {
        console.error("[registration-decision-email-failed]", String(mailError.code || mailError.message || "UNKNOWN"));
      }
    }
    const resultMessages = {
      APPROVE: "Member account approved.", REJECT: "Member application rejected.",
      SUSPEND: "Account suspended. Existing sessions were invalidated.",
      REACTIVATE: "Account reactivated. The member must sign in again.",
    };
    return res.status(200).json({ success: true, message: resultMessages[decision] });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The committee decision could not be saved." });
  } finally {
    connection.release();
  }
});

// Only an administrator may appoint committee roles. Accounts must already be
// approved and email-verified; every role change invalidates the target's sessions.
router.get("/committee", verifyToken, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, full_name, email, role, is_active, approval_status, email_verified_at, created_at
       FROM users WHERE group_id = ? AND approval_status = 'APPROVED' AND is_active = 1 AND email_verified_at IS NOT NULL
       ORDER BY CASE role WHEN 'ADMIN' THEN 0 WHEN 'CHAIRPERSON' THEN 1 WHEN 'TREASURER' THEN 2 WHEN 'SECRETARY' THEN 3 ELSE 4 END, full_name`,
      [req.user.groupId],
    );
    return res.status(200).json({ success: true, members: rows });
  } catch (error) {
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "Committee accounts could not be loaded." });
  }
});

router.patch("/committee/:userId/role", verifyToken, requireRole(["ADMIN"]), async (req, res) => {
  const userId = Number(req.params.userId);
  const role = String(req.body?.role || "").trim().toUpperCase();
  const allowedRoles = ["MEMBER", "TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
  if (!Number.isSafeInteger(userId) || userId <= 0 || !allowedRoles.includes(role)) {
    return res.status(400).json({ success: false, message: "Choose a valid account and role." });
  }
  if (userId === Number(req.user.id)) {
    return res.status(400).json({ success: false, message: "For safety, administrators cannot change their own role. Another administrator must make that change." });
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [targetRows] = await connection.query(
      `SELECT id, full_name, email, role, is_active, approval_status, email_verified_at
       FROM users WHERE id = ? AND group_id = ? FOR UPDATE`, [userId, req.user.groupId],
    );
    if (!targetRows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Member account not found in CORNESTONE." });
    }
    const target = targetRows[0];
    if (Number(target.is_active) !== 1 || target.approval_status !== "APPROVED" || !target.email_verified_at) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: "Only active, approved, email-verified members can be appointed to committee roles." });
    }
    if (target.role === role) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: "This member already has the selected role." });
    }
    const leadershipRoles = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
    if (leadershipRoles.includes(String(target.role).toUpperCase()) && !leadershipRoles.includes(role)) {
      const [[pendingPayments]] = await connection.query(
        `SELECT COUNT(*) AS count FROM member_payment_submissions
         WHERE group_id = ? AND intended_recipient_user_id = ? AND status = 'REQUESTED'`,
        [req.user.groupId, userId],
      );
      if (Number(pendingPayments?.count || 0) > 0) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: "This committee member is the designated recipient for pending payment confirmations. Complete those confirmations first, then change the member's role." });
      }
    }
    if (target.role === "ADMIN" && role !== "ADMIN") {
      const [[count]] = await connection.query(
        `SELECT COUNT(*) AS count FROM users WHERE group_id = ? AND role = 'ADMIN' AND is_active = 1 AND approval_status = 'APPROVED' AND email_verified_at IS NOT NULL`,
        [req.user.groupId],
      );
      if (Number(count?.count || 0) <= 1) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: "CORNESTONE must retain at least one active, approved, email-verified administrator." });
      }
    }
    await connection.query("UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ? AND group_id = ?", [role, userId, req.user.groupId]);
    await connection.query(
      `INSERT INTO auth_audit_events (user_id, email, event_type, success, ip_address, user_agent, details_json)
       VALUES (?, ?, 'COMMITTEE_ROLE_CHANGED', 1, ?, ?, ?)`,
      [userId, target.email, getRequestMeta(req).ip, getRequestMeta(req).userAgent,
        JSON.stringify({ changedBy: req.user.id, changedByRole: req.user.role, previousRole: target.role, newRole: role, sessionInvalidated: true })],
    );
    await connection.commit();
    return res.status(200).json({ success: true, message: `${target.full_name}'s role changed from ${target.role} to ${role}. They must sign in again.`, member: { id: userId, fullName: target.full_name, email: target.email, role } });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The committee role change could not be saved." });
  } finally {
    connection.release();
  }
});

// Sign in with email and password. New self-registered accounts must verify email
// and receive committee approval before a session token is issued.
router.post("/login", loginRateLimit, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const email = inputEmail(body);
  const password = body.password;
  if (!isValidEmail(email) || typeof password !== "string" || !password || password.length > 128) {
    return res.status(400).json({ success: false, message: "A valid email address and password are required." });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, group_id, full_name, email, phone_number, password_hash, role,
              COALESCE(is_active, 1) AS is_active, COALESCE(approval_status, 'APPROVED') AS approval_status,
              email_verified_at, COALESCE(token_version, 0) AS token_version
       FROM users WHERE email = ? LIMIT 1`,
      [email],
    );
    const user = rows[0];
    if (!user) {
      await logAuthEvent({ email, eventType: "LOGIN_FAILED", success: false, req, details: { reason: "ACCOUNT_NOT_FOUND" } });
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      await logAuthEvent({ userId: user.id, email, eventType: "LOGIN_FAILED", success: false, req, details: { reason: "INVALID_PASSWORD" } });
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }
    if (Number(user.is_active) !== 1 || String(user.approval_status).toUpperCase() === "SUSPENDED" || String(user.approval_status).toUpperCase() === "REJECTED") {
      await logAuthEvent({ userId: user.id, email, eventType: "LOGIN_BLOCKED_INACTIVE", success: false, req });
      return res.status(403).json({ success: false, message: "This account is inactive or not approved. Contact CORNESTONE Co.LTD. leadership." });
    }
    if (!user.email_verified_at) {
      await logAuthEvent({ userId: user.id, email, eventType: "LOGIN_BLOCKED_UNVERIFIED", success: false, req });
      return res.status(403).json({ success: false, message: "Please verify your email address first. Use Resend verification if you cannot find the email." });
    }
    if (String(user.approval_status).toUpperCase() !== "APPROVED") {
      await logAuthEvent({ userId: user.id, email, eventType: "LOGIN_BLOCKED_UNAPPROVED", success: false, req, details: { status: user.approval_status } });
      return res.status(403).json({ success: false, message: "Your email is verified. Your account is waiting for committee approval." });
    }
    if (!JWT_SECRET) {
      return res.status(503).json({ success: false, message: "Authentication is not configured on this server." });
    }

    const tokenVersion = Number(user.token_version || 0);
    const token = jwt.sign(
      { id: user.id, groupId: user.group_id, role: user.role, email: user.email, tokenVersion },
      JWT_SECRET,
      { expiresIn: "8h", algorithm: "HS256" },
    );
    await db.query("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
    setSessionCookie(res, token, process.env);
    await logAuthEvent({ userId: user.id, email, eventType: "LOGIN_SUCCEEDED", success: true, req });

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role, groupId: user.group_id },
    });
  } catch (error) {
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
  }
});


// Return the current authenticated member so the browser can restore the UI
// without storing the bearer credential in JavaScript-accessible storage.
router.get("/me", verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, full_name, email, role, group_id FROM users WHERE id = ? LIMIT 1",
      [req.user.id],
    );
    if (!rows.length) return res.status(401).json({ success: false, message: "Your session is no longer valid." });
    const current = rows[0];
    return res.status(200).json({
      success: true,
      user: { id: Number(current.id), fullName: current.full_name, email: current.email, role: current.role, groupId: Number(current.group_id) },
    });
  } catch (error) {
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The session could not be checked." });
  }
});

// Revoke the current account's existing sessions and clear its HttpOnly cookie.
router.post("/logout", verifyToken, async (req, res) => {
  try {
    await db.query("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [req.user.id]);
    clearSessionCookie(res, process.env);
    await logAuthEvent({ userId: req.user.id, email: req.user.email, eventType: "LOGOUT_SUCCEEDED", success: true, req });
    return res.status(200).json({ success: true, message: "You have signed out." });
  } catch (error) {
    return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "Sign-out could not be completed." });
  }
});


module.exports = router;
