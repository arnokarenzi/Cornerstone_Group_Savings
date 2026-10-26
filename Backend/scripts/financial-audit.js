"use strict";

require("dotenv").config();
const db = require("../config/db");

function money(value) { return Number(Number(value || 0).toFixed(2)); }

async function main() {
  const connection = await db.getConnection();
  const blockers = [];
  const warnings = [];
  try {
    const [[group]] = await connection.query("SELECT id, name, settings FROM `groups` WHERE company_key = 'cornestone' LIMIT 1");
    if (!group) throw new Error("CORNESTONE company record is missing.");
    let settings;
    try { settings = typeof group.settings === "object" ? group.settings : JSON.parse(String(group.settings || "{}")); }
    catch { throw new Error("The CORNESTONE company settings are not valid JSON."); }
    const sharePrice = Number(settings.shareValue || 1000);
    if (!Number.isFinite(sharePrice) || sharePrice <= 0) throw new Error("The configured share price is invalid.");
    const groupId = Number(group.id);

    const [[mismatches]] = await connection.query(
      `SELECT COUNT(*) AS count FROM transactions
       WHERE group_id = ? AND type = 'SHARE_PURCHASE' AND status = 'POSTED'
         AND (share_value_at_transaction IS NULL OR ABS(amount - (shares_count * share_value_at_transaction)) > 0.009)`, [groupId],
    );
    if (Number(mismatches.count || 0)) blockers.push(`${mismatches.count} posted share purchase(s) are missing or conflict with their recorded transaction-time share price. Review before distribution.`);

    const [[overpaidPrincipal]] = await connection.query(
      `SELECT COUNT(*) AS count FROM (
         SELECT l.id, l.principal_amount, COALESCE(SUM(t.principal_amount), 0) AS principal_paid
         FROM loans l LEFT JOIN transactions t
           ON t.loan_id = l.id AND t.group_id = l.group_id AND t.cycle_id = l.cycle_id
          AND t.type = 'LOAN_REPAYMENT' AND t.status = 'POSTED'
         WHERE l.group_id = ? GROUP BY l.id, l.principal_amount
         HAVING COALESCE(SUM(t.principal_amount), 0) > l.principal_amount + 0.009
       ) violations`, [groupId],
    );
    if (Number(overpaidPrincipal.count || 0)) blockers.push(`${overpaidPrincipal.count} loan(s) show principal repayments greater than the original principal.`);

    const [[invalidLoans]] = await connection.query(
      `SELECT COUNT(*) AS count FROM loans WHERE group_id = ?
       AND (principal_amount <= 0 OR balance_remaining < -0.009 OR total_interest_due < -0.009 OR total_amount_due < -0.009)`, [groupId],
    );
    if (Number(invalidLoans.count || 0)) blockers.push(`${invalidLoans.count} loan record(s) have invalid negative or non-positive financial values.`);

    const [[statusMismatch]] = await connection.query(
      `SELECT COUNT(*) AS count FROM loans WHERE group_id = ? AND
       ((status = 'REPAID' AND balance_remaining > 0.009) OR (status = 'ACTIVE' AND balance_remaining <= 0.009))`, [groupId],
    );
    if (Number(statusMismatch.count || 0)) blockers.push(`${statusMismatch.count} loan record(s) have a status/balance mismatch. Review before accepting new transactions.`);

    const [cycles] = await connection.query(
      "SELECT id, cycle_number, status FROM cycles WHERE group_id = ? AND status IN ('ACTIVE','CLOSING') ORDER BY id", [groupId],
    );
    if (cycles.length !== 1) blockers.push(`Expected one active/closing cycle, found ${cycles.length}.`);

    const activeCycle = cycles.find((cycle) => cycle.status === "ACTIVE");
    if (activeCycle) {
      const cycleId = Number(activeCycle.id);
      const [reconciliations] = await connection.query(
        `SELECT cr.id, cr.variance, cr.ledger_entry_id_at_count, cr.fund_type,
           (SELECT MAX(e.id) FROM fund_ledger_entries e
            WHERE e.group_id = cr.group_id AND e.cycle_id = cr.cycle_id AND e.fund_type = cr.fund_type) AS latest_ledger_id
         FROM cash_reconciliations cr
         JOIN (SELECT fund_type, MAX(id) AS max_id FROM cash_reconciliations
               WHERE group_id = ? AND cycle_id = ? GROUP BY fund_type) latest ON latest.max_id = cr.id
         WHERE cr.group_id = ? AND cr.cycle_id = ?`, [groupId, cycleId, groupId, cycleId],
      );
      if (!reconciliations.length) warnings.push(`Cycle #${activeCycle.cycle_number} has no physical Loan Fund reconciliation yet; reconcile before issuing loans or closing the cycle.`);
      for (const rec of reconciliations) {
        if (Math.abs(money(rec.variance)) >= 0.01) warnings.push(`${rec.fund_type} reconciliation #${rec.id} has a ${money(rec.variance).toLocaleString()} RWF variance.`);
        if (String(rec.ledger_entry_id_at_count ?? "") !== String(rec.latest_ledger_id ?? "")) warnings.push(`${rec.fund_type} cashbook changed after reconciliation #${rec.id}; recount before issuing loans or closing the cycle.`);
      }
      const [[outstanding]] = await connection.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(balance_remaining), 0) AS balance
         FROM loans WHERE group_id = ? AND cycle_id = ? AND status = 'ACTIVE' AND balance_remaining > 0.009`, [groupId, cycleId],
      );
      if (Number(outstanding.count || 0)) warnings.push(`${outstanding.count} active loan(s) have ${money(outstanding.balance).toLocaleString()} RWF combined recorded balance. This is not automatically an error, but review all due dates and balances.`);
      const [[overdue]] = await connection.query(
        `SELECT COUNT(*) AS count FROM loans WHERE group_id = ? AND cycle_id = ?
         AND status = 'ACTIVE' AND balance_remaining > 0.009 AND due_date IS NOT NULL
         AND due_date < CURDATE()`, [groupId, cycleId],
      );
      if (Number(overdue.count || 0)) warnings.push(`${overdue.count} outstanding loan(s) are past their contractual due date and are in default from the next day under the zero-grace policy.`);
    }

    console.log(`CORNESTONE financial audit — ${new Date().toISOString()}`);
    console.log(`Company: ${group.name} (ID ${groupId}); configured share price: ${sharePrice} RWF`);
    for (const item of blockers) console.error(`BLOCKER: ${item}`);
    for (const item of warnings) console.warn(`WARNING: ${item}`);
    if (!blockers.length && !warnings.length) console.log("No automated financial consistency issues were found by these checks.");
    console.log(`\nResult: ${blockers.length} blocker(s), ${warnings.length} warning(s). This read-only report does not replace a manual reconciliation or accountant's review.`);
    if (blockers.length) process.exitCode = 2;
  } finally {
    connection.release();
    await db.end();
  }
}

main().catch(async (error) => {
  console.error(`Financial audit could not complete: ${String(error.code || "ERROR")} ${error.message || "Unknown error."}`);
  try { await db.end(); } catch { /* keep original error */ }
  process.exitCode = 1;
});
