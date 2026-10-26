"use strict";

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * The first service charge is due from disbursement, even if a borrower repays
 * before the configured service-charge period ends. Each further configured
 * period incurs another full charge at its start boundary. Loans issued by the
 * service store period 1 as already charged, so the next charge is due at the
 * saved period boundary if principal is still outstanding.
 */
function periodicChargesDue({ now = Date.now(), disbursedAt, periodDays }) {
  const start = new Date(disbursedAt).getTime();
  const period = Number(periodDays);
  const current = Number(now);
  if (!Number.isFinite(start) || !Number.isFinite(current) || !Number.isSafeInteger(period) || period <= 0) {
    throw new Error("Loan disbursement date and interest period must be valid.");
  }
  if (current <= start) return 1;
  const elapsedDays = Math.max(0, Math.floor((current - start) / 86400000));
  return Math.floor(elapsedDays / period) + 1;
}

/** Flat simple-interest charge(s) against the principal still unpaid. */
function calculateInterestOnRemainingPrincipal(principalRemaining, interestRate, periods = 1) {
  const principal = Number(principalRemaining);
  const rate = Number(interestRate);
  const count = Number(periods);
  if (!Number.isFinite(principal) || principal < 0 || !Number.isFinite(rate) || rate < 0 ||
      !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Cannot calculate loan interest from invalid values.");
  }
  return roundMoney(principal * rate * count);
}

/**
 * Calculates only newly started service-charge periods. The initial period is
 * charged at disbursement; each further configured block starts a new charge
 * period. Each additional charge uses principal outstanding at that period's
 * boundary reconstructed from dated principal repayments.
 */
function calculatePeriodicServiceChargeAccrual({
  principalAmount,
  interestRate,
  periodDays,
  disbursedAt,
  now = Date.now(),
  alreadyChargedPeriods = 0,
  repayments = [],
} = {}) {
  const principal = Number(principalAmount);
  const rate = Number(interestRate);
  const period = Number(periodDays);
  const start = new Date(disbursedAt).getTime();
  const current = Number(now);
  const charged = Number(alreadyChargedPeriods);
  if (!Number.isFinite(principal) || principal < 0 || !Number.isFinite(rate) || rate < 0 ||
      !Number.isSafeInteger(period) || period <= 0 || !Number.isFinite(start) ||
      !Number.isFinite(current) || !Number.isSafeInteger(charged) || charged < 0) {
    throw new Error("Periodic service-charge inputs must be valid.");
  }
  const targetPeriods = periodicChargesDue({ now: current, disbursedAt, periodDays: period });
  const normalizedRepayments = repayments.map((item) => ({
    principalAmount: Number(item?.principalAmount ?? item?.principal_amount ?? 0),
    createdAt: new Date(item?.createdAt ?? item?.created_at).getTime(),
  })).filter((item) => Number.isFinite(item.principalAmount) && item.principalAmount > 0 && Number.isFinite(item.createdAt));

  let addedCharge = 0;
  for (let periodNumber = charged + 1; periodNumber <= targetPeriods; periodNumber += 1) {
    const chargeAt = start + ((periodNumber - 1) * period * 86400000);
    const principalPaidByPeriodEnd = normalizedRepayments.reduce(
      (sum, item) => sum + (item.createdAt <= chargeAt ? item.principalAmount : 0), 0,
    );
    const principalRemainingAtPeriodEnd = Math.max(0, roundMoney(principal - principalPaidByPeriodEnd));
    addedCharge = roundMoney(addedCharge + roundMoney(principalRemainingAtPeriodEnd * rate));
  }
  return { targetPeriods, addedCharge };
}

/**
 * Allocate actual cash received to outstanding interest first, then principal.
 * This is bounded by total outstanding components, so a payment can never be
 * split into more principal than the member actually owes.
 */
function allocateRepayment({ payment, principalRemaining, interestRemaining }) {
  const paid = roundMoney(payment);
  const principal = roundMoney(principalRemaining);
  const interest = roundMoney(interestRemaining);
  if (![paid, principal, interest].every(Number.isFinite) || paid <= 0 || principal < 0 || interest < 0) {
    throw new Error("Repayment amounts and outstanding balances must be valid non-negative amounts.");
  }
  const outstanding = roundMoney(principal + interest);
  if (paid > outstanding + 0.009) {
    throw new Error(`Repayment exceeds the total outstanding loan balance of ${outstanding.toLocaleString()} RWF.`);
  }
  const interestPaid = roundMoney(Math.min(paid, interest));
  const principalPaid = roundMoney(Math.min(Math.max(0, paid - interestPaid), principal));
  return { interestPaid, principalPaid, balanceRemaining: Math.max(0, roundMoney(outstanding - paid)) };
}

module.exports = { roundMoney, periodicChargesDue, calculateInterestOnRemainingPrincipal, calculatePeriodicServiceChargeAccrual, allocateRepayment };
