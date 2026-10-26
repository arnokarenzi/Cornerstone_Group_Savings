const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const db = require("../config/db");
const { createReceipt } = require("../services/receiptService");
const { writeAuditEvent } = require("../services/auditService");
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });
const {
  verifyToken,
  requireRole,
  verifyGroupOwnership,
} = require("../middleware/auth");
const { financialIdempotency } = require("../middleware/financialIdempotency");
const {
  parsePositiveId,
  parseAmount,
  validateFundType,
  roundMoney,
  insertLedgerEntry,
  getBookBalance,
  getLastLedgerEntryId,
  requirePreviouslyBalancedCount,
  getCashbookReport,
} = require("../services/fundLedgerService");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];

function validateNotes(value, { optional = false } = {}) {
  const notes = String(value ?? "").trim();
  if (!optional && notes.length < 3) {
    throw new Error("Please provide a short explanation (at least 3 characters). ");
  }
  if (notes.length > 500) throw new Error("Notes cannot exceed 500 characters.");
  return notes || null;
}

async function lockActiveCycle(connection, groupId, cycleId) {
  const [rows] = await connection.query(
    `SELECT id FROM cycles
     WHERE id = ? AND group_id = ? AND status = 'ACTIVE'
     FOR UPDATE`,
    [cycleId, groupId],
  );
  if (!rows.length) {
    throw new Error("The selected cycle is not active for this group.");
  }
}

async function validateOpenMeeting(connection, meetingId, groupId, cycleId, { required = true } = {}) {
  if (meetingId == null || meetingId === "") {
    if (required) throw new Error("A virtual window reference is required for this cashbook entry.");
    return null;
  }
  const parsedMeetingId = parsePositiveId(meetingId, "Meeting ID");
  const [rows] = await connection.query(
    `SELECT id FROM meetings
     WHERE id = ? AND group_id = ? AND cycle_id = ? AND status IN ('OPEN','CLOSED')
     FOR UPDATE`,
    [parsedMeetingId, groupId, cycleId],
  );
  if (!rows.length) {
    throw new Error("Choose a virtual window belonging to this group and cycle.");
  }
  return parsedMeetingId;
}

// Read-only cashbook report for authenticated members of this group.
router.get(
  "/groups/:groupId/cycles/:cycleId/cashbook",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const groupId = parsePositiveId(req.params.groupId, "Group ID");
      const cycleId = parsePositiveId(req.params.cycleId, "Cycle ID");
      const report = await getCashbookReport(groupId, cycleId);
      res.status(200).json({ success: true, report });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "Failed to load the cashbook." });
    }
  },
);

// Enter a one-time starting cash balance before recording any other movement in that fund.
router.post(
  "/groups/:groupId/cycles/:cycleId/cashbook/opening-balance",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  async (req, res) => {
    let connection;
    try {
      const groupId = parsePositiveId(req.params.groupId, "Group ID");
      const cycleId = parsePositiveId(req.params.cycleId, "Cycle ID");
      const fundType = validateFundType(req.body.fundType);
      const amount = parseAmount(req.body.amount, "Opening cash amount");
      const notes = validateNotes(req.body.notes || "Opening balance carried into this cycle.", { optional: true });
      connection = await db.getConnection();
      await connection.beginTransaction();
      await lockActiveCycle(connection, groupId, cycleId);

      const [existing] = await connection.query(
        `SELECT id FROM fund_ledger_entries WHERE group_id = ? AND cycle_id = ? AND fund_type = ? LIMIT 1 FOR UPDATE`,
        [groupId, cycleId, fundType],
      );
      if (existing.length) {
        throw new Error("An opening balance can only be entered before any entries exist for this fund in the cycle. Use a documented adjustment if you are correcting migrated records.");
      }

      const ledgerEntryId = await insertLedgerEntry(connection, {
        groupId, cycleId, fundType, entryType: "OPENING_BALANCE", direction: "IN",
        amount, profitEffect: 0, notes, createdBy: req.user.id,
      });
      const receipt = await createReceipt(connection, {
        groupId, cycleId, sourceType: "LEDGER_ENTRY", sourceId: ledgerEntryId, sourceComponent: "TOTAL",
        activityType: "OPENING_BALANCE", amount, summary: `${fundType.replaceAll("_", " ")} opening cash balance`,
        details: { ledgerEntryId, fundType, notes }, issuedBy: req.user.id,
      });
      await writeAuditEvent(connection, {
        groupId, cycleId, actorUserId: req.user.id, action: "OPENING_BALANCE_RECORDED", entityType: "FUND_LEDGER_ENTRY",
        entityId: ledgerEntryId, afterData: { fundType, amount, notes, receiptNumber: receipt.receiptNumber }, ...auditMetaFor(req),
      });
      await connection.commit();
      res.status(201).json({ success: true, message: "Opening balance recorded.", receipt });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    } finally {
      if (connection) connection.release();
    }
  },
);

