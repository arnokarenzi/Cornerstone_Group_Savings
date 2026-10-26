"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateGusibuzaFee,
  isAutomaticAbsenceFineLabel,
  findAutomaticAbsenceFineRule,
  completedInterestPeriods,
  calculatePeriodicInterest,
} = require("../services/gusibuzaHelpers");
const {
  validateMeetingAttendanceForClosure,
  validateMeetingContributions,
  DEFAULT_CONSTITUTION,
  normalizeConstitution,
} = require("../services/constitutionRules");

test("gusibuza fee per share scales with each late share", () => {
  assert.equal(calculateGusibuzaFee({ feeMode: "PER_SHARE", feeAmount: 100, sharesCount: 3 }), 300);
});

test("gusibuza per-meeting fee is charged once for one target meeting", () => {
  assert.equal(calculateGusibuzaFee({ feeMode: "PER_MEETING", feeAmount: 500, sharesCount: 3, alreadyPaidPerMeetingFee: false }), 500);
  assert.equal(calculateGusibuzaFee({ feeMode: "PER_MEETING", feeAmount: 500, sharesCount: 1, alreadyPaidPerMeetingFee: true }), 0);
});

test("automatic absence fine labels are detected case-insensitively and remain constitution rules", () => {
  assert.equal(isAutomaticAbsenceFineLabel("ABSENT WITHOUT EXCUSE"), true);
  assert.equal(isAutomaticAbsenceFineLabel("Absence without excuse"), true);
  assert.equal(isAutomaticAbsenceFineLabel("Late arrival"), false);
  const rule = findAutomaticAbsenceFineRule([{ label: "Late arrival", amount: 100 }, { label: "Absence without excuse", amount: 500 }]);
  assert.deepEqual(rule, { label: "Absence without excuse", amount: 500 });
});

test("interest periods complete only after the approved number of days", () => {
  const issued = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(completedInterestPeriods({ now: issued.getTime() + 29 * 86400000, disbursedAt: issued, periodDays: 30 }), 0);
  assert.equal(completedInterestPeriods({ now: issued.getTime() + 30 * 86400000, disbursedAt: issued, periodDays: 30 }), 1);
  assert.equal(completedInterestPeriods({ now: issued.getTime() + 95 * 86400000, disbursedAt: issued, periodDays: 30 }), 3);
});

test("periodic interest is calculated on remaining principal, not original principal", () => {
  assert.equal(calculatePeriodicInterest(10000, 0.05, 1), 500);
  assert.equal(calculatePeriodicInterest(6000, 0.05, 1), 300);
  assert.equal(calculatePeriodicInterest(6000, 0.05, 2), 600);
  // After a RWF 100 principal reduction, the next period charges 5% of RWF 9,900.
  assert.equal(calculatePeriodicInterest(9900, 0.05, 1), 495);
});

test("virtual-window contributions do not require physical attendance and reject Social Fund", () => {
  const terms = { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, socialFundMode: "FLEXIBLE" };
  assert.doesNotThrow(() => validateMeetingContributions({ terms, sharePurchases: [{ sharesCount: 1 }], attendanceStatus: "ABSENT" }));
  assert.throws(() => validateMeetingContributions({ terms, socialFundTransactions: [{ amount: 100 }] }), /does not collect Social Fund/);
});

test("manual assessment of automatic absence fine is rejected and omitted from manual fine workflow", () => {
  const { resolveFineAssessment } = require("../services/constitutionRules");
  assert.throws(() => resolveFineAssessment({ fineRules: [{ label: "Absence without excuse", amount: 300 }] }, { ruleLabel: "Absence without excuse" }), /assessed automatically/);
});

test("meeting closure requires a status for each member and an excuse reason", () => {
  assert.throws(() => validateMeetingAttendanceForClosure([{ full_name: "Aline", attendance_status: "NOT_RECORDED" }]), /mark each active member/);
  assert.throws(() => validateMeetingAttendanceForClosure([{ full_name: "Aline", attendance_status: "EXCUSED", attendance_notes: "" }]), /record a reason/);
  assert.doesNotThrow(() => validateMeetingAttendanceForClosure([
    { full_name: "Aline", attendance_status: "PRESENT" },
    { full_name: "Bob", attendance_status: "ABSENT" },
    { full_name: "Chris", attendance_status: "EXCUSED", attendance_notes: "Hospital visit" },
  ]));
});

test("late-share fees remain disabled in the online constitution", () => {
  const terms = normalizeConstitution({ ...DEFAULT_CONSTITUTION, gusibuzaEnabled: true, maxSharesPerMeeting: null, gusibuzaFeeAmount: 100 });
  assert.equal(terms.gusibuzaEnabled, false);
  assert.equal(terms.gusibuzaFeeAmount, 0);
});
