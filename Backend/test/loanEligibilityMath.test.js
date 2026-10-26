"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateBorrowingCapacity } = require("../services/loanEligibilityMath");

test("borrowing capacity subtracts outstanding principal and other pending/approved applications", () => {
  assert.deepEqual(calculateBorrowingCapacity({ eligibleSavings: 100000, loanRatioLimit: 2, outstandingPrincipal: 50000, reservedApplications: 20000 }), { grossBorrowingLimit: 200000, availableBorrowing: 130000 });
});

test("borrowing capacity never becomes negative", () => {
  assert.deepEqual(calculateBorrowingCapacity({ eligibleSavings: 1000, loanRatioLimit: 2, outstandingPrincipal: 1500, reservedApplications: 800 }), { grossBorrowingLimit: 2000, availableBorrowing: 0 });
});

test("borrowing capacity rejects invalid amounts and ratios", () => {
  assert.throws(() => calculateBorrowingCapacity({ eligibleSavings: -1, loanRatioLimit: 2 }), /non-negative/);
  assert.throws(() => calculateBorrowingCapacity({ eligibleSavings: 100, loanRatioLimit: 0 }), /borrowing ratio/);
  assert.throws(() => calculateBorrowingCapacity({ eligibleSavings: 100, loanRatioLimit: 2, outstandingPrincipal: Infinity }), /non-negative/);
});
