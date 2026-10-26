const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const db = require("../config/db");
const { verifyToken, requireRole, verifyGroupOwnership } = require("../middleware/auth");
const { financialIdempotency } = require("../middleware/financialIdempotency");
const { listMeetings, getMeetingRecord, saveMeetingRecord } = require("../services/meetingRecordsService");
const { RECEIPT_SELECT, parseReceiptRow, createReceipt } = require("../services/receiptService");
const { parseAuditRow, writeAuditEvent } = require("../services/auditService");
const { insertLedgerEntry, getBookBalance, parsePositiveId, parseAmount } = require("../services/fundLedgerService");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

function parseId(value, label) {
  return parsePositiveId(value, label);
}
function safeLimit(value, fallback = 50, max = 200) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

// Meeting register (open and closed meetings) for the selected cycle.
router.get("/groups/:groupId/cycles/:cycleId/meetings", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const groupId = parseId(req.params.groupId, "Group ID");
    const cycleId = parseId(req.params.cycleId, "Cycle ID");
    const [cycleRows] = await db.query("SELECT id FROM cycles WHERE id = ? AND group_id = ?", [cycleId, groupId]);
    if (!cycleRows.length) return res.status(404).json({ success: false, message: "Cycle not found for this group." });
    res.json({ success: true, meetings: await listMeetings(groupId, cycleId) });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
  }
});

router.get("/groups/:groupId/meetings/:meetingId/record", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const groupId = parseId(req.params.groupId, "Group ID");
    const meetingId = parseId(req.params.meetingId, "Meeting ID");
    const cycleId = parseId(req.query.cycleId, "Cycle ID");
    const record = await getMeetingRecord(groupId, cycleId, meetingId);
    res.json({ success: true, record });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
  }
});

router.put("/groups/:groupId/meetings/:meetingId/record", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency, async (req, res) => {
  try {
    const groupId = parseId(req.params.groupId, "Group ID");
    const meetingId = parseId(req.params.meetingId, "Meeting ID");
    const cycleId = parseId(req.body.cycleId, "Cycle ID");
    const result = await saveMeetingRecord({
      groupId, cycleId, meetingId, actorUserId: req.user.id,
      agenda: req.body.agenda, minutes: req.body.minutes, decisions: req.body.decisions,
      actionItems: req.body.actionItems, attendance: req.body.attendance,
      auditMeta: auditMetaFor(req),
    });
    res.json({ success: true, result });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
  }
});

// Members can view/print their own receipts. Leadership can view all receipts in the group.
router.get("/groups/:groupId/receipts", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const groupId = parseId(req.params.groupId, "Group ID");
    const cycleId = req.query.cycleId ? parseId(req.query.cycleId, "Cycle ID") : null;
    const limit = safeLimit(req.query.limit);
    const where = ["r.group_id = ?"];
    const values = [groupId];
    if (cycleId) { where.push("r.cycle_id = ?"); values.push(cycleId); }
    if (!LEADERSHIP_ROLES.includes(req.user.role)) {
      where.push("r.member_id = ?"); values.push(Number(req.user.id));
    }
    values.push(limit);
    const [rows] = await db.query(
      `${RECEIPT_SELECT} WHERE ${where.join(" AND ")} ORDER BY r.id DESC LIMIT ?`, values,
    );
    res.json({ success: true, receipts: rows.map(parseReceiptRow) });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
  }
});

router.get("/groups/:groupId/receipts/:receiptId", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const groupId = parseId(req.params.groupId, "Group ID");
    const receiptId = parseId(req.params.receiptId, "Receipt ID");
    const [rows] = await db.query(`${RECEIPT_SELECT} WHERE r.group_id = ? AND r.id = ? LIMIT 1`, [groupId, receiptId]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Receipt not found." });
    const receipt = parseReceiptRow(rows[0]);
    if (!LEADERSHIP_ROLES.includes(req.user.role) && receipt.memberId !== Number(req.user.id)) {
      return res.status(403).json({ success: false, message: "Members can only view their own receipts." });
    }
    if (!LEADERSHIP_ROLES.includes(req.user.role) && receipt.memberId == null) {
      return res.status(403).json({ success: false, message: "This receipt is available to group leadership only." });
    }
    res.json({ success: true, receipt });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
  }
});

