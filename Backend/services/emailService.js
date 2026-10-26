"use strict";

const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const EMAIL_API_TIMEOUT_MS = 15000;

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

function selectedEmailProvider(env = process.env) {
  const requested = String(env.EMAIL_PROVIDER || "").trim().toLowerCase();
  if (requested) return requested;
  return String(env.RESEND_API_KEY || "").trim() ? "resend" : "console";
}

function validateEmailFrom(value) {
  const from = String(value || "").trim();
  const angleAddress = from.match(/<\s*([^<>]+)\s*>/);
  const address = (angleAddress ? angleAddress[1] : from).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
    throw new Error("EMAIL_FROM must contain a valid sender email address.");
  }
  if (/example\.com|\.example(?:$|\s)/i.test(address)) {
    throw new Error("EMAIL_FROM must use a real sender domain, not an example domain.");
  }
  return from;
}

function assertEmailProviderConfiguration(env = process.env, options = {}) {
  const production = options.production ?? String(env.NODE_ENV || "").toLowerCase() === "production";
  const provider = selectedEmailProvider(env);
  if (production && provider !== "resend") {
    throw new Error("EMAIL_PROVIDER must be set to 'resend' in production; console email delivery is development-only.");
  }
  if (provider === "console") {
    if (production) throw new Error("Console email delivery is not permitted in production.");
    return { provider: "console", from: null };
  }
  if (provider !== "resend") {
    throw new Error("Unsupported EMAIL_PROVIDER. Use 'resend' for hosted delivery or 'console' for local development.");
  }
  if (!String(env.RESEND_API_KEY || "").trim()) {
    throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend.");
  }
  const from = validateEmailFrom(env.EMAIL_FROM);
  const angleAddress = from.match(/<\s*([^<>]+)\s*>/);
  const senderAddress = (angleAddress ? angleAddress[1] : from).trim();
  if (production && /@resend\.dev$/i.test(senderAddress)) {
    throw new Error("Production EMAIL_FROM must use your own verified sender domain, not the Resend testing sender.");
  }
  return { provider, from };
}

async function sendMessage({ to, subject, text, html }) {
  const config = assertEmailProviderConfiguration(process.env);

  // Keep local development usable without a provider account. Action links are
  // logged only in development; production config validation rejects console mode.
  if (config.provider === "console") {
    console.warn(`[development-email-only] To: ${to}\nSubject: ${subject}\n${text}`);
    return { mode: "console" };
  }

  if (typeof fetch !== "function") {
    const error = new Error("Node.js fetch is unavailable. Run this backend with Node.js 20 or newer.");
    error.code = "EMAIL_FETCH_UNAVAILABLE";
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_API_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(RESEND_EMAILS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(process.env.RESEND_API_KEY).trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [to],
        subject,
        text,
        html,
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    const error = new Error(cause?.name === "AbortError"
      ? "Transactional email API request timed out."
      : "Could not reach the transactional email API over HTTPS.");
    error.code = cause?.name === "AbortError" ? "EMAIL_API_TIMEOUT" : (cause?.code || "EMAIL_API_NETWORK_ERROR");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  let result = {};
  try {
    const payload = await response.json();
    if (payload && typeof payload === "object") result = payload;
  } catch {
    // A non-JSON provider response is handled using status alone below.
  }

  if (!response.ok) {
    const rawCode = String(result.name || result.code || "EMAIL_API_ERROR");
    const safeCode = /^[a-zA-Z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : "EMAIL_API_ERROR";
    const error = new Error(`Transactional email API returned HTTP ${response.status} (${safeCode}). Check the Resend API key, sender-domain verification, and provider limits.`);
    error.code = `RESEND_HTTP_${response.status}`;
    throw error;
  }

  return { mode: "resend", messageId: typeof result.id === "string" ? result.id : undefined };
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

async function sendTestEmail({ to }) {
  const recipient = String(to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || recipient.length > 254) {
    throw new Error("Provide a valid recipient email address for the test message.");
  }
  const text = "This is a test message from the CORNESTONE Co.LTD. transactional-email API configuration. No financial action has been taken.";
  const html = "<p>This is a test message from the CORNESTONE Co.LTD. transactional-email API configuration.</p><p>No financial action has been taken.</p>";
  return sendMessage({ to: recipient, subject: "CORNESTONE email delivery test", text, html });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendApprovalEmail,
  sendTestEmail,
  assertEmailProviderConfiguration,
  selectedEmailProvider,
};
