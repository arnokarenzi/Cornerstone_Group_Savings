"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REQUIRED_SHARE_OUT_FORMULA,
  shareOutRatificationBlocker,
  assertShareOutRatified,
  isEligibleConstitutionVoter,
} = require("../services/shareOutApprovalPolicy");

test("share-out cannot proceed when constitution is missing or still interim", () => {
  assert.match(shareOutRatificationBlocker(null), /member vote/i);
  assert.match(shareOutRatificationBlocker({ status: "CURRENT", approval_method: "LEGACY_IMPORTED", constitution_json: JSON.stringify({ shareOutFormula: REQUIRED_SHARE_OUT_FORMULA }) }), /interim legacy/i);
});

test("share-out requires a current member-voted constitution with the exact formula", () => {
  assert.match(shareOutRatificationBlocker({ status: "CURRENT", approval_method: "MEMBER_VOTE", constitution_json: JSON.stringify({ shareOutFormula: "OTHER" }) }), /does not record the required/i);
  const row = { status: "CURRENT", approval_method: "MEMBER_VOTE", constitution_json: JSON.stringify({ shareOutFormula: REQUIRED_SHARE_OUT_FORMULA }) };
  assert.equal(shareOutRatificationBlocker(row), null);
  assert.equal(assertShareOutRatified(row), true);
});

test("share-out ratification assertion returns a conflict error for an unapproved policy", () => {
  assert.throws(() => assertShareOutRatified({ status: "CURRENT", approval_method: "LEGACY_IMPORTED", constitution_json: "{}" }), (error) => error.statusCode === 409 && error.code === "SHARE_OUT_POLICY_NOT_RATIFIED");
});

test("only active, approved, email-verified users qualify to vote", () => {
  assert.equal(isEligibleConstitutionVoter({ is_active: 1, approval_status: "APPROVED", email_verified_at: "2026-10-25 10:00:00" }), true);
  assert.equal(isEligibleConstitutionVoter({ is_active: 1, approval_status: "PENDING", email_verified_at: "2026-10-25 10:00:00" }), false);
  assert.equal(isEligibleConstitutionVoter({ is_active: 1, approval_status: "APPROVED", email_verified_at: null }), false);
  assert.equal(isEligibleConstitutionVoter({ is_active: 0, approval_status: "APPROVED", email_verified_at: "2026-10-25 10:00:00" }), false);
});
