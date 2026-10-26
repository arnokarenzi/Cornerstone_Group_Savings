const db = require("../config/db");

const FUND_TYPES = Object.freeze(["LOAN_FUND"]);

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function parsePositiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseAmount(value, label, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}.`);
  }
  const rounded = roundMoney(parsed);
  if (!Number.isFinite(rounded) || (allowZero ? rounded < 0 : rounded <= 0)) {
    throw new Error(`${label} must be a valid monetary amount.`);
  }
  return rounded;
}

function validateFundType(value) {
  const fundType = String(value || "").trim().toUpperCase();
  if (!FUND_TYPES.includes(fundType)) {
    throw new Error("CORNESTONE supports only the LOAN_FUND; Social Fund entries are disabled.");
  }
  return fundType;
}

async function insertLedgerEntry(connection, entry) {
  const amount = roundMoney(entry.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Ledger entry amount must be greater than zero.");
  }
  if (!FUND_TYPES.includes(entry.fundType)) {
    throw new Error("Invalid fund type for ledger entry.");
  }
  if (!["IN", "OUT"].includes(entry.direction)) {
    throw new Error("Ledger entry direction must be IN or OUT.");
  }

  const [result] = await connection.query(
    `INSERT INTO fund_ledger_entries
      (group_id, cycle_id, meeting_id, member_id, loan_id, fund_type, entry_type,
       direction, amount, profit_effect, notes, source_type, source_id,
       source_component, created_by, created_at, reversal_of_entry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`,
    [
      entry.groupId,
      entry.cycleId,
      entry.meetingId ?? null,
      entry.memberId ?? null,
      entry.loanId ?? null,
      entry.fundType,
      entry.entryType,
      entry.direction,
      amount,
      roundMoney(entry.profitEffect ?? 0),
      entry.notes ?? null,
      entry.sourceType ?? null,
      entry.sourceId ?? null,
      entry.sourceComponent ?? null,
      entry.createdBy ?? null,
      entry.createdAt ?? null,
      entry.reversalOfEntryId ?? null,
    ],
  );
  return result.insertId;
}

async function getBookBalance(connection, groupId, cycleId, fundType) {
  const [rows] = await connection.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0) AS book_balance
     FROM fund_ledger_entries
     WHERE group_id = ? AND cycle_id = ? AND fund_type = ?`,
    [groupId, cycleId, fundType],
  );
  return roundMoney(rows[0]?.book_balance || 0);
}

async function getLastLedgerEntryId(connection, groupId, cycleId, fundType) {
  const [rows] = await connection.query(
    `SELECT MAX(id) AS last_entry_id
     FROM fund_ledger_entries
     WHERE group_id = ? AND cycle_id = ? AND fund_type = ?`,
    [groupId, cycleId, fundType],
  );
  return rows[0]?.last_entry_id == null ? null : Number(rows[0].last_entry_id);
}

async function requirePreviouslyBalancedCount(connection, groupId, cycleId, fundType) {
  const [rows] = await connection.query(
    `SELECT variance, created_at
     FROM cash_reconciliations
     WHERE group_id = ? AND cycle_id = ? AND fund_type = ?
     ORDER BY id DESC LIMIT 1`,
    [groupId, cycleId, fundType],
  );
  if (!rows.length) {
    throw new Error(`Record a physical cash count for the Loan Fund before making a cash outflow.`);
  }
  const variance = roundMoney(rows[0].variance);
  if (Math.abs(variance) >= 0.01) {
    throw new Error(`The latest Loan Fund cash count has an unresolved variance of ${variance.toLocaleString()} RWF. Investigate, correct if justified, then count again before making another cash outflow.`);
  }
}

