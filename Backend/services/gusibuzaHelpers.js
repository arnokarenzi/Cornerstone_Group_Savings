"use strict";

function normalizeFineLabel(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function isAutomaticAbsenceFineLabel(value) {
  return ["absence without excuse", "absent without excuse"].includes(normalizeFineLabel(value));
}

function findAutomaticAbsenceFineRule(fineRules = []) {
  if (!Array.isArray(fineRules)) return null;
  return fineRules.find((rule) => isAutomaticAbsenceFineLabel(rule?.label ?? rule?.name)) || null;
}

function calculateGusibuzaFee({ feeMode, feeAmount, sharesCount, alreadyPaidPerMeetingFee = false }) {
  const mode = String(feeMode || "PER_SHARE").toUpperCase();
  const fee = Number(feeAmount);
  const shares = Number(sharesCount);
  if (!Number.isFinite(fee) || fee <= 0 || !Number.isSafeInteger(shares) || shares <= 0) {
    throw new Error("Gusibuza fee settings and share count must be valid positive values.");
  }
  if (mode === "PER_SHARE") return roundMoney(fee * shares);
  if (mode === "PER_MEETING") return alreadyPaidPerMeetingFee ? 0 : roundMoney(fee);
  throw new Error("Gusibuza fee mode must be PER_SHARE or PER_MEETING.");
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function completedInterestPeriods({ now = Date.now(), disbursedAt, periodDays }) {
  const start = new Date(disbursedAt).getTime();
  const period = Number(periodDays);
  if (!Number.isFinite(start) || !Number.isSafeInteger(period) || period <= 0) return 0;
  const elapsedDays = Math.max(0, Math.floor((Number(now) - start) / 86400000));
  return Math.floor(elapsedDays / period);
}

function calculatePeriodicInterest(principalRemaining, interestRate, periods = 1) {
  const principal = Number(principalRemaining);
  const rate = Number(interestRate);
  const numberOfPeriods = Number(periods);
  if (!Number.isFinite(principal) || principal < 0 || !Number.isFinite(rate) || rate < 0 ||
      !Number.isSafeInteger(numberOfPeriods) || numberOfPeriods < 0) {
    throw new Error("Cannot calculate periodic interest from invalid values.");
  }
  return roundMoney(principal * rate * numberOfPeriods);
}

module.exports = {
  normalizeFineLabel,
  isAutomaticAbsenceFineLabel,
  findAutomaticAbsenceFineRule,
  calculateGusibuzaFee,
  completedInterestPeriods,
  calculatePeriodicInterest,
  roundMoney,
};
