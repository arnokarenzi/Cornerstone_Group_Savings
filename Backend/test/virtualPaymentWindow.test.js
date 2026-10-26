const test = require("node:test");
const assert = require("node:assert/strict");
const { getVirtualPaymentWindowStatus } = require("../services/virtualPaymentWindow");

test("virtual payment window is open for the first three cycle days in Kigali time", () => {
  const start = "2026-01-01";
  assert.equal(getVirtualPaymentWindowStatus({ cycleStartDate: start, now: "2026-01-01T10:00:00Z" }).isOpen, true);
  assert.equal(getVirtualPaymentWindowStatus({ cycleStartDate: start, now: "2026-01-03T10:00:00Z" }).isOpen, true);
  const closed = getVirtualPaymentWindowStatus({ cycleStartDate: start, now: "2026-01-04T10:00:00Z" });
  assert.equal(closed.isOpen, false);
  assert.equal(closed.nextOpenDate, "2026-01-15");
});

test("virtual payment window recurs every 14 days and opens for 3 days", () => {
  const atNextWindow = getVirtualPaymentWindowStatus({ cycleStartDate: "2026-01-01", now: "2026-01-15T10:00:00Z" });
  assert.equal(atNextWindow.isOpen, true);
  assert.equal(atNextWindow.windowNumber, 2);
  assert.equal(atNextWindow.windowStartDate, "2026-01-15");
  assert.equal(atNextWindow.windowEndDate, "2026-01-17");
  assert.equal(atNextWindow.intervalDays, 14);
  assert.equal(atNextWindow.windowDays, 3);
});

test("future cycle dates do not open a payment window", () => {
  const status = getVirtualPaymentWindowStatus({ cycleStartDate: "2026-02-01", now: "2026-01-31T20:00:00Z" });
  assert.equal(status.isOpen, false);
  assert.equal(status.windowNumber, null);
  assert.equal(status.nextOpenDate, "2026-02-01");
});
