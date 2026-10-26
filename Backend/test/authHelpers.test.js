const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeEmail, isValidEmail, isValidPassword, createRawToken, hashToken } = require("../security/authHelpers");

test("email normalization trims whitespace and lowercases addresses", () => {
  assert.equal(normalizeEmail("  Member@Example.COM "), "member@example.com");
  assert.equal(normalizeEmail(null), "");
});

test("email validation rejects malformed or oversized values", () => {
  assert.equal(isValidEmail("member@example.com"), true);
  assert.equal(isValidEmail("member@example"), false);
  assert.equal(isValidEmail("x".repeat(250) + "@example.com"), false);
});

test("password validation enforces a useful minimum and a maximum", () => {
  assert.equal(isValidPassword("correct horse battery"), true);
  assert.equal(isValidPassword("short"), false);
  assert.equal(isValidPassword("x".repeat(129)), false);
});

test("tokens are cryptographically random, long, and stored as one-way hashes", () => {
  const first = createRawToken();
  const second = createRawToken();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.match(hashToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(hashToken(first), first);
  assert.equal(hashToken(first), hashToken(first));
});
