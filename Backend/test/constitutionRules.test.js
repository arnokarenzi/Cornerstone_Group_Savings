const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_CONSTITUTION, normalizeConstitution, majorityThreshold, evaluateVoteOutcome,
  getInitialConstitutionFromSettings, calculateInterestAmount, validateMeetingContributions,
  validateFixedSocialFundMeetingClosure,
} = require("../services/constitutionRules");

test("CORNESTONE initial constitution uses the approved online defaults", () => {
  const terms = normalizeConstitution({});
  assert.equal(terms.shareValue, 1000);
  assert.equal(terms.minSharesPerMeeting, 0);
  assert.equal(terms.maxSharesPerMeeting, 30);
  assert.equal(terms.loanRatioLimit, 2);
  assert.equal(terms.interestRate, 0.10);
  assert.equal(terms.interestPeriodDays, 28);
  assert.equal(terms.meetingFrequency, "FORTNIGHTLY");
  assert.equal(terms.meetingIntervalDays, 14);
  assert.equal(terms.virtualMeetingWindowDays, 3);
  assert.equal(terms.cycleDurationMonths, 12);
  assert.equal(terms.paymentWindowTimeZone, "Africa/Kigali");
  assert.equal(terms.socialFundMode, "NONE");
  assert.equal(terms.socialFundContributionAmount, 0);
  assert.equal(terms.gusibuzaEnabled, false);
  assert.equal(terms.gusibuzaFeeAmount, 0);
  assert.match(terms.withdrawalPolicy, /committee decision/i);
  assert.match(terms.defaultPolicy, /grace period/i);
});

test("constitution permits zero shares and applies max 30 unless explicitly changed", () => {
  const terms = normalizeConstitution({ minSharesPerMeeting: 0, maxSharesPerMeeting: 30 });
  assert.equal(terms.minSharesPerMeeting, 0);
  assert.equal(terms.maxSharesPerMeeting, 30);
  assert.throws(() => normalizeConstitution({ minSharesPerMeeting: -1 }), /Minimum shares/);
  assert.throws(() => normalizeConstitution({ minSharesPerMeeting: 3, maxSharesPerMeeting: 2 }), /cannot be less than the minimum/);
});

test("legacy browser payloads cannot enable Social Fund or late-share fees", () => {
  const terms = normalizeConstitution({ ...DEFAULT_CONSTITUTION, socialFundMode: "FIXED", socialFundContributionAmount: 100, gusibuzaEnabled: true, gusibuzaFeeAmount: 500 });
  assert.equal(terms.socialFundMode, "NONE");
  assert.equal(terms.socialFundContributionAmount, 0);
  assert.equal(terms.gusibuzaEnabled, false);
  assert.equal(terms.gusibuzaFeeAmount, 0);
  assert.deepEqual(validateFixedSocialFundMeetingClosure({ socialFundMode: "FIXED", socialFundContributionAmount: 100 }, []), { enforced: false, presentMembers: 0 });
});

test("initial constitution defaults keep the loan term separate from the service-charge period", () => {
  const terms = getInitialConstitutionFromSettings(JSON.stringify({ shareValue: 2000, loanRatioLimit: 2, monthlyInterestRate: 0.04, maxLoanDurationMonths: 6 }));
  assert.equal(terms.shareValue, 2000);
  assert.equal(terms.loanRatioLimit, 2);
  assert.equal(terms.monthlyInterestRate, 0.04);
  assert.equal(terms.maxLoanDurationMonths, 6);
  assert.equal(terms.maxLoanTermDays, 180);
  assert.equal(terms.interestPeriodDays, 28);
});

test("fine rules require unique labels and positive values", () => {
  assert.throws(() => normalizeConstitution({ fineRules: [{ label: "Late", amount: 500 }, { label: "late", amount: 1000 }] }), /duplicated/);
  assert.throws(() => normalizeConstitution({ fineRules: [{ label: "Absence", amount: 0 }] }), /must be a valid/);
});

test("member voting requires an absolute majority of active users", () => {
  assert.equal(majorityThreshold(4), 3);
  assert.equal(majorityThreshold(5), 3);
  assert.equal(evaluateVoteOutcome({ activeMembers: 5, approvals: 3, rejections: 1, totalVotes: 4 }), "CURRENT");
  assert.equal(evaluateVoteOutcome({ activeMembers: 5, approvals: 1, rejections: 3, totalVotes: 4 }), "REJECTED");
  assert.equal(evaluateVoteOutcome({ activeMembers: 4, approvals: 2, rejections: 2, totalVotes: 4 }), "DEADLOCKED");
});

test("interest calculation uses the approved method and rounds to cents", () => {
  assert.equal(calculateInterestAmount(10000, 0.10, 1, "FLAT_PER_PERIOD"), 1000);
  assert.equal(calculateInterestAmount(10000, 0.05, 3, "FLAT_ONCE"), 500);
  assert.throws(() => calculateInterestAmount(10000, 0.05, 3, "UNKNOWN"), /invalid loan terms/);
});

test("virtual-window share limits count the member's total shares within that window", () => {
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 2 }, sharePurchases: [{ sharesCount: 1 }] }), /at least 2 share/);
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, maxSharesPerMeeting: 3 }, existingSharesThisMeeting: 2, sharePurchases: [{ sharesCount: 2 }] }), /exceed CORNESTONE's limit/);
  assert.equal(validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, maxSharesPerMeeting: 30 }, existingSharesThisMeeting: 1, sharePurchases: [{ sharesCount: 2 }] }).totalSharesThisMeeting, 3);
});

test("online contributions do not require a physical attendance record", () => {
  assert.equal(validateMeetingContributions({ terms: DEFAULT_CONSTITUTION, sharePurchases: [{ sharesCount: 1 }] }).requestedShares, 1);
  assert.equal(validateMeetingContributions({ terms: DEFAULT_CONSTITUTION, attendanceStatus: "ABSENT", sharePurchases: [{ sharesCount: 1 }] }).requestedShares, 1);
});

test("Social Fund contributions are rejected even when legacy settings request them", () => {
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, socialFundMode: "FIXED" }, socialFundTransactions: [{ amount: 100 }] }), /does not collect Social Fund/);
  assert.throws(() => validateMeetingContributions({ terms: DEFAULT_CONSTITUTION, existingSocialFundAmount: 1 }), /does not collect Social Fund/);
});

test("fine assessment uses approved amounts and only allows custom amount for Other", () => {
  const { resolveFineAssessment } = require("../services/constitutionRules");
  const settings = { fineRules: [{ label: "Late arrival", amount: 500 }], allowOtherFines: true };
  assert.deepEqual(resolveFineAssessment(settings, { ruleLabel: "Late arrival", otherAmount: 9999 }), { fineLabel: "Late arrival", reason: "Late arrival", amount: 500 });
  assert.deepEqual(resolveFineAssessment(settings, { ruleLabel: "OTHER", otherReason: "Damaged group property", otherAmount: 750 }), { fineLabel: "Other", reason: "Damaged group property", amount: 750 });
  assert.throws(() => resolveFineAssessment({ ...settings, allowOtherFines: false }, { ruleLabel: "OTHER", otherReason: "Damaged property", otherAmount: 750 }), /does not allow/);
  assert.throws(() => resolveFineAssessment(settings, { ruleLabel: "Unknown" }), /not in the current approved constitution/);
});