// Record a cash expense against the selected fund. Social-fund expenses never reduce the loan fund.
router.post(
  "/groups/:groupId/cycles/:cycleId/cashbook/expenses",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  async (req, res) => {
    let connection;
    try {
      const groupId = parsePositiveId(req.params.groupId, "Group ID");
      const cycleId = parsePositiveId(req.params.cycleId, "Cycle ID");
      const fundType = validateFundType(req.body.fundType);
      const amount = parseAmount(req.body.amount, "Expense amount");
      const notes = validateNotes(req.body.description);
      connection = await db.getConnection();
      await connection.beginTransaction();
      await lockActiveCycle(connection, groupId, cycleId);
      const meetingId = await validateOpenMeeting(connection, req.body.meetingId, groupId, cycleId, { required: false });
      await requirePreviouslyBalancedCount(connection, groupId, cycleId, fundType);
      const balance = await getBookBalance(connection, groupId, cycleId, fundType);
      if (amount > balance + 0.001) {
        throw new Error(`The Loan Fund has only ${balance.toLocaleString()} RWF in the cashbook; this expense cannot exceed the recorded balance.`);
      }

      const entryType = "FUND_EXPENSE";
      const ledgerEntryId = await insertLedgerEntry(connection, {
        groupId, cycleId, meetingId, fundType, entryType, direction: "OUT", amount,
        profitEffect: -amount,
        notes, createdBy: req.user.id,
      });
      const receipt = await createReceipt(connection, {
        groupId, cycleId, meetingId, sourceType: "LEDGER_ENTRY", sourceId: ledgerEntryId, sourceComponent: "TOTAL",
        activityType: entryType, amount, summary: `${fundType.replaceAll("_", " ")} expense`,
        details: { ledgerEntryId, fundType, description: notes }, issuedBy: req.user.id,
      });
      await writeAuditEvent(connection, {
        groupId, cycleId, meetingId, actorUserId: req.user.id, action: "CASHBOOK_EXPENSE_RECORDED", entityType: "FUND_LEDGER_ENTRY",
        entityId: ledgerEntryId, afterData: { fundType, entryType, direction: "OUT", amount, notes, receiptNumber: receipt.receiptNumber }, ...auditMetaFor(req),
      });
      await connection.commit();
      res.status(201).json({ success: true, message: "Cashbook expense recorded.", receipt });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    } finally {
      if (connection) connection.release();
    }
  },
);

// Record a documented cash correction after investigating a cash-count variance.
router.post(
  "/groups/:groupId/cycles/:cycleId/cashbook/adjustments",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  async (req, res) => {
    let connection;
    try {
      const groupId = parsePositiveId(req.params.groupId, "Group ID");
      const cycleId = parsePositiveId(req.params.cycleId, "Cycle ID");
      const fundType = validateFundType(req.body.fundType);
      const amount = parseAmount(req.body.amount, "Adjustment amount");
      const direction = String(req.body.direction || "").toUpperCase();
      if (!["IN", "OUT"].includes(direction)) throw new Error("Adjustment direction must be IN or OUT.");
      const notes = validateNotes(req.body.description);
      connection = await db.getConnection();
      await connection.beginTransaction();
      await lockActiveCycle(connection, groupId, cycleId);
      const meetingId = await validateOpenMeeting(connection, req.body.meetingId, groupId, cycleId, { required: false });
      const currentBalance = await getBookBalance(connection, groupId, cycleId, fundType);
      if (direction === "OUT" && amount > currentBalance + 0.001) {
        throw new Error("The cash adjustment cannot reduce the recorded fund balance below zero.");
      }
      const signedAmount = direction === "IN" ? amount : -amount;
      const treatment = String(req.body.accountingTreatment || "BALANCE_CORRECTION").toUpperCase();
      if (!["BALANCE_CORRECTION", "OTHER_INCOME_OR_LOSS"].includes(treatment)) {
        throw new Error("Choose a valid accounting treatment for the adjustment.");
      }
      // Corrections/transfers do not automatically become profit; only explicitly classified
      // unexplained gain/loss affects the recorded loan-fund result.
      const profitEffect = fundType === "LOAN_FUND" && treatment === "OTHER_INCOME_OR_LOSS" ? signedAmount : 0;
      const ledgerEntryId = await insertLedgerEntry(connection, {
        groupId, cycleId, meetingId, fundType, entryType: "CASH_ADJUSTMENT", direction, amount,
        profitEffect,
        notes: `Authorized cash adjustment (${treatment}): ${notes}`,
        createdBy: req.user.id,
      });
      const receipt = await createReceipt(connection, {
        groupId, cycleId, meetingId, sourceType: "LEDGER_ENTRY", sourceId: ledgerEntryId, sourceComponent: "TOTAL",
        activityType: "CASH_ADJUSTMENT", amount, summary: `${fundType.replaceAll("_", " ")} documented adjustment`,
        details: { ledgerEntryId, fundType, direction, accountingTreatment: treatment, explanation: notes }, issuedBy: req.user.id,
      });
      await writeAuditEvent(connection, {
        groupId, cycleId, meetingId, actorUserId: req.user.id, action: "CASHBOOK_ADJUSTMENT_RECORDED", entityType: "FUND_LEDGER_ENTRY",
        entityId: ledgerEntryId, reason: notes, afterData: { fundType, direction, amount, treatment, profitEffect, receiptNumber: receipt.receiptNumber }, ...auditMetaFor(req),
      });
      await connection.commit();
      res.status(201).json({ success: true, message: "Cash adjustment recorded. Recount and reconcile the fund again.", receipt });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    } finally {
      if (connection) connection.release();
    }
  },
);

