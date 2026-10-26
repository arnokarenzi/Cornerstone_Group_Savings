"use strict";

const DEFAULT_TIME_ZONE = "Africa/Kigali";
const DAY_MS = 24 * 60 * 60 * 1000;

function dateOnly(value, label = "Date") {
  // mysql2 may hydrate SQL DATE values as local-midnight Date objects. Read
  // their local calendar components instead of UTC ISO text to avoid shifting
  // the cycle start to the previous date in UTC+ zones such as Rwanda.
  const text = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must be a valid date.`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new Error(`${label} must be a valid date.`);
  return text;
}

function addDays(dateText, days) {
  const date = new Date(`${dateOnly(dateText)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function todayInTimeZone(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("Current time is invalid.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * A savings window begins on the cycle start date and recurs by the configured
 * interval. Each window is open for whole Rwanda calendar days [start, start+N).
 * Loan repayments are deliberately not governed by this schedule.
 */
function getVirtualPaymentWindowStatus({
  cycleStartDate,
  intervalDays = 14,
  windowDays = 3,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
} = {}) {
  const start = dateOnly(cycleStartDate, "Cycle start date");
  const interval = Number(intervalDays);
  const duration = Number(windowDays);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 366) throw new Error("Virtual payment interval must be a whole number from 1 to 366 days.");
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > interval) throw new Error("Virtual payment window duration must be a whole number from 1 day through the full interval.");

  const today = todayInTimeZone(now, timeZone);
  const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
  const todayMs = new Date(`${today}T00:00:00.000Z`).getTime();
  const elapsedDays = Math.floor((todayMs - startMs) / DAY_MS);
  if (elapsedDays < 0) {
    return {
      isOpen: false,
      timeZone,
      today,
      intervalDays: interval,
      windowDays: duration,
      windowNumber: null,
      windowStartDate: start,
      windowEndDate: addDays(start, duration - 1),
      nextOpenDate: start,
      dayOfInterval: null,
      daysUntilNextWindow: Math.ceil((startMs - todayMs) / DAY_MS),
    };
  }

  const windowIndex = Math.floor(elapsedDays / interval);
  const dayOfInterval = elapsedDays % interval;
  const windowStartDate = addDays(start, windowIndex * interval);
  const windowEndDate = addDays(windowStartDate, duration - 1);
  const isOpen = dayOfInterval < duration;
  const nextOpenDate = isOpen ? windowStartDate : addDays(start, (windowIndex + 1) * interval);

  return {
    isOpen,
    timeZone,
    today,
    intervalDays: interval,
    windowDays: duration,
    windowNumber: windowIndex + 1,
    windowStartDate,
    windowEndDate,
    nextOpenDate,
    dayOfInterval,
    daysUntilNextWindow: isOpen ? 0 : Math.max(0, Math.floor((new Date(`${nextOpenDate}T00:00:00.000Z`).getTime() - todayMs) / DAY_MS)),
  };
}

module.exports = { DEFAULT_TIME_ZONE, dateOnly, addDays, todayInTimeZone, getVirtualPaymentWindowStatus };
