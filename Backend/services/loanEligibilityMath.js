"use strict";

function nonNegativeNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a finite, non-negative amount.`);
  return parsed;
}

function calculateBorrowingCapacity({ eligibleSavings, loanRatioLimit = 2, outstandingPrincipal = 0, reservedApplications = 0 }) {
  const savings = nonNegativeNumber(eligibleSavings, "Eligible savings");
  const ratio = Number(loanRatioLimit);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100) throw new Error("The borrowing ratio must be greater than zero and no more than 100.");
  const principal = nonNegativeNumber(outstandingPrincipal, "Outstanding principal");
  const reserved = nonNegativeNumber(reservedApplications, "Reserved loan applications");
  const grossBorrowingLimit = Math.round((savings * ratio + Number.EPSILON) * 100) / 100;
  const availableBorrowing = Math.max(0, Math.round((grossBorrowingLimit - principal - reserved + Number.EPSILON) * 100) / 100);
  return { grossBorrowingLimit, availableBorrowing };
}

module.exports = { calculateBorrowingCapacity };
