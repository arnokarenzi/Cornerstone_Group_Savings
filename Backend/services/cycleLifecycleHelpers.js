"use strict";

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function cashAmount(value, label) {
  if (value == null || value === "") throw new Error(`${label} is required. Count the actual physical cash and enter the amount.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be zero or a positive amount.`);
  const amount = roundMoney(parsed);
  if (amount < 0) throw new Error(`${label} must be zero or a positive amount.`);
  return amount;
}

function findOtherLiveCycle(rows, currentCycleId) {
  const currentId = Number(currentCycleId);
  return (Array.isArray(rows) ? rows : []).find((row) =>
    Number(row.id) !== currentId && ["ACTIVE", "CLOSING"].includes(String(row.status || "").toUpperCase()),
  ) || null;
}

function mapPayout(row) {
  return {
    id: Number(row.id), memberId: Number(row.member_id), fullName: row.full_name || "Former member",
    phoneNumber: row.phone_number || "", sharesCount: Number(row.shares_count || 0),
    savingsAmount: roundMoney(row.savings_amount), profitAmount: roundMoney(row.profit_amount),
    payoutAmount: roundMoney(row.payout_amount), status: row.status,
    paidAt: row.paid_at || null, receiptId: row.receipt_id == null ? null : Number(row.receipt_id),
  };
}

module.exports = { roundMoney, positiveId, cashAmount, mapPayout, findOtherLiveCycle };
