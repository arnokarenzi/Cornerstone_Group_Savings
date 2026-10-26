"use strict";

const SESSION_COOKIE_NAME = "cornestone_session";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const COOKIE_PATH = "/api";

function sessionCookieOptions(env = process.env) {
  const production = String(env.NODE_ENV || "development").toLowerCase() === "production";
  const rawSameSite = String(env.SESSION_COOKIE_SAME_SITE || "Lax").trim().toLowerCase();
  const sameSiteMap = { lax: "lax", strict: "strict", none: "none" };
  const sameSite = sameSiteMap[rawSameSite];
  if (!sameSite) throw new Error("SESSION_COOKIE_SAME_SITE must be Lax, Strict, or None.");
  const secureEnv = String(env.SESSION_COOKIE_SECURE || "").trim().toLowerCase();
  const secure = secureEnv === "true" || (secureEnv === "" && production);
  if (secureEnv && !["true", "false"].includes(secureEnv)) {
    throw new Error("SESSION_COOKIE_SECURE must be true or false when set.");
  }
  if (production && !secure) throw new Error("SESSION_COOKIE_SECURE must be true in production.");
  if (sameSite === "none" && !secure) throw new Error("SameSite=None cookies require SESSION_COOKIE_SECURE=true.");
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: COOKIE_PATH,
    maxAge: SESSION_MAX_AGE_MS,
  };
}

function clearSessionCookie(res, env = process.env) {
  const { maxAge, ...options } = sessionCookieOptions(env);
  res.clearCookie(SESSION_COOKIE_NAME, options);
}

function setSessionCookie(res, token, env = process.env) {
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(env));
}

function parseCookieHeader(header) {
  if (typeof header !== "string" || !header) return {};
  const result = {};
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!name || Object.prototype.hasOwnProperty.call(result, name)) continue;
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

function getSessionCookieToken(cookieHeader) {
  const token = parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME];
  return typeof token === "string" && token && !/\s/.test(token) ? token : null;
}

function isUnsafeMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "GET").toUpperCase());
}

function isTrustedCookieMutationOrigin(req, allowedOrigins) {
  if (!isUnsafeMethod(req?.method)) return true;
  const origin = req?.headers?.origin;
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  COOKIE_PATH,
  sessionCookieOptions,
  setSessionCookie,
  clearSessionCookie,
  parseCookieHeader,
  getSessionCookieToken,
  isUnsafeMethod,
  isTrustedCookieMutationOrigin,
};
