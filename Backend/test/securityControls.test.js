const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_DEVELOPMENT_JWT_SECRET,
  parseAllowedOrigins,
  validateProductionConfig,
  isAllowedOrigin,
  extractBearerToken,
  isLegacyBearerAllowed,
  FixedWindowLimiter,
} = require("../security/securityControls");
const { isInfrastructureError, sendRouteError } = require("../utils/routeErrors");

test("development CORS defaults are limited to local Vite origins", () => {
  const origins = parseAllowedOrigins({ NODE_ENV: "development" });
  assert.deepEqual(origins, [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:4173", "http://127.0.0.1:4173",
  ]);
  assert.equal(isAllowedOrigin("http://localhost:5173", origins), true);
  assert.equal(isAllowedOrigin("https://unknown.example", origins), false);
  assert.equal(isAllowedOrigin(undefined, origins), true);
});

test("production configuration rejects weak JWT secret, missing DB values, and missing CORS origins", () => {
  const problems = validateProductionConfig({ NODE_ENV: "production", JWT_SECRET: DEFAULT_DEVELOPMENT_JWT_SECRET });
  assert.ok(problems.some((problem) => problem.includes("JWT_SECRET")));
  assert.ok(problems.some((problem) => problem.includes("FRONTEND_ORIGINS")));
  assert.ok(problems.some((problem) => problem.includes("DB_HOST")));
  assert.ok(problems.some((problem) => problem.includes("DB_PASSWORD")));
});

test("production configuration rejects the example placeholder secret", () => {
  const problems = validateProductionConfig({
    NODE_ENV: "production",
    JWT_SECRET: "replace-this-with-a-random-secret-at-least-32-characters",
    FRONTEND_ORIGINS: "https://app.cornestone.example",
    DB_HOST: "db.example", DB_USER: "cornestone_app", DB_NAME: "cornestone_online_db", DB_PASSWORD: "strong-db-password",
  });
  assert.ok(problems.some((problem) => problem.includes("non-placeholder")));
});

test("production configuration accepts explicit long secrets, database credentials and frontend origins", () => {
  const problems = validateProductionConfig({
    NODE_ENV: "production",
    JWT_SECRET: "a-unique-production-secret-with-at-least-32-characters",
    FRONTEND_ORIGINS: "https://app.cornestone.com,https://www.cornestone.com",
    DB_HOST: "db.example", DB_USER: "cornestone_app", DB_NAME: "cornestone_online_db", DB_PASSWORD: "strong-db-password", DB_SSL_ENABLED: "true",
    TRUST_PROXY_HOPS: "1",
    EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_api_key",
    EMAIL_FROM: "CORNESTONE <no-reply@cornestone.com>", PUBLIC_APP_URL: "https://app.cornestone.com",
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(parseAllowedOrigins({ NODE_ENV: "production", FRONTEND_ORIGINS: "https://app.cornestone.com,https://www.cornestone.com" }), [
    "https://app.cornestone.com", "https://www.cornestone.com",
  ]);
});

test("production configuration requires database TLS", () => {
  const problems = validateProductionConfig({
    NODE_ENV: "production",
    JWT_SECRET: "unique-production-secret-long-enough-for-this-check-2026",
    FRONTEND_ORIGINS: "https://members.cornestone.rw",
    DB_HOST: "db.cornestone.rw", DB_USER: "cornestone_app", DB_NAME: "cornestone_online_db", DB_PASSWORD: "safe-password",
    TRUST_PROXY_HOPS: "1",
    EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_api_key",
    EMAIL_FROM: "CORNESTONE <no-reply@cornestone.rw>", PUBLIC_APP_URL: "https://members.cornestone.rw",
  });
  assert.ok(problems.some((problem) => problem.includes("DB_SSL_ENABLED")));
});

test("production configuration requires Resend HTTPS delivery and an HTTPS frontend URL", () => {
  const problems = validateProductionConfig({
    NODE_ENV: "production",
    JWT_SECRET: "unique-production-secret-long-enough-for-this-check-2026",
    FRONTEND_ORIGINS: "https://members.cornestone.rw",
    DB_HOST: "db.cornestone.rw", DB_USER: "cornestone_app", DB_NAME: "cornestone_online_db", DB_PASSWORD: "safe-password", TRUST_PROXY_HOPS: "1",
  });
  assert.ok(problems.some((problem) => problem.includes("EMAIL_PROVIDER")));
  assert.ok(problems.some((problem) => problem.includes("RESEND_API_KEY")));
  assert.ok(problems.some((problem) => problem.includes("EMAIL_FROM")));
  assert.ok(problems.some((problem) => problem.includes("PUBLIC_APP_URL")));
});

test("production CORS origin configuration rejects paths and non-HTTP origins", () => {
  assert.throws(() => parseAllowedOrigins({ NODE_ENV: "production", FRONTEND_ORIGINS: "https://example.com/app" }), /origin only/);
  assert.throws(() => parseAllowedOrigins({ NODE_ENV: "production", FRONTEND_ORIGINS: "file:///tmp" }), /origin only/);
});

test("fixed-window limiter allows max requests then blocks until window reset", () => {
  const limiter = new FixedWindowLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter.consume("ip-a", 100).allowed, true);
  assert.equal(limiter.consume("ip-a", 200).allowed, true);
  const blocked = limiter.consume("ip-a", 300);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.consume("ip-a", 1100).allowed, true);
});

