const db = require("../config/db");

/**
 * Fetch a member's financial dashboard summary (shares, savings value, active loans)
 */
async function getMemberDashboard(groupId, memberId, cycleId) {
  const connection = await db.getConnection();

  try {
    // Confirm the company exists. Savings are the actual net cash contributions
    // recorded in share purchases less paid share redemptions, not a revaluation
    // of historic transactions at today's editable share price.
    const [groupRows] = await connection.query("SELECT id FROM `groups` WHERE id = ?", [groupId]);
    if (groupRows.length === 0) throw new Error("Group not found");

    // 2. Fetch total shares for this member in the specified cycle
    const [shareRows] = await connection.query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN shares_count WHEN type = 'SHARE_REDEMPTION' THEN -shares_count ELSE 0 END), 0) AS total_shares,
          COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN amount WHEN type = 'SHARE_REDEMPTION' THEN -amount ELSE 0 END), 0) AS total_savings_value
       FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND type IN ('SHARE_PURCHASE','SHARE_REDEMPTION') AND status = 'POSTED'`,
      [groupId, cycleId, memberId],
    );
    const totalShares = Number(shareRows[0].total_shares || 0);
    const totalSavings = Number(shareRows[0].total_savings_value || 0);

    // 3. Fetch active loans for this member
    const [loanRows] = await connection.query(
      `SELECT * FROM loans WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND status = 'ACTIVE'`,
      [groupId, cycleId, memberId],
    );

    // 4. Fetch recent transactions for this member
    const [txRows] = await connection.query(
      `SELECT * FROM transactions WHERE group_id = ? AND cycle_id = ? AND member_id = ? ORDER BY created_at DESC LIMIT 10`,
      [groupId, cycleId, memberId],
    );

    connection.release();

    return {
      memberId: Number(memberId),
      cycleId: Number(cycleId),
      totalShares,
      totalSavings,
      activeLoans: loanRows,
      recentTransactions: txRows,
    };
  } catch (error) {
    connection.release();
    throw new Error(`Failed to fetch member dashboard: ${error.message}`);
  }
}

/**
 * Fetch group-level macro financial summary for a cycle
 */
async function getGroupDashboard(groupId, cycleId) {
  const connection = await db.getConnection();

  try {
    // Confirm company identity. Report total cash contributions net of redemptions
    // so changing a share price does not rewrite the historical savings value.
    const [groupRows] = await connection.query("SELECT id FROM `groups` WHERE id = ?", [groupId]);
    if (groupRows.length === 0) throw new Error("Group not found");

    const [shareRows] = await connection.query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN shares_count WHEN type = 'SHARE_REDEMPTION' THEN -shares_count ELSE 0 END), 0) AS total_shares,
        COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN amount WHEN type = 'SHARE_REDEMPTION' THEN -amount ELSE 0 END), 0) AS total_savings_value
       FROM transactions WHERE group_id = ? AND cycle_id = ? AND type IN ('SHARE_PURCHASE','SHARE_REDEMPTION') AND status = 'POSTED'`,
      [groupId, cycleId],
    );
    const totalGroupShares = Number(shareRows[0].total_shares || 0);
    const totalGroupSavings = Number(shareRows[0].total_savings_value || 0);

    // 3. Total Fines collected
    const [fineRows] = await connection.query(
      `SELECT SUM(amount) AS total_fines FROM transactions WHERE group_id = ? AND cycle_id = ? AND type = 'FINE_PAYMENT' AND status = 'POSTED'`,
      [groupId, cycleId],
    );
    const totalFines = Number(fineRows[0].total_fines || 0);

    // 4. Active Loans summary
    const [loanRows] = await connection.query(
      `SELECT COUNT(*) AS active_loans_count, SUM(balance_remaining) AS total_outstanding_balance 
       FROM loans WHERE group_id = ? AND cycle_id = ? AND status = 'ACTIVE'`,
      [groupId, cycleId],
    );

    connection.release();

    return {
      groupId: Number(groupId),
      cycleId: Number(cycleId),
      totalGroupShares,
      totalGroupSavings,
      totalFines,
      activeLoansCount: Number(loanRows[0].active_loans_count || 0),
      totalOutstandingBalance: Number(
        loanRows[0].total_outstanding_balance || 0,
      ),
    };
  } catch (error) {
    connection.release();
    throw new Error(`Failed to fetch group dashboard: ${error.message}`);
  }
}

module.exports = { getMemberDashboard, getGroupDashboard };
