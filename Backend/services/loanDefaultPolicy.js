"use strict";

const DEFAULT_LOAN_DEFAULT_GRACE_DAYS = 0;
const PAYMENT_POLICY_TIME_ZONE = "Africa/Kigali";

function requireIsoDate(value, label = "Date") {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  }
  return text;
}

function addCalendarDays(isoDate, days) {
  const dateText = requireIsoDate(isoDate);
  const dayCount = Number(days);
  if (!Number.isSafeInteger(dayCount) || dayCount < 0 || dayCount > 3650) {
    throw new Error("Calendar days must be a whole number between 0 and 3650.");
  }
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayCount);
  return date.toISOString().slice(0, 10);
}

function getTodayIsoInTimeZone(now = new Date(), timeZone = PAYMENT_POLICY_TIME_ZONE) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("A valid current date/time is required.");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** A zero-day grace period means default starts the day after the contractual due date. */
function isLoanPastGracePeriod(dueDate, currentDate, graceDays = DEFAULT_LOAN_DEFAULT_GRACE_DAYS) {
  const due = requireIsoDate(dueDate, "Loan due date");
  const today = requireIsoDate(currentDate, "Current date");
  const graceEnd = addCalendarDays(due, graceDays);
  return today > graceEnd;
}

module.exports = {
  DEFAULT_LOAN_DEFAULT_GRACE_DAYS,
  PAYMENT_POLICY_TIME_ZONE,
  requireIsoDate,
  addCalendarDays,
  getTodayIsoInTimeZone,
  isLoanPastGracePeriod,
};
