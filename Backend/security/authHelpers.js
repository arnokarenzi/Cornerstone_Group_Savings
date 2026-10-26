"use strict";
const crypto = require("node:crypto");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}
function isValidPassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
}
function createRawToken() {
  return crypto.randomBytes(32).toString("hex");
}
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
module.exports = { normalizeEmail, isValidEmail, isValidPassword, createRawToken, hashToken };
