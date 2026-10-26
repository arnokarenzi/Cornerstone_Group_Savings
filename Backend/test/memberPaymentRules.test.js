"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePaymentPurpose } = require("../services/memberPaymentRules");

test("share payment accepts no loan or fine reference", () => {
  assert.equal(validatePaymentPurpose("SHARE_PURCHASE", null, null), "SHARE_PURCHASE");
});

test("loan repayment requires a loan and rejects a fine reference", () => {
  assert.equal(validatePaymentPurpose("LOAN_REPAYMENT", 23, null), "LOAN_REPAYMENT");
  assert.throws(() => validatePaymentPurpose("LOAN_REPAYMENT", null, null), /Select a loan only/);
  assert.throws(() => validatePaymentPurpose("LOAN_REPAYMENT", 23, 9), /Select a loan only/);
});

test("fine payment requires a fine assessment and rejects a loan reference", () => {
  assert.equal(validatePaymentPurpose("FINE_PAYMENT", null, 19), "FINE_PAYMENT");
  assert.throws(() => validatePaymentPurpose("FINE_PAYMENT", null, null), /Select a loan only/);
  assert.throws(() => validatePaymentPurpose("FINE_PAYMENT", 23, 19), /Select a loan only/);
});

test("unsupported or blank payment purposes are rejected", () => {
  assert.throws(() => validatePaymentPurpose("SOCIAL_FUND", null, null), /Choose a share contribution/);
  assert.throws(() => validatePaymentPurpose("", null, null), /Choose a share contribution/);
});