router.get("/groups/:groupId/audit-log", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), async (req, res) => {
  try {
    const groupId = parseId(req.params.groupId, "Group ID");
    const cycleId = req.query.cycleId ? parseId(req.query.cycleId, "Cycle ID") : null;
    const limit = safeLimit(req.query.limit, 100, 300);
    const where = ["a.group_id = ?"];
    const values = [groupId];
    if (cycleId) { where.push("a.cycle_id = ?"); values.push(cycleId); }
    values.push(limit);
    const [rows] = await db.query(
      `SELECT a.*, u.full_name AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ?`, values,
    );
    res.json({ success: true, events: rows.map(parseAuditRow) });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
  }
});

// Append-only correction workflow. Loan disbursements and repayments require a loan-specific
// adjustment process; this route deliberately refuses to reverse them generically.
router.post("/groups/:groupId/cycles/:cycleId/cashbook/reversals", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency, async (req, res) => {
  let connection;
  try {
    const groupId = parseId(req.params.groupId, "Group ID");
    const cycleId = parseId(req.params.cycleId, "Cycle ID");
    const meetingId = req.body.meetingId == null || req.body.meetingId === "" ? null : parseId(req.body.meetingId, "Virtual window ID");
    const entryId = parseId(req.body.ledgerEntryId, "Ledger entry ID");
    const reason = String(req.body.reason || "").trim();
    if (reason.length < 5) throw new Error("Explain why this entry is being reversed (at least 5 characters).");
    if (reason.length > 1000) throw new Error("Correction explanation cannot exceed 1,000 characters.");

    connection = await db.getConnection();
    await connection.beginTransaction();
    const [cycleRows] = await connection.query("SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE", [cycleId, groupId]);
    if (!cycleRows.length) throw new Error("The selected cycle is not active for this group.");
    if (meetingId != null) {
      const [meetingRows] = await connection.query("SELECT id FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? AND status IN ('OPEN','CLOSED') FOR UPDATE", [meetingId, groupId, cycleId]);
      if (!meetingRows.length) throw new Error("The selected virtual window does not belong to this group and cycle.");
    }

    const [entryRows] = await connection.query(
      `SELECT e.*, t.type AS transaction_type, t.amount AS transaction_amount, t.status AS transaction_status,
          t.fine_reason, t.shares_count, t.member_id AS transaction_member_id, t.fine_assessment_id
       FROM fund_ledger_entries e
       LEFT JOIN transactions t ON e.source_type = 'TRANSACTION' AND e.source_id = t.id
       WHERE e.id = ? AND e.group_id = ? AND e.cycle_id = ? FOR UPDATE`,
      [entryId, groupId, cycleId],
    );
    if (!entryRows.length) throw new Error("Ledger entry not found in the selected group and cycle.");
    const original = entryRows[0];
    if (original.reversal_of_entry_id != null || String(original.entry_type).endsWith("_REVERSAL")) throw new Error("A reversal cannot itself be reversed. Record a new replacement entry with an explanation instead.");
    const existingReversal = await connection.query("SELECT id FROM fund_ledger_entries WHERE reversal_of_entry_id = ? LIMIT 1", [entryId]);
    if (existingReversal[0].length) throw new Error("This ledger entry has already been reversed.");

    let transaction = null;
    if (original.source_type === "TRANSACTION") {
      transaction = { type: original.transaction_type, status: original.transaction_status, fineAssessmentId: original.fine_assessment_id == null ? null : Number(original.fine_assessment_id) };
      if (!transaction.type) throw new Error("The source transaction could not be found; ask an administrator to inspect the ledger.");
      if (!["SHARE_PURCHASE", "FINE_PAYMENT"].includes(transaction.type) || original.source_component !== "TOTAL") {
        throw new Error("This transaction is tied to a loan disbursement or repayment and cannot be reversed through the general correction form. Use a loan-specific correction procedure.");
      }
      if (transaction.status === "REVERSED") throw new Error("This transaction has already been reversed.");
    } else if (original.source_type != null || original.loan_id != null || !["OPENING_BALANCE", "FUND_EXPENSE", "CASH_ADJUSTMENT"].includes(original.entry_type)) {
      throw new Error("This entry type cannot be reversed through the general correction form. Loan-related movements need the loan-specific correction workflow.");
    }

    const reverseDirection = original.direction === "IN" ? "OUT" : "IN";
    const amount = Number(original.amount);
    const currentBalance = await getBookBalance(connection, groupId, cycleId, original.fund_type);
    if (reverseDirection === "OUT" && amount > currentBalance + 0.001) {
      throw new Error(`Reversing this entry would make the ${original.fund_type.replaceAll("_", " ")} cashbook negative. Reconcile the facts and record an approved alternative correction.`);
    }
    const reverseType = `${original.entry_type}_REVERSAL`;
    const reversalLedgerId = await insertLedgerEntry(connection, {
      groupId, cycleId, meetingId, memberId: original.member_id ?? original.transaction_member_id ?? null,
      fundType: original.fund_type, entryType: reverseType, direction: reverseDirection, amount,
      profitEffect: -Number(original.profit_effect || 0), notes: `Reversal of ledger entry #${entryId}. Reason: ${reason}`,
      sourceType: "REVERSAL", sourceId: entryId, sourceComponent: "REVERSAL", createdBy: req.user.id,
      reversalOfEntryId: entryId,
    });

    if (transaction) {
      await connection.query(
        `UPDATE transactions SET status = 'REVERSED', reversed_by = ?, reversed_at = CURRENT_TIMESTAMP, reversal_reason = ?
         WHERE id = ? AND status = 'POSTED'`,
        [req.user.id, reason, original.source_id],
      );
      if (transaction.type === "FINE_PAYMENT") {
        await connection.query(
          `UPDATE cycles SET total_fines_collected = GREATEST(0, COALESCE(total_fines_collected, 0) - ?)
           WHERE id = ? AND group_id = ?`, [amount, cycleId, groupId],
        );
        if (transaction.fineAssessmentId) {
          const [assessmentRows] = await connection.query(
            "SELECT amount, amount_paid FROM fine_assessments WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE",
            [transaction.fineAssessmentId, groupId, cycleId],
          );
          if (!assessmentRows.length) throw new Error("The linked fine assessment is missing; the reversal was not completed.");
          const assessed = Number(assessmentRows[0].amount);
          const paidAfterReversal = Math.max(0, Math.round((Number(assessmentRows[0].amount_paid) - amount + Number.EPSILON) * 100) / 100);
          const remainingAfterReversal = Math.max(0, Math.round((assessed - paidAfterReversal + Number.EPSILON) * 100) / 100);
          const fineStatus = paidAfterReversal < 0.01 ? "OUTSTANDING" : remainingAfterReversal < 0.01 ? "PAID" : "PARTIALLY_PAID";
          await connection.query(
            "UPDATE fine_assessments SET amount_paid = ?, status = ? WHERE id = ?",
            [paidAfterReversal, fineStatus, transaction.fineAssessmentId],
          );
        }
      }
    }
    const receipt = await createReceipt(connection, {
      groupId, cycleId, meetingId, memberId: original.member_id ?? original.transaction_member_id ?? null,
      sourceType: "LEDGER_ENTRY", sourceId: reversalLedgerId, sourceComponent: "TOTAL",
      activityType: "FINANCIAL_REVERSAL", amount, summary: `Reversal of entry #${entryId}`,
      details: { originalEntryId: entryId, reversalLedgerId, fundType: original.fund_type, direction: reverseDirection, reason },
      issuedBy: req.user.id,
    });
    await writeAuditEvent(connection, {
      groupId, cycleId, meetingId, actorUserId: req.user.id, action: "FINANCIAL_ENTRY_REVERSED", entityType: "FUND_LEDGER_ENTRY",
      entityId: entryId, reason,
      beforeData: { id: entryId, entryType: original.entry_type, fundType: original.fund_type, direction: original.direction,
        amount, profitEffect: Number(original.profit_effect || 0), sourceType: original.source_type, sourceId: original.source_id },
      afterData: { reversalLedgerId, reverseType, reverseDirection, amount, receiptNumber: receipt.receiptNumber, transactionStatus: transaction ? "REVERSED" : null },
      ...auditMetaFor(req),
    });
    await connection.commit();
    res.status(201).json({ success: true, message: `Entry #${entryId} reversed. Record the correct replacement separately, then recount and reconcile the fund.`, reversalLedgerId, receipt });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
