const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  sessionCookieOptions,
  parseCookieHeader,
  getSessionCookieToken,
  isUnsafeMethod,
  isTrustedCookieMutationOrigin,
} = require("../security/sessionCookies");

test("session cookies are HttpOnly, scoped to the API, and expire with an eight-hour session", () => {
  const options = sessionCookieOptions({ NODE_ENV: "development" });
  assert.equal(options.httpOnly, true);
  assert.equal(options.path, "/api");
  assert.equal(options.secure, false);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.maxAge, SESSION_MAX_AGE_MS);
  assert.equal(SESSION_COOKIE_NAME, "cornestone_session");
});

test("production session cookie requires Secure and supports configured SameSite", () => {
  const options = sessionCookieOptions({ NODE_ENV: "production" });
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(sessionCookieOptions({ NODE_ENV: "production", SESSION_COOKIE_SAME_SITE: "Strict" }).sameSite, "strict");
  assert.throws(() => sessionCookieOptions({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "false" }), /must be true in production/);
  assert.throws(() => sessionCookieOptions({ NODE_ENV: "development", SESSION_COOKIE_SAME_SITE: "none" }), /require SESSION_COOKIE_SECURE=true/);
});

test("cookie parser returns the session credential without throwing on malformed values", () => {
  assert.deepEqual(parseCookieHeader("one=1; cornestone_session=abc.def.ghi; two=a%20b"), {
    one: "1", cornestone_session: "abc.def.ghi", two: "a b",
  });
  assert.equal(getSessionCookieToken("other=value; cornestone_session=abc.def.ghi"), "abc.def.ghi");
  assert.equal(getSessionCookieToken("cornestone_session=bad%ZZ"), "bad%ZZ");
  assert.equal(getSessionCookieToken("other=value"), null);
});

test("cookie-authenticated mutations require an exact trusted browser origin", () => {
  const allowed = ["http://localhost:5173", "https://members.cornestone.rw"];
  assert.equal(isUnsafeMethod("POST"), true);
  assert.equal(isUnsafeMethod("GET"), false);
  assert.equal(isTrustedCookieMutationOrigin({ method: "GET", headers: {} }, allowed), true);
  assert.equal(isTrustedCookieMutationOrigin({ method: "POST", headers: { origin: "http://localhost:5173" } }, allowed), true);
  assert.equal(isTrustedCookieMutationOrigin({ method: "POST", headers: { origin: "https://evil.example" } }, allowed), false);
  assert.equal(isTrustedCookieMutationOrigin({ method: "POST", headers: {} }, allowed), false);
});
