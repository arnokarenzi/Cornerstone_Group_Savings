"use strict";

const PAYMENT_PURPOSES = Object.freeze(["SHARE_PURCHASE", "LOAN_REPAYMENT", "FINE_PAYMENT"]);

function validatePaymentPurpose(purpose, loanId, fineAssessmentId) {
  const normalized = String(purpose || "").trim().toUpperCase();
  if (!PAYMENT_PURPOSES.includes(normalized)) {
    const error = new Error("Choose a share contribution, loan repayment, or fine payment.");
    error.statusCode = 400;
    throw error;
  }
  const hasLoan = loanId != null;
  const hasFine = fineAssessmentId != null;
  const valid = normalized === "SHARE_PURCHASE"
    ? !hasLoan && !hasFine
    : normalized === "LOAN_REPAYMENT"
      ? hasLoan && !hasFine
      : !hasLoan && hasFine;
  if (!valid) {
    const error = new Error("Select a loan only for loan repayments and an outstanding fine only for fine payments.");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

module.exports = { PAYMENT_PURPOSES, validatePaymentPurpose };
