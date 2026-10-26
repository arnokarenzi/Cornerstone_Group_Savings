const test = require("node:test");
const assert = require("node:assert/strict");
const { stable, requestHash } = require("../utils/idempotencyUtils");

test("stable idempotency serialization ignores object key insertion order", () => {
  assert.equal(stable({ b: 2, a: { y: 2, x: 1 } }), stable({ a: { x: 1, y: 2 }, b: 2 }));
});

test("idempotency request hash is stable for the same method, path and body", () => {
  const first = { method: "post", originalUrl: "/api/groups/1/loans", body: { amount: 10000, cycleId: 2 } };
  const retry = { method: "POST", originalUrl: "/api/groups/1/loans", body: { cycleId: 2, amount: 10000 } };
  assert.equal(requestHash(first), requestHash(retry));
});

test("idempotency request hash changes with the target or financial payload", () => {
  const base = { method: "POST", originalUrl: "/api/groups/1/loans", body: { amount: 10000 } };
  assert.notEqual(requestHash(base), requestHash({ ...base, originalUrl: "/api/groups/1/loans/repay" }));
  assert.notEqual(requestHash(base), requestHash({ ...base, body: { amount: 11000 } }));
  assert.match(requestHash(base), /^[a-f0-9]{64}$/);
});
