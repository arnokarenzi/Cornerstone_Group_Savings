const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_LOAN_DEFAULT_GRACE_DAYS,
  addCalendarDays,
  getTodayIsoInTimeZone,
  isLoanPastGracePeriod,
} = require("../services/loanDefaultPolicy");

test("the six-month contractual due date has no additional grace period", () => {
  assert.equal(DEFAULT_LOAN_DEFAULT_GRACE_DAYS, 0);
  assert.equal(addCalendarDays("2026-10-18", 180), "2027-04-16");
});

test("loan is not in default on its due date and defaults the following day", () => {
  assert.equal(isLoanPastGracePeriod("2026-10-18", "2026-10-18"), false);
  assert.equal(isLoanPastGracePeriod("2026-10-18", "2026-10-19"), true);
});

test("Kigali calendar date is used rather than UTC date", () => {
  // 2026-10-24 22:30 UTC is already 2026-10-25 in Kigali (UTC+2).
  assert.equal(getTodayIsoInTimeZone(new Date("2026-10-24T22:30:00.000Z")), "2026-10-25");
});

test("invalid dates and negative grace days are rejected", () => {
  assert.throws(() => isLoanPastGracePeriod("2026-02-30", "2026-03-01"), /valid YYYY-MM-DD/);
  assert.throws(() => addCalendarDays("2026-10-01", -1), /whole number/);
});
