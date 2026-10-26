const test = require("node:test");
const assert = require("node:assert/strict");
const { assertConstitutionSettingsMatch } = require("../services/constitutionSettingsValidation");

test("approved custom loan-term and service-charge settings are accepted by deployment validation", () => {
  const terms = {
    shareValue: 1500, minSharesPerMeeting: 0, maxSharesPerMeeting: 25, loanRatioLimit: 1.5,
    interestRate: 0.075, monthlyInterestRate: 0.075, interestPeriodDays: 35, maxLoanTermDays: 210,
    interestMethod: "FLAT_PER_PERIOD", meetingFrequency: "CUSTOM", meetingIntervalDays: 20,
    virtualMeetingWindowDays: 4, cycleDurationMonths: 10, socialFundMode: "NONE", socialFundContributionAmount: 0,
    shareOutFormula: "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES",
  };
  const settings = { ...terms };
  assert.doesNotThrow(() => assertConstitutionSettingsMatch(settings, terms));
});

test("deployment validation rejects settings that drift from the approved constitution", () => {
  const terms = {
    shareValue: 1000, minSharesPerMeeting: 0, maxSharesPerMeeting: 30, loanRatioLimit: 2,
    interestRate: 0.10, monthlyInterestRate: 0.10, interestPeriodDays: 28, maxLoanTermDays: 180,
    interestMethod: "FLAT_PER_PERIOD", meetingFrequency: "FORTNIGHTLY", meetingIntervalDays: 14,
    virtualMeetingWindowDays: 3, cycleDurationMonths: 12, socialFundMode: "NONE", socialFundContributionAmount: 0,
  };
  assert.throws(() => assertConstitutionSettingsMatch({ ...terms, interestPeriodDays: 30 }, terms), /do not match.*service-charge period/i);
  assert.throws(() => assertConstitutionSettingsMatch({ ...terms, socialFundMode: "FIXED" }, terms), /Social Fund/);
});
