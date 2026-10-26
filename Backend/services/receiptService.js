const crypto = require("crypto");

function safeDetails(details) {
  if (details == null) return {};
  try {
    const encoded = JSON.stringify(details);
    if (encoded.length > 12000) throw new Error("Receipt details are too large.");
    return details;
  } catch (error) {
    throw new Error(`Could not encode receipt details: ${error.message}`);
  }
}

/** Insert an immutable receipt in the same DB transaction as the financial movement. */
async function createReceipt(connection, input) {
  const groupId = Number(input.groupId);
  const cycleId = Number(input.cycleId);
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !Number.isSafeInteger(cycleId) || cycleId <= 0) {
    throw new Error("A receipt requires valid group and cycle IDs.");
  }
  if (!Number.isFinite(amount) || amount < 0) throw new Error("A receipt amount must be zero or greater.");

  const receiptNumber = `IS-G${groupId}-${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const details = safeDetails(input.details);
  const [result] = await connection.query(
    `INSERT INTO financial_receipts
      (receipt_number, group_id, cycle_id, meeting_id, member_id, source_type, source_id,
       source_component, activity_type, amount, currency, summary, details_json, issued_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RWF', ?, ?, ?)`,
    [
      receiptNumber,
      groupId,
      cycleId,
      input.meetingId ?? null,
      input.memberId ?? null,
      String(input.sourceType),
      String(input.sourceId),
      String(input.sourceComponent || "TOTAL"),
      String(input.activityType).slice(0, 60),
      Math.round((amount + Number.EPSILON) * 100) / 100,
      String(input.summary || input.activityType).slice(0, 255),
      JSON.stringify(details),
      input.issuedBy ?? null,
    ],
  );
  return {
    id: Number(result.insertId),
    receiptNumber,
    groupId,
    cycleId,
    meetingId: input.meetingId == null ? null : Number(input.meetingId),
    memberId: input.memberId == null ? null : Number(input.memberId),
    activityType: String(input.activityType),
    amount: Math.round((amount + Number.EPSILON) * 100) / 100,
    currency: "RWF",
    summary: String(input.summary || input.activityType),
    details,
    issuedBy: input.issuedBy == null ? null : Number(input.issuedBy),
    issuedAt: new Date().toISOString(),
  };
}

function parseReceiptRow(row) {
  let details = {};
  try { details = row.details_json ? JSON.parse(row.details_json) : {}; } catch { details = { note: "Receipt details could not be decoded." }; }
  return {
    id: Number(row.id),
    receiptNumber: row.receipt_number,
    groupId: Number(row.group_id),
    groupName: row.group_name || "CORNESTONE Co.LTD.",
    cycleId: Number(row.cycle_id),
    cycleNumber: row.cycle_number == null ? null : Number(row.cycle_number),
    meetingId: row.meeting_id == null ? null : Number(row.meeting_id),
    meetingNumber: row.meeting_number == null ? null : Number(row.meeting_number),
    memberId: row.member_id == null ? null : Number(row.member_id),
    memberName: row.member_name || null,
    memberPhone: row.member_phone || null,
    activityType: row.activity_type,
    amount: Number(row.amount),
    currency: row.currency || "RWF",
    summary: row.summary,
    details,
    issuedBy: row.issued_by == null ? null : Number(row.issued_by),
    issuedByName: row.issued_by_name || "System",
    issuedAt: row.issued_at,
  };
}

const RECEIPT_SELECT = `SELECT r.*, g.name AS group_name, c.cycle_number,
    m.meeting_number, member.full_name AS member_name, member.phone_number AS member_phone,
    issuer.full_name AS issued_by_name
  FROM financial_receipts r
  JOIN \`groups\` g ON g.id = r.group_id
  JOIN cycles c ON c.id = r.cycle_id
  LEFT JOIN meetings m ON m.id = r.meeting_id
  LEFT JOIN users member ON member.id = r.member_id
  LEFT JOIN users issuer ON issuer.id = r.issued_by`;

module.exports = { createReceipt, parseReceiptRow, RECEIPT_SELECT };
