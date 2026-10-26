const db = require("../config/db");
const { buildPassbookEvents, roundMoney } = require("./passbookHelpers");

async function getMemberPassbook(groupId, memberId, cycleId = null) {
  const parsedGroupId = Number(groupId);
  const parsedMemberId = Number(memberId);
  const parsedCycleId = cycleId == null ? null : Number(cycleId);
  if (![parsedGroupId, parsedMemberId].every((value) => Number.isSafeInteger(value) && value > 0) ||
      (parsedCycleId != null && (!Number.isSafeInteger(parsedCycleId) || parsedCycleId <= 0))) {
    const error = new Error("Valid group, member and optional cycle IDs are required.");
    error.statusCode = 400;
    throw error;
  }

  const [memberRows] = await db.query(
    `SELECT id, group_id, full_name, role, is_active, created_at
     FROM users WHERE id = ? AND group_id = ? LIMIT 1`,
    [parsedMemberId, parsedGroupId],
  );
  if (!memberRows.length) {
    const error = new Error("Member not found in this group.");
    error.statusCode = 404;
    throw error;
  }
  const [groupRows] = await db.query("SELECT id, name FROM `groups` WHERE id = ? LIMIT 1", [parsedGroupId]);
  if (!groupRows.length) {
    const error = new Error("Group not found.");
    error.statusCode = 404;
    throw error;
  }
  const [cycles] = await db.query(
    `SELECT id, cycle_number, start_date, end_date, status
     FROM cycles WHERE group_id = ? ORDER BY cycle_number DESC, id DESC`, [parsedGroupId],
  );
  if (parsedCycleId != null && !cycles.some((cycle) => Number(cycle.id) === parsedCycleId)) {
    const error = new Error("The selected cycle does not belong to this group.");
    error.statusCode = 404;
    throw error;
  }

  const queryValues = [parsedGroupId, parsedMemberId];
  let cycleFilter = "";
  if (parsedCycleId != null) {
    cycleFilter = " AND e.cycle_id = ?";
    queryValues.push(parsedCycleId);
  }
  let rows;
  try {
    [rows] = await db.query(
      `SELECT e.id, e.group_id, e.cycle_id, e.meeting_id, e.member_id, e.loan_id,
          e.fund_type, e.entry_type, e.direction, e.amount, e.profit_effect, e.notes,
          e.source_type, e.source_id, e.source_component, e.reversal_of_entry_id, e.created_at,
          c.cycle_number, m.meeting_number,
          t.id AS transaction_id, t.type AS transaction_type, t.amount AS transaction_amount,
          t.shares_count, t.fine_reason, t.status AS transaction_status, t.principal_amount AS transaction_principal_amount,
          t.interest_amount AS transaction_interest_amount, t.loan_id AS transaction_loan_id,
          t.created_at AS transaction_created_at,
          l.id AS joined_loan_id, l.principal_amount AS loan_principal_amount, l.total_interest_due AS loan_total_interest_due,
          l.total_amount_due AS loan_total_amount_due, l.balance_remaining AS loan_balance_remaining,
          l.status AS loan_status, l.due_date AS loan_due_date,
          original.entry_type AS original_entry_type, original.source_type AS original_source_type,
          original.source_id AS original_source_id, original.source_component AS original_source_component,
          original.fund_type AS original_fund_type, original.direction AS original_direction, original.amount AS original_amount,
          ot.id AS original_transaction_id, ot.type AS original_transaction_type,
          ot.amount AS original_transaction_amount, ot.shares_count AS original_shares_count,
          ot.fine_reason AS original_fine_reason, ot.status AS original_transaction_status
       FROM fund_ledger_entries e
       JOIN cycles c ON c.id = e.cycle_id
       LEFT JOIN meetings m ON m.id = e.meeting_id
       LEFT JOIN transactions t ON e.source_type = 'TRANSACTION' AND e.source_id = t.id
       LEFT JOIN loans l ON e.loan_id = l.id OR (e.source_type = 'LOAN' AND e.source_id = l.id)
       LEFT JOIN fund_ledger_entries original ON e.source_type = 'REVERSAL' AND e.source_id = original.id
       LEFT JOIN transactions ot ON original.source_type = 'TRANSACTION' AND original.source_id = ot.id
       WHERE e.group_id = ? AND e.member_id = ?${cycleFilter}
       ORDER BY e.created_at ASC, e.id ASC`,
      queryValues,
    );
  } catch (error) {
    if (error.code === "ER_NO_SUCH_TABLE" || error.code === "ER_BAD_FIELD_ERROR") {
      const migrationError = new Error("The financial-ledger and records migrations must be applied before the digital passbook can load.");
      migrationError.statusCode = 503;
      throw migrationError;
    }
    throw error;
  }

  const built = buildPassbookEvents(rows);
  const loanValues = [parsedGroupId, parsedMemberId];
  let loanCycleFilter = "";
  if (parsedCycleId != null) {
    loanCycleFilter = " AND cycle_id = ?";
    loanValues.push(parsedCycleId);
  }
  const [loanRows] = await db.query(
    `SELECT id, cycle_id, principal_amount, interest_rate, total_interest_due, total_amount_due,
        balance_remaining, due_date, status, disbursed_at
     FROM loans WHERE group_id = ? AND member_id = ?${loanCycleFilter}
     ORDER BY disbursed_at DESC, id DESC`, loanValues,
  );
  const openLoans = loanRows.filter((loan) => Number(loan.balance_remaining) > 0.009 && loan.status !== "REPAID");
  const currentLoanBalance = roundMoney(openLoans.reduce((sum, loan) => sum + Number(loan.balance_remaining || 0), 0));
  const selectedCycle = parsedCycleId == null ? null : cycles.find((cycle) => Number(cycle.id) === parsedCycleId);

  return {
    group: { id: Number(groupRows[0].id), name: groupRows[0].name },
    member: {
      id: Number(memberRows[0].id), fullName: memberRows[0].full_name,
      role: memberRows[0].role, isActive: Number(memberRows[0].is_active) === 1,
      joinedAt: memberRows[0].created_at,
    },
    cycles: cycles.map((cycle) => ({
      id: Number(cycle.id), cycleNumber: Number(cycle.cycle_number), startDate: cycle.start_date,
      endDate: cycle.end_date, status: cycle.status,
    })),
    selectedCycle: selectedCycle ? { id: Number(selectedCycle.id), cycleNumber: Number(selectedCycle.cycle_number), status: selectedCycle.status } : null,
    events: built.events,
    loans: loanRows.map((loan) => ({
      id: Number(loan.id), cycleId: Number(loan.cycle_id), principalAmount: roundMoney(loan.principal_amount),
      interestRate: Number(loan.interest_rate), totalInterestDue: roundMoney(loan.total_interest_due),
      totalAmountDue: roundMoney(loan.total_amount_due), balanceRemaining: roundMoney(loan.balance_remaining),
      dueDate: loan.due_date, status: loan.status, disbursedAt: loan.disbursed_at,
    })),
    summary: {
      ...built.summary,
      currentLoanBalance,
      outstandingLoanCount: openLoans.length,
      historicalRepaymentsWithUnknownSplit: built.summary.legacyRepayments,
      displayedPeriod: selectedCycle ? `Cycle ${selectedCycle.cycle_number}` : "All cycles",
    },
  };
}

module.exports = { getMemberPassbook };
