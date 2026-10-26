const test = require("node:test");
const assert = require("node:assert/strict");
const { allocateCentsByShares } = require("../services/payoutAllocator");

test("allocates the exact cash total in cents without losing rounding remainder", () => {
  const members = [
    { memberId: 1, totalShares: 1 },
    { memberId: 2, totalShares: 1 },
    { memberId: 3, totalShares: 1 },
  ];
  const result = allocateCentsByShares(members, 3, 1000);
  assert.equal(result.get(1), 333.34);
  assert.equal(result.get(2), 333.33);
  assert.equal(result.get(3), 333.33);
  assert.equal([...result.values()].reduce((total, amount) => total + amount, 0), 1000);
});

test("allocates payouts proportionally and gives zero-share members nothing", () => {
  const members = [
    { memberId: 1, totalShares: 4 },
    { memberId: 2, totalShares: 1 },
    { memberId: 3, totalShares: 0 },
  ];
  const result = allocateCentsByShares(members, 5, 1000);
  assert.equal(result.get(1) + result.get(2) + result.get(3), 1000);
  assert.equal(result.get(1), 800);
  assert.equal(result.get(2), 200);
  assert.equal(result.get(3), 0);
});

test("does not allocate cash when there are no recorded shares", () => {
  const members = [{ memberId: 1, totalShares: 0 }];
  const result = allocateCentsByShares(members, 0, 1000);
  assert.equal(result.get(1), 0);
});