// Save a physical cash count. A discrepancy is recorded, never silently posted as an adjustment.
router.post(
  "/groups/:groupId/cycles/:cycleId/cashbook/reconcile",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  async (req, res) => {
    let connection;
    try {
      const groupId = parsePositiveId(req.params.groupId, "Group ID");
      const cycleId = parsePositiveId(req.params.cycleId, "Cycle ID");
      const fundType = validateFundType(req.body.fundType);
      if (req.body.countedCash === "" || req.body.countedCash == null) throw new Error("Counted cash is required; enter 0 only if the fund has no physical cash.");
      const countedCash = parseAmount(req.body.countedCash, "Counted cash", { allowZero: true });
      const notes = validateNotes(req.body.notes, { optional: true });
      const witnessMemberId = parsePositiveId(req.body.witnessMemberId, "Witness member ID");
      connection = await db.getConnection();
      await connection.beginTransaction();
      await lockActiveCycle(connection, groupId, cycleId);
      const meetingId = await validateOpenMeeting(connection, req.body.meetingId, groupId, cycleId, { required: false });
      const [witnessRows] = await connection.query(
        `SELECT id, full_name FROM users WHERE id = ? AND group_id = ? AND COALESCE(is_active, 1) = 1 LIMIT 1 FOR UPDATE`,
        [witnessMemberId, groupId],
      );
      if (!witnessRows.length) throw new Error("The cash-count witness must be an active CORNESTONE member.");
      const bookBalance = await getBookBalance(connection, groupId, cycleId, fundType);
      const lastEntryId = await getLastLedgerEntryId(connection, groupId, cycleId, fundType);
      const variance = roundMoney(countedCash - bookBalance);

      const [reconciliationResult] = await connection.query(
        `INSERT INTO cash_reconciliations
          (group_id, cycle_id, meeting_id, fund_type, book_balance_at_count, counted_cash,
           variance, ledger_entry_id_at_count, notes, reconciled_by, witness_member_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [groupId, cycleId, meetingId, fundType, bookBalance, countedCash, variance, lastEntryId, notes, req.user.id, witnessMemberId],
      );
      await writeAuditEvent(connection, {
        groupId, cycleId, meetingId, actorUserId: req.user.id, action: "PHYSICAL_CASH_COUNT_RECORDED", entityType: "CASH_RECONCILIATION",
        entityId: reconciliationResult.insertId, afterData: { fundType, bookBalance, countedCash, variance, lastEntryId, notes, witnessMemberId }, ...auditMetaFor(req),
      });
      await connection.commit();
      res.status(201).json({
        success: true,
        message: Math.abs(variance) < 0.01
          ? "Cash count matches the cashbook."
          : `Cash count saved with a variance of ${variance.toLocaleString()} RWF. Investigate the difference; it has not been automatically adjusted.`,
        reconciliation: { fundType, bookBalance, countedCash, variance, meetingId, witnessMemberId, witnessMemberName: witnessRows[0].full_name, balanced: Math.abs(variance) < 0.01 },
      });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    } finally {
      if (connection) connection.release();
    }
  },
);

module.exports = router;
