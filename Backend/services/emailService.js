"use strict";

function getAppUrl(pathname, token) {
  const base = String(process.env.PUBLIC_APP_URL || "http://localhost:5173").replace(/\/+$/, "");
  const url = new URL(pathname, `${base}/`);
  url.searchParams.set("token", token);
  return url.toString();
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function sendMessage({ to, subject, text, html }) {
  const host = String(process.env.SMTP_HOST || "").trim();
  const from = String(process.env.SMTP_FROM || "CORNESTONE Co.LTD. <no-reply@example.com>").trim();

  // Local development remains usable before SMTP has been configured. These links
  // are only printed in development and must never be logged in production.
  if (!host) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMTP_HOST is not configured; email cannot be delivered in production.");
    }
    console.warn(`[development-email-only] To: ${to}\nSubject: ${subject}\n${text}`);
    return { mode: "console" };
  }

  // Nodemailer is intentionally loaded only when SMTP delivery is configured.
  // This keeps non-email backend tests independent of the email transport.
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    throw new Error("SMTP is configured but nodemailer is not installed. Run npm install in Backend.");
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure && port === 587,
    ...(process.env.SMTP_USER ? {
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || "" },
    } : {}),
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  await transport.sendMail({ from, to, subject, text, html });
  return { mode: "smtp" };
}

async function sendVerificationEmail({ to, fullName, token }) {
  const link = getAppUrl("/verify-email", token);
  const name = String(fullName || "member");
  const text = `Hello ${name},\n\nPlease verify your email address for your CORNESTONE Co.LTD. account by opening this link:\n${link}\n\nThis link expires in 24 hours. After verification, a committee member must approve your account before you can sign in. If you did not request this account, you can ignore this email.\n`;
  const html = `<p>Hello ${escapeHtml(name)},</p><p>Please verify your email address for your CORNESTONE Co.LTD. account.</p><p><a href="${escapeHtml(link)}">Verify email address</a></p><p>This link expires in 24 hours. After verification, a committee member must approve your account before you can sign in.</p><p>If you did not request this account, you can ignore this email.</p>`;
  return sendMessage({ to, subject: "Verify your CORNESTONE account", text, html });
}

async function sendPasswordResetEmail({ to, fullName, token }) {
  const link = getAppUrl("/reset-password", token);
  const name = String(fullName || "member");
  const text = `Hello ${name},\n\nA password reset was requested for your CORNESTONE Co.LTD. account. Set a new password using this link:\n${link}\n\nThis link expires in 30 minutes and can only be used once. If you did not request a reset, you can ignore this email.\n`;
  const html = `<p>Hello ${escapeHtml(name)},</p><p>A password reset was requested for your CORNESTONE Co.LTD. account.</p><p><a href="${escapeHtml(link)}">Choose a new password</a></p><p>This link expires in 30 minutes and can only be used once. If you did not request a reset, you can ignore this email.</p>`;
  return sendMessage({ to, subject: "Reset your CORNESTONE password", text, html });
}

async function sendApprovalEmail({ to, fullName, approved }) {
  const name = String(fullName || "member");
  const subject = approved ? "Your CORNESTONE account is approved" : "Update on your CORNESTONE account request";
  const text = approved
    ? `Hello ${name},\n\nYour CORNESTONE Co.LTD. account has been approved. You can now sign in using your verified email address and the password you created.\n`
    : `Hello ${name},\n\nThe committee has not approved your CORNESTONE Co.LTD. account request. Please contact company leadership if you need clarification.\n`;
  const html = approved
    ? `<p>Hello ${escapeHtml(name)},</p><p>Your CORNESTONE Co.LTD. account has been approved. You can now sign in using your verified email address and the password you created.</p>`
    : `<p>Hello ${escapeHtml(name)},</p><p>The committee has not approved your CORNESTONE Co.LTD. account request. Please contact company leadership if you need clarification.</p>`;
  return sendMessage({ to, subject, text, html });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendApprovalEmail };
