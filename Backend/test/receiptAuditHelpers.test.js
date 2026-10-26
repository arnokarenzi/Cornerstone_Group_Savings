const test = require("node:test");
const assert = require("node:assert/strict");
const { createReceipt, parseReceiptRow } = require("../services/receiptService");
const { writeAuditEvent, parseAuditRow } = require("../services/auditService");

test("creates a normalized RWF receipt inside the caller's DB transaction", async () => {
  let call;
  const connection = {
    async query(sql, values) {
      call = { sql, values };
      return [{ insertId: 77 }, []];
    },
  };
  const receipt = await createReceipt(connection, {
    groupId: 3, cycleId: 2, meetingId: 9, memberId: 12,
    sourceType: "TRANSACTION", sourceId: 44, sourceComponent: "TOTAL",
    activityType: "SHARE_PURCHASE", amount: 2000,
    summary: "2 shares purchased", details: { sharesCount: 2 }, issuedBy: 8,
  });
  assert.equal(receipt.id, 77);
  assert.match(receipt.receiptNumber, /^IS-G3-/);
  assert.equal(receipt.amount, 2000);
  assert.deepEqual(receipt.details, { sharesCount: 2 });
  assert.match(call.sql, /INSERT INTO financial_receipts/);
  assert.equal(call.values[1], 3);
  assert.equal(call.values[8], "SHARE_PURCHASE");
});

test("parses persisted receipt details without losing member and meeting references", () => {
  const receipt = parseReceiptRow({
    id: 1, receipt_number: "IS-G3-TEST", group_id: 3, group_name: "Amahoro VSLA",
    cycle_id: 2, cycle_number: 1, meeting_id: 9, meeting_number: 4,
    member_id: 12, member_name: "Sample Member", member_phone: "+250700000000",
    activity_type: "SHARE_PURCHASE", amount: "2000.00", currency: "RWF", summary: "Share purchase",
    details_json: '{"sharesCount":2}', issued_by: 8, issued_by_name: "Treasurer", issued_at: "2026-10-18 09:00:00",
  });
  assert.equal(receipt.receiptNumber, "IS-G3-TEST");
  assert.equal(receipt.memberName, "Sample Member");
  assert.equal(receipt.meetingNumber, 4);
  assert.deepEqual(receipt.details, { sharesCount: 2 });
});

test("writes audit before/after states and parses them for leadership review", async () => {
  let stored;
  const connection = {
    async query(sql, values) {
      stored = { sql, values };
      return [{ insertId: 101 }, []];
    },
  };
  await writeAuditEvent(connection, {
    groupId: 3, cycleId: 2, meetingId: 9, actorUserId: 8,
    action: "FINANCIAL_ENTRY_REVERSED", entityType: "FUND_LEDGER_ENTRY", entityId: 44,
    reason: "Incorrect amount", beforeData: { amount: 2000 }, afterData: { amount: -2000 }, ipAddress: "127.0.0.1",
  });
  assert.match(stored.sql, /INSERT INTO audit_logs/);
  const row = {
    id: 101, group_id: 3, cycle_id: 2, meeting_id: 9, actor_user_id: 8, actor_name: "Treasurer",
    action: stored.values[4], entity_type: stored.values[5], entity_id: stored.values[6], reason: stored.values[7],
    before_json: stored.values[8], after_json: stored.values[9], ip_address: stored.values[10], created_at: "2026-10-18 09:00:00",
  };
  const event = parseAuditRow(row);
  assert.deepEqual(event.beforeData, { amount: 2000 });
  assert.deepEqual(event.afterData, { amount: -2000 });
  assert.equal(event.actorName, "Treasurer");
});
