"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  periodicChargesDue,
  calculateInterestOnRemainingPrincipal,
  calculatePeriodicServiceChargeAccrual,
  allocateRepayment,
} = require("../services/loanCalculations");

test("the first configured service charge is due at disbursement; further charges follow the configured day period", () => {
  const disbursedAt = "2026-01-01T00:00:00.000Z";
  const day0 = new Date("2026-01-01T00:00:00.000Z").getTime();
  const day4 = new Date("2026-01-05T00:00:00.000Z").getTime();
  const day28 = new Date("2026-01-29T00:00:00.000Z").getTime();
  const day29 = new Date("2026-01-30T00:00:00.000Z").getTime();
  const day56 = new Date("2026-02-26T00:00:00.000Z").getTime();
  assert.equal(periodicChargesDue({ now: day0, disbursedAt, periodDays: 28 }), 1);
  assert.equal(periodicChargesDue({ now: day4, disbursedAt, periodDays: 28 }), 1);
  assert.equal(periodicChargesDue({ now: day28, disbursedAt, periodDays: 28 }), 2);
  assert.equal(periodicChargesDue({ now: day29, disbursedAt, periodDays: 28 }), 2);
  assert.equal(periodicChargesDue({ now: day56, disbursedAt, periodDays: 28 }), 3);
});

test("service-charge schedule follows a different configured constitutional period", () => {
  const disbursedAt = "2026-01-01T00:00:00.000Z";
  const day34 = new Date("2026-02-04T00:00:00.000Z").getTime();
  const day35 = new Date("2026-02-05T00:00:00.000Z").getTime();
  const day70 = new Date("2026-03-12T00:00:00.000Z").getTime();
  assert.equal(periodicChargesDue({ now: day34, disbursedAt, periodDays: 35 }), 1);
  assert.equal(periodicChargesDue({ now: day35, disbursedAt, periodDays: 35 }), 2);
  assert.equal(periodicChargesDue({ now: day70, disbursedAt, periodDays: 35 }), 3);
});

test("charges each completed period using principal outstanding at that period end", () => {
  const disbursedAt = "2026-01-01T00:00:00.000Z";
  const day29 = new Date("2026-01-29T00:00:00.000Z").getTime();
  const repaymentAfterFirstPeriod = [{ principal_amount: 4000, created_at: "2026-01-05T00:00:00.000Z" }];
  const secondPeriod = calculatePeriodicServiceChargeAccrual({
    principalAmount: 10000, interestRate: 0.10, periodDays: 28, disbursedAt,
    now: day29, repayments: repaymentAfterFirstPeriod, alreadyChargedPeriods: 1,
  });
  assert.deepEqual(secondPeriod, { targetPeriods: 2, addedCharge: 600 });
});

test("periodic interest is reduced after a partial payment reduces remaining principal", () => {
  assert.equal(calculateInterestOnRemainingPrincipal(10000, 0.05, 1), 500);
  assert.equal(calculateInterestOnRemainingPrincipal(9000, 0.05, 1), 450);
  assert.equal(calculateInterestOnRemainingPrincipal(9000, 0.05, 2), 900);
});

test("repayment allocation applies received cash to interest and then remaining principal", () => {
  assert.deepEqual(allocateRepayment({ payment: 1000, principalRemaining: 9500, interestRemaining: 500 }), {
    interestPaid: 500, principalPaid: 500, balanceRemaining: 9000,
  });
});

test("repayment allocation never splits more principal than outstanding and gives a clear overpayment error", () => {
  assert.deepEqual(allocateRepayment({ payment: 250, principalRemaining: 100, interestRemaining: 300 }), {
    interestPaid: 250, principalPaid: 0, balanceRemaining: 150,
  });
  assert.throws(() => allocateRepayment({ payment: 501, principalRemaining: 100, interestRemaining: 400 }), /total outstanding loan balance/);
});

test("a 10,000 RWF loan carries a full 1,000 RWF initial charge even if repaid after four days", () => {
  const initialCharge = calculateInterestOnRemainingPrincipal(10000, 0.10, 1);
  assert.equal(initialCharge, 1000);
  assert.equal(roundTotal(10000, initialCharge), 11000);
});

function roundTotal(principal, interest) { return Math.round((principal + interest + Number.EPSILON) * 100) / 100; }
