"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { positiveId, cashAmount, mapPayout, findOtherLiveCycle } = require("../services/cycleLifecycleHelpers");

test("cycle lifecycle accepts only positive safe integer IDs", () => {
  assert.equal(positiveId("12", "Cycle ID"), 12);
  assert.throws(() => positiveId("0", "Cycle ID"), /positive integer/);
  assert.throws(() => positiveId("12x", "Cycle ID"), /positive integer/);
});

test("final cash counts accept zero and round to cents but reject missing or negative values", () => {
  assert.equal(cashAmount("0", "Loan Fund count"), 0);
  assert.equal(cashAmount("105.236", "Loan Fund count"), 105.24);
  assert.throws(() => cashAmount("", "Loan Fund count"), /required/);
  assert.throws(() => cashAmount("-1", "Loan Fund count"), /zero or a positive amount/);
  assert.throws(() => cashAmount("NaN", "Loan Fund count"), /zero or a positive amount/);
});

test("share-out payout mapper preserves the frozen member amount and status", () => {
  const payout = mapPayout({
    id: 4, member_id: 7, full_name: "Member A", phone_number: "0780000000",
    shares_count: 3, savings_amount: "3000.00", profit_amount: "450.50",
    payout_amount: "3450.50", status: "PENDING", paid_at: null, receipt_id: null,
  });
  assert.deepEqual(payout, {
    id: 4, memberId: 7, fullName: "Member A", phoneNumber: "0780000000",
    sharesCount: 3, savingsAmount: 3000, profitAmount: 450.5,
    payoutAmount: 3450.5, status: "PENDING", paidAt: null, receiptId: null,
  });
});


test("cycle transition guard rejects another active or closing cycle in the same group", () => {
  assert.deepEqual(findOtherLiveCycle([{ id: 5, cycle_number: 1, status: "CLOSING" }], 5), null);
  assert.deepEqual(findOtherLiveCycle([{ id: 5, cycle_number: 1, status: "ACTIVE" }, { id: 6, cycle_number: 2, status: "ACTIVE" }], 5), { id: 6, cycle_number: 2, status: "ACTIVE" });
  assert.deepEqual(findOtherLiveCycle([{ id: 8, cycle_number: 3, status: "CLOSING" }], 5), { id: 8, cycle_number: 3, status: "CLOSING" });
});
