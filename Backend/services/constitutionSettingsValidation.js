"use strict";

function finite(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)); }
function numeric(value, label, { min = 0, exclusiveMin = false, max = Infinity, integer = false } = {}) {
  if (!finite(value)) throw new Error(`${label} is missing or not numeric.`);
  const number = Number(value);
  if ((exclusiveMin ? number <= min : number < min) || number > max || (integer && !Number.isSafeInteger(number))) throw new Error(`${label} must be ${exclusiveMin ? `greater than ${min}` : `at least ${min}`}${Number.isFinite(max) ? ` and no more than ${max}` : ""}${integer ? " whole days/months/shares" : ""}.`);
  return number;
}
function equalNumber(a, b) { return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.0000001; }
function assertConstitutionSettingsMatch(settings = {}, terms = {}) {
  const rate = numeric(terms.interestRate ?? terms.monthlyInterestRate, "Approved service-charge rate", { min: 0, max: 1 });
  numeric(terms.shareValue, "Approved share value", { min: 0, exclusiveMin: true, max: 100000000 });
  numeric(terms.loanRatioLimit, "Approved borrowing multiple", { min: 0, exclusiveMin: true, max: 100 });
  numeric(terms.interestPeriodDays, "Approved service-charge period", { min: 1, max: 3660, integer: true });
  numeric(terms.maxLoanTermDays ?? (Number(terms.maxLoanDurationMonths) * 30), "Approved maximum loan term", { min: 1, max: 3660, integer: true });
  if (String(terms.interestMethod || "").toUpperCase() !== "FLAT_PER_PERIOD") throw new Error("The approved constitution uses an unsupported service-charge method. Resolve this through Constitution & Rules before deployment.");
  numeric(terms.meetingIntervalDays, "Approved virtual payment interval", { min: 1, max: 366, integer: true });
  numeric(terms.virtualMeetingWindowDays, "Approved virtual payment window", { min: 1, max: Number(terms.meetingIntervalDays), integer: true });
  numeric(terms.cycleDurationMonths, "Approved savings cycle duration", { min: 1, max: 36, integer: true });
  if (String(terms.socialFundMode || "NONE").toUpperCase() !== "NONE" || Number(terms.socialFundContributionAmount || 0) !== 0) throw new Error("The approved constitution must exclude Social Fund contributions.");
  const termDays = Number(terms.maxLoanTermDays ?? Number(terms.maxLoanDurationMonths) * 30);
  const checks = [
    ["share value", settings.shareValue, terms.shareValue],
    ["minimum shares/window", settings.minSharesPerMeeting, terms.minSharesPerMeeting],
    ["borrowing limit", settings.loanRatioLimit, terms.loanRatioLimit],
    ["service-charge rate", settings.interestRate ?? settings.monthlyInterestRate, rate],
    ["service-charge period", settings.interestPeriodDays, terms.interestPeriodDays],
    ["maximum loan term", settings.maxLoanTermDays ?? (Number(settings.maxLoanDurationMonths) * 30), termDays],
    ["interest method", String(settings.interestMethod || "").toUpperCase(), "FLAT_PER_PERIOD"],
    ["virtual payment frequency", String(settings.meetingFrequency || "").toUpperCase(), String(terms.meetingFrequency || "").toUpperCase()],
    ["virtual payment interval", settings.meetingIntervalDays, terms.meetingIntervalDays],
    ["virtual payment-window duration", settings.virtualMeetingWindowDays, terms.virtualMeetingWindowDays],
    ["savings cycle duration", settings.cycleDurationMonths, terms.cycleDurationMonths],
  ];
  for (const [label, actual, expected] of checks) {
    const matched = typeof expected === "string" ? String(actual || "").toUpperCase() === expected : equalNumber(actual, expected);
    if (!matched) throw new Error(`Active company settings do not match the current member-approved Constitution & Rules for ${label}. Apply/repair the constitution settings through the application; do not edit production records manually.`);
  }
  const actualMaxShares = settings.maxSharesPerMeeting == null || settings.maxSharesPerMeeting === "" ? null : Number(settings.maxSharesPerMeeting);
  const expectedMaxShares = terms.maxSharesPerMeeting == null || terms.maxSharesPerMeeting === "" ? null : Number(terms.maxSharesPerMeeting);
  if (actualMaxShares !== expectedMaxShares) throw new Error("Active company settings do not match the current member-approved Constitution & Rules for maximum shares per window.");
  if (String(settings.socialFundMode || "NONE").toUpperCase() !== "NONE" || Number(settings.socialFundContributionAmount || 0) !== 0) throw new Error("Active company settings enable Social Fund, but CORNESTONE does not collect Social Fund contributions.");
}
module.exports = { assertConstitutionSettingsMatch };
