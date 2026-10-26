"use strict";

const db = require("../config/db");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { insertLedgerEntry, roundMoney, parseAmount } = require("./fundLedgerService");

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

async function getOutstandingFines(groupId, cycleId, memberId) {
  const parsedGroupId = positiveId(groupId, "Group ID");
  const parsedCycleId = positiveId(cycleId, "Cycle ID");
  const parsedMemberId = positiveId(memberId, "Borrower member ID");
  const [cycleRows] = await db.query(
    "SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' LIMIT 1",
    [parsedCycleId, parsedGroupId],
  );
  if (!cycleRows.length) throw new Error("The selected cycle is not active for this group.");
  const [memberRows] = await db.query(
    "SELECT id FROM users WHERE id = ? AND group_id = ? LIMIT 1",
    [parsedMemberId, parsedGroupId],
  );
  if (!memberRows.length) {
    const error = new Error("The selected borrower does not belong to this group.");
    error.statusCode = 404;
    throw error;
  }
  const [rows] = await db.query(
    `SELECT id, cycle_id, meeting_id, member_id, fine_label, reason, amount, amount_paid, status, created_at
     FROM fine_assessments
     WHERE group_id = ? AND cycle_id = ? AND member_id = ?
       AND status IN ('OUTSTANDING','PARTIALLY_PAID') AND amount - amount_paid > 0.009
     ORDER BY created_at ASC, id ASC`,
    [parsedGroupId, parsedCycleId, parsedMemberId],
  );
  return rows.map((row) => ({
    fineId: Number(row.id),
    cycleId: Number(row.cycle_id),
    meetingId: Number(row.meeting_id),
    memberId: Number(row.member_id),
    fineLabel: row.fine_label,
    reason: row.reason,
    assessedAmount: roundMoney(row.amount),
    amountPaid: roundMoney(row.amount_paid),
    balanceRemaining: roundMoney(Number(row.amount) - Number(row.amount_paid)),
    status: row.status,
    assessedAt: row.created_at,
  }));
}

async function payFineAssessment({ fineId, groupId, cycleId, meetingId, memberId, amount, recordedBy, auditMeta = {} }) {
  const parsedFineId = positiveId(fineId, "Fine ID");
  const parsedGroupId = positiveId(groupId, "Group ID");
  const parsedCycleId = positiveId(cycleId, "Cycle ID");
  const parsedMeetingId = meetingId == null || meetingId === "" ? null : positiveId(meetingId, "Meeting ID");
  const parsedMemberId = positiveId(memberId, "Borrower member ID");
  const parsedRecorder = positiveId(recordedBy, "Recording user ID");
  const payment = parseAmount(amount, "Fine payment");
  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [cycleRows] = await connection.query(
      "SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE",
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected cycle is not active for this group.");
    if (parsedMeetingId != null) {
      const [meetingRows] = await connection.query(
        "SELECT id FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? AND status IN ('OPEN','CLOSED') FOR UPDATE",
        [parsedMeetingId, parsedGroupId, parsedCycleId],
      );
      if (!meetingRows.length) throw new Error("The selected virtual window does not belong to this group and cycle.");
    }
    const [fineRows] = await connection.query(
      `SELECT * FROM fine_assessments
       WHERE id = ? AND group_id = ? AND cycle_id = ? AND member_id = ? AND status IN ('OUTSTANDING','PARTIALLY_PAID')
       FOR UPDATE`,
      [parsedFineId, parsedGroupId, parsedCycleId, parsedMemberId],
    );
    if (!fineRows.length) throw new Error("The selected outstanding fine does not belong to this borrower, group and cycle, or it has already been settled.");
    const fine = fineRows[0];
    const assessedAmount = roundMoney(fine.amount);
    const alreadyPaid = roundMoney(fine.amount_paid);
    const balanceBefore = roundMoney(assessedAmount - alreadyPaid);
    if (payment > balanceBefore + 0.009) {
      throw new Error(`Fine payment exceeds the outstanding fine balance of ${balanceBefore.toLocaleString()} RWF.`);
    }
    const amountPaid = roundMoney(alreadyPaid + payment);
    const balanceRemaining = Math.max(0, roundMoney(assessedAmount - amountPaid));
    const status = balanceRemaining < 0.01 ? "PAID" : "PARTIALLY_PAID";

    const [txResult] = await connection.query(
      `INSERT INTO transactions
        (group_id, cycle_id, meeting_id, member_id, fine_assessment_id, type, amount, shares_count, fine_reason)
       VALUES (?, ?, ?, ?, ?, 'FINE_PAYMENT', ?, 0, ?)`,
      [parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId, parsedFineId, payment, fine.reason || fine.fine_label],
    );
    const ledgerEntryId = await insertLedgerEntry(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      memberId: parsedMemberId, fundType: "LOAN_FUND", entryType: "FINE_PAYMENT", direction: "IN",
      amount: payment, profitEffect: payment, notes: `Payment against fine #${parsedFineId}: ${fine.reason || fine.fine_label}`,
      sourceType: "TRANSACTION", sourceId: txResult.insertId, sourceComponent: "TOTAL", createdBy: parsedRecorder,
    });
    await connection.query(
      "UPDATE fine_assessments SET amount_paid = ?, status = ? WHERE id = ?",
      [amountPaid, status, parsedFineId],
    );
    await connection.query(
      "UPDATE cycles SET total_fines_collected = COALESCE(total_fines_collected, 0) + ? WHERE id = ? AND group_id = ?",
      [payment, parsedCycleId, parsedGroupId],
    );
    const receipt = await createReceipt(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId, memberId: parsedMemberId,
      sourceType: "TRANSACTION", sourceId: txResult.insertId, sourceComponent: "TOTAL", activityType: "FINE_PAYMENT",
      amount: payment, summary: `Fine payment for ${fine.reason || fine.fine_label}`,
      details: { transactionId: txResult.insertId, fineId: parsedFineId, fineLabel: fine.fine_label,
        reason: fine.reason, amountPaid: payment, amountPaidToDate: amountPaid, balanceRemaining, status },
      issuedBy: parsedRecorder,
    });
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId, actorUserId: parsedRecorder,
      action: "FINE_PAYMENT_RECORDED", entityType: "FINE_ASSESSMENT", entityId: parsedFineId,
      beforeData: { amountPaid: alreadyPaid, balanceRemaining: balanceBefore, status: fine.status },
      afterData: { amountPaid, balanceRemaining, status, payment, transactionId: txResult.insertId,
        ledgerEntryId, receiptNumber: receipt.receiptNumber },
      ...auditMeta,
    });
    await connection.commit();
    transactionStarted = false;
    return { fineId: parsedFineId, paymentAmount: payment, amountPaid, balanceRemaining, status, transactionId: txResult.insertId, receipt };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    const wrapped = new Error(`Fine payment failed: ${error.message}`, { cause: error });
    wrapped.code = error.code;
    throw wrapped;
  } finally {
    connection.release();
  }
}

module.exports = { getOutstandingFines, payFineAssessment };