test("fixed-window limiter keeps separate client counters", () => {
  const limiter = new FixedWindowLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.consume("ip-a", 1).allowed, true);
  assert.equal(limiter.consume("ip-b", 2).allowed, true);
  assert.equal(limiter.consume("ip-a", 3).allowed, false);
});

test("database errors are classified as infrastructure errors", () => {
  assert.equal(isInfrastructureError({ code: "ER_BAD_FIELD_ERROR", message: "Unknown column" }), true);
  assert.equal(isInfrastructureError({ code: "ECONNREFUSED" }), true);
  assert.equal(isInfrastructureError(new Error("A user input validation failed")), false);
});

test("database errors return a generic HTTP message without SQL details", () => {
  let responseStatus;
  let responseBody;
  const response = {
    status(value) { responseStatus = value; return this; },
    json(value) { responseBody = value; return this; },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    sendRouteError(response, { code: "ER_BAD_FIELD_ERROR", message: "Unknown column secret_value in SQL" }, { fallbackStatus: 400 });
  } finally {
    console.error = originalError;
  }
  assert.equal(responseStatus, 500);
  assert.doesNotMatch(responseBody.message, /secret_value|SQL|Unknown column/);
});

test("ordinary validation messages remain actionable", () => {
  let responseStatus;
  let responseBody;
  const response = {
    status(value) { responseStatus = value; return this; },
    json(value) { responseBody = value; return this; },
  };
  sendRouteError(response, new Error("Meeting ID must be a positive integer."), { fallbackStatus: 400 });
  assert.equal(responseStatus, 400);
  assert.equal(responseBody.message, "Meeting ID must be a positive integer.");
});


test("bearer token parser accepts a single Bearer credential and rejects malformed headers", () => {
  assert.equal(extractBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(extractBearerToken("bearer token"), "token");
  assert.equal(extractBearerToken("Basic token"), null);
  assert.equal(extractBearerToken("Bearer token extra"), null);
  assert.equal(extractBearerToken(undefined), null);
});


test("fixed-window limiter bounds memory under many distinct client keys", () => {
  const limiter = new FixedWindowLimiter({ windowMs: 60_000, max: 10 });
  for (let index = 0; index < 10_050; index += 1) limiter.consume(`client-${index}`, 1);
  assert.ok(limiter.windows.size <= 10_000);
});


test("production config rejects root database access and an unspecified proxy topology", () => {
  const problems = validateProductionConfig({
    NODE_ENV: "production",
    JWT_SECRET: "unique-production-secret-long-enough-for-this-check-2026",
    FRONTEND_ORIGINS: "https://members.cornestone.rw",
    DB_HOST: "db.cornestone.rw", DB_USER: "root", DB_NAME: "cornestone_online_db", DB_PASSWORD: "strong-password",
    EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_api_key",
    EMAIL_FROM: "CORNESTONE <no-reply@cornestone.rw>", PUBLIC_APP_URL: "https://members.cornestone.rw",
  });
  assert.ok(problems.some((problem) => problem.includes("not root")));
  assert.ok(problems.some((problem) => problem.includes("TRUST_PROXY_HOPS")));
});

test("legacy bearer authentication is allowed only outside production", () => {
  assert.equal(isLegacyBearerAllowed({ NODE_ENV: "development" }), true);
  assert.equal(isLegacyBearerAllowed({ NODE_ENV: "test" }), true);
  assert.equal(isLegacyBearerAllowed({ NODE_ENV: "production" }), false);
});