async function getLastReconciliation(connection, groupId, cycleId, fundType) {
  const [rows] = await connection.query(
    `SELECT r.*, u.full_name AS reconciled_by_name, witness.full_name AS witness_member_name
     FROM cash_reconciliations r
     LEFT JOIN users u ON u.id = r.reconciled_by
     LEFT JOIN users witness ON witness.id = r.witness_member_id
     WHERE r.group_id = ? AND r.cycle_id = ? AND r.fund_type = ?
     ORDER BY r.id DESC LIMIT 1`,
    [groupId, cycleId, fundType],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: Number(row.id),
    fundType: row.fund_type,
    bookBalanceAtCount: roundMoney(row.book_balance_at_count),
    countedCash: roundMoney(row.counted_cash),
    variance: roundMoney(row.variance),
    ledgerEntryIdAtCount: row.ledger_entry_id_at_count == null ? null : Number(row.ledger_entry_id_at_count),
    notes: row.notes || "",
    reconciledBy: row.reconciled_by_name || "Unknown user",
    witnessMemberId: row.witness_member_id == null ? null : Number(row.witness_member_id),
    witnessMemberName: row.witness_member_name || null,
    createdAt: row.created_at,
  };
}

async function getCashbookReport(groupId, cycleId, { connection: suppliedConnection } = {}) {
  const connection = suppliedConnection || await db.getConnection();
  const shouldRelease = !suppliedConnection;
  try {
    const [cycleRows] = await connection.query(
      `SELECT id, group_id, cycle_number, start_date, end_date, status
       FROM cycles WHERE id = ? AND group_id = ?`,
      [cycleId, groupId],
    );
    if (!cycleRows.length) {
      const error = new Error("The requested cycle does not belong to this group.");
      error.statusCode = 404;
      throw error;
    }

    const [aggregateRows] = await connection.query(
      `SELECT fund_type,
          COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0) AS book_balance,
          COALESCE(SUM(CASE WHEN entry_type = 'OPENING_BALANCE' AND direction = 'IN' THEN amount WHEN entry_type = 'OPENING_BALANCE_REVERSAL' THEN -amount ELSE 0 END), 0) AS opening_balance,
          COALESCE(SUM(CASE WHEN entry_type = 'SHARE_PURCHASE' THEN amount WHEN entry_type = 'SHARE_PURCHASE_REVERSAL' THEN -amount WHEN entry_type = 'SHARE_REDEMPTION' THEN -amount WHEN entry_type = 'SHARE_REDEMPTION_REVERSAL' THEN amount ELSE 0 END), 0) AS shares_collected,
          COALESCE(SUM(CASE WHEN entry_type = 'FINE_PAYMENT' THEN amount WHEN entry_type = 'FINE_PAYMENT_REVERSAL' THEN -amount ELSE 0 END), 0) AS fines_collected,
          COALESCE(SUM(CASE WHEN entry_type = 'LOAN_PRINCIPAL_REPAYMENT' THEN amount ELSE 0 END), 0) AS principal_repaid,
          COALESCE(SUM(CASE WHEN entry_type = 'LOAN_INTEREST_REPAYMENT' THEN amount ELSE 0 END), 0) AS interest_collected,
          COALESCE(SUM(CASE WHEN entry_type = 'LEGACY_REPAYMENT' THEN amount ELSE 0 END), 0) AS legacy_repayments,
          COALESCE(SUM(CASE WHEN entry_type = 'LOAN_DISBURSEMENT' THEN amount ELSE 0 END), 0) AS loans_disbursed,
          COALESCE(SUM(CASE WHEN entry_type = 'FUND_EXPENSE' THEN amount WHEN entry_type = 'FUND_EXPENSE_REVERSAL' THEN -amount ELSE 0 END), 0) AS loan_fund_expenses,
          COALESCE(SUM(profit_effect), 0) AS recorded_net_profit,
          COALESCE(SUM(CASE WHEN entry_type = 'LEGACY_REPAYMENT' THEN 1 ELSE 0 END), 0) AS legacy_repayment_count,
          MAX(id) AS last_entry_id
       FROM fund_ledger_entries
       WHERE group_id = ? AND cycle_id = ?
       GROUP BY fund_type`,
      [groupId, cycleId],
    );
    const aggregates = new Map(aggregateRows.map((row) => [row.fund_type, row]));

    const funds = {};
    for (const fundType of FUND_TYPES) {
      const row = aggregates.get(fundType) || {};
      const bookBalance = roundMoney(row.book_balance || 0);
      const latestReconciliation = await getLastReconciliation(connection, groupId, cycleId, fundType);
      const lastLedgerEntryId = row.last_entry_id == null ? null : Number(row.last_entry_id);
      const reconciliationCurrent = Boolean(latestReconciliation) &&
        latestReconciliation.ledgerEntryIdAtCount === lastLedgerEntryId;
      const reconciliationBalanced = Boolean(latestReconciliation) &&
        Math.abs(latestReconciliation.variance) < 0.01;

      funds[fundType] = {
        fundType,
        bookBalance,
        openingBalance: roundMoney(row.opening_balance || 0),
        sharesCollected: roundMoney(row.shares_collected || 0),
        finesCollected: roundMoney(row.fines_collected || 0),
        principalRepaid: roundMoney(row.principal_repaid || 0),
        interestCollected: roundMoney(row.interest_collected || 0),
        legacyRepayments: roundMoney(row.legacy_repayments || 0),
        loansDisbursed: roundMoney(row.loans_disbursed || 0),
        expenses: roundMoney(row.loan_fund_expenses || 0),
        recordedNetProfit: roundMoney(row.recorded_net_profit || 0),
        legacyRepaymentCount: Number(row.legacy_repayment_count || 0),
        lastLedgerEntryId,
        latestReconciliation,
        reconciliationCurrent,
        reconciliationBalanced,
        reconciliationReady: reconciliationCurrent && reconciliationBalanced,
      };
    }

    const [loanRows] = await connection.query(
      `SELECT COUNT(*) AS outstanding_loan_count,
          COALESCE(SUM(balance_remaining), 0) AS outstanding_loan_balance
       FROM loans
       WHERE group_id = ? AND cycle_id = ? AND status <> 'REPAID' AND balance_remaining > 0.009`,
      [groupId, cycleId],
    );

    const [fineRows] = await connection.query(
      `SELECT COUNT(*) AS outstanding_fine_count,
          COALESCE(SUM(amount - amount_paid), 0) AS outstanding_fine_balance
       FROM fine_assessments
       WHERE group_id = ? AND cycle_id = ? AND status IN ('OUTSTANDING','PARTIALLY_PAID')
         AND amount - amount_paid > 0.009`,
      [groupId, cycleId],
    );

    const [recentRows] = await connection.query(
      `SELECT e.id, e.fund_type, e.entry_type, e.direction, e.amount, e.profit_effect,
          e.notes, e.meeting_id, e.member_id, e.loan_id, e.created_at, e.reversal_of_entry_id,
          e.source_type, e.source_id, e.source_component,
          source_tx.status AS source_transaction_status, source_tx.type AS source_transaction_type,
          source_tx.fine_reason AS source_transaction_fine_reason,
          source_tx.shares_count AS source_transaction_shares_count,
          maker.full_name AS created_by_name, member.full_name AS member_name
       FROM fund_ledger_entries e
       LEFT JOIN users maker ON maker.id = e.created_by
       LEFT JOIN users member ON member.id = e.member_id
       LEFT JOIN transactions source_tx ON e.source_type = 'TRANSACTION' AND e.source_id = source_tx.id
       WHERE e.group_id = ? AND e.cycle_id = ?
       ORDER BY e.id DESC LIMIT 30`,
      [groupId, cycleId],
    );

    // Separate full-cycle candidate list: reversal selection must not be limited to
    // the latest 30 rows, and must exclude already-reversed entries.
    const [reversalRows] = await connection.query(
      `SELECT e.id, e.fund_type, e.entry_type, e.direction, e.amount, e.profit_effect,
          e.notes, e.meeting_id, e.member_id, e.loan_id, e.created_at, e.reversal_of_entry_id,
          e.source_type, e.source_id, e.source_component,
          source_tx.status AS source_transaction_status, source_tx.type AS source_transaction_type,
          source_tx.fine_reason AS source_transaction_fine_reason,
          source_tx.shares_count AS source_transaction_shares_count,
          maker.full_name AS created_by_name, member.full_name AS member_name
       FROM fund_ledger_entries e
       LEFT JOIN transactions source_tx ON e.source_type = 'TRANSACTION' AND e.source_id = source_tx.id
       LEFT JOIN users member ON member.id = COALESCE(e.member_id, source_tx.member_id)
       LEFT JOIN users maker ON maker.id = e.created_by
       WHERE e.group_id = ? AND e.cycle_id = ? AND e.reversal_of_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM fund_ledger_entries rev WHERE rev.reversal_of_entry_id = e.id)
         AND (
           (e.source_type = 'TRANSACTION' AND e.source_component = 'TOTAL'
             AND source_tx.status = 'POSTED' AND source_tx.type IN ('SHARE_PURCHASE','FINE_PAYMENT'))
           OR (e.source_type IS NULL AND e.loan_id IS NULL
             AND e.entry_type IN ('OPENING_BALANCE','FUND_EXPENSE','CASH_ADJUSTMENT'))
         )
       ORDER BY e.id DESC`,
      [groupId, cycleId],
    );
    const mapCashbookEntry = (row) => ({
      id: Number(row.id), fundType: row.fund_type, entryType: row.entry_type, direction: row.direction,
      amount: roundMoney(row.amount), profitEffect: roundMoney(row.profit_effect || 0), notes: row.notes || "",
      meetingId: row.meeting_id == null ? null : Number(row.meeting_id),
      memberId: row.member_id == null ? null : Number(row.member_id), loanId: row.loan_id == null ? null : Number(row.loan_id),
      reversalOfEntryId: row.reversal_of_entry_id == null ? null : Number(row.reversal_of_entry_id),
      sourceType: row.source_type || null, sourceId: row.source_id == null ? null : String(row.source_id),
      sourceComponent: row.source_component || null, sourceTransactionStatus: row.source_transaction_status || null,
      sourceTransactionType: row.source_transaction_type || null,
      sourceTransactionFineReason: row.source_transaction_fine_reason || null,
      sourceTransactionSharesCount: row.source_transaction_shares_count == null ? null : Number(row.source_transaction_shares_count),
      correctionEligible: row.reversal_of_entry_id == null && (
        (row.source_type === 'TRANSACTION' && row.source_component === 'TOTAL' && ['SHARE_PURCHASE','FINE_PAYMENT'].includes(row.source_transaction_type) && row.source_transaction_status === 'POSTED') ||
        (row.source_type == null && row.loan_id == null && ['OPENING_BALANCE','FUND_EXPENSE','CASH_ADJUSTMENT'].includes(row.entry_type))
      ),
      memberName: row.member_name || null, createdByName: row.created_by_name || "System migration", createdAt: row.created_at,
    });

    return {
      groupId: Number(groupId),
      cycle: cycleRows[0],
      funds,
      outstandingLoans: {
        count: Number(loanRows[0]?.outstanding_loan_count || 0),
        balance: roundMoney(loanRows[0]?.outstanding_loan_balance || 0),
      },
      outstandingFines: {
        count: Number(fineRows[0]?.outstanding_fine_count || 0),
        balance: roundMoney(fineRows[0]?.outstanding_fine_balance || 0),
      },
      recentEntries: recentRows.map(mapCashbookEntry),
      eligibleReversals: reversalRows.map(mapCashbookEntry),
    };
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code === "ER_NO_SUCH_TABLE") {
      const migrationError = new Error("The financial-ledger database migration has not been applied yet. Back up the database, then run backend/migrations/2026-10-18-fund-ledger-reconciliation.sql before using the cashbook.");
      migrationError.statusCode = 503;
      throw migrationError;
    }
    if (error.code === "ER_BAD_FIELD_ERROR") {
      const migrationError = new Error("The Priority 2 records, receipts and audit migration may not be applied. Back up the database, then run backend/migrations/2026-10-18-priority-2-records-receipts-audit.sql once before using these features.");
      migrationError.statusCode = 503;
      throw migrationError;
    }
    throw error;
  } finally {
    if (shouldRelease) connection.release();
  }
}

module.exports = {
  FUND_TYPES,
  parsePositiveId,
  parseAmount,
  validateFundType,
  roundMoney,
  insertLedgerEntry,
  getBookBalance,
  getLastLedgerEntryId,
  requirePreviouslyBalancedCount,
  getCashbookReport,
};
