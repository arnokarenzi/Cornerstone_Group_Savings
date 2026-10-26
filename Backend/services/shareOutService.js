const db = require("../config/db");
const { roundMoney, getCashbookReport } = require("./fundLedgerService");
const { allocateCentsByShares } = require("./payoutAllocator");

function parseSettings(rawSettings) {
  if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) return rawSettings;
  if (typeof rawSettings === "string") {
    try {
      const parsed = JSON.parse(rawSettings);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      const error = new Error("Group settings contain invalid JSON.");
      error.statusCode = 422;
      throw error;
    }
  }
  return {};
}

/**
 * Calculates a share-out preview from the saved share register and reconciled Loan Fund cash.
 * It does not treat unpaid loans as available cash. CORNESTONE has no Social Fund; only the
 * Loan Fund needs reconciliation and any legacy Social Fund entries are not used for payouts.
 */
async function calculateShareOut(groupId, cycleId) {
  const parsedGroupId = Number(groupId);
  const parsedCycleId = Number(cycleId);
  if (!Number.isSafeInteger(parsedGroupId) || parsedGroupId <= 0 || !Number.isSafeInteger(parsedCycleId) || parsedCycleId <= 0) {
    const error = new Error("A valid group ID and cycle ID are required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await db.getConnection();
  try {
    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ?", [parsedGroupId]);
    if (!groupRows.length) {
      const error = new Error("Group not found.");
      error.statusCode = 404;
      throw error;
    }
    const settings = parseSettings(groupRows[0].settings);
    const baseShareValue = Number(settings.shareValue);
    if (!Number.isFinite(baseShareValue) || baseShareValue <= 0) {
      const error = new Error("This group has an invalid share value in its settings.");
      error.statusCode = 422;
      throw error;
    }

    const [cycleRows] = await connection.query(
      "SELECT * FROM cycles WHERE id = ? AND group_id = ?",
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) {
      const error = new Error("The requested cycle does not belong to this group. Refresh and select the correct cycle.");
      error.statusCode = 404;
      throw error;
    }
    const cycle = cycleRows[0];

    const [shareRows] = await connection.query(
      `SELECT member_id,
         SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN shares_count WHEN type = 'SHARE_REDEMPTION' THEN -shares_count ELSE 0 END) AS total_shares,
         SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN amount WHEN type = 'SHARE_REDEMPTION' THEN -amount ELSE 0 END) AS net_contributions
       FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND type IN ('SHARE_PURCHASE','SHARE_REDEMPTION') AND status = 'POSTED'
       GROUP BY member_id`,
      [parsedGroupId, parsedCycleId],
    );
    const sharesMap = new Map();
    const contributionMap = new Map();
    let totalGroupShares = 0;
    let totalNetContributions = 0;
    let negativeShareBalanceCount = 0;
    let negativeContributionBalanceCount = 0;
    for (const row of shareRows) {
      const shares = Number(row.total_shares || 0);
      const contributionValue = roundMoney(row.net_contributions || 0);
      if (!Number.isFinite(shares) || shares < 0) { negativeShareBalanceCount += 1; continue; }
      if (!Number.isFinite(contributionValue) || contributionValue < -0.009) { negativeContributionBalanceCount += 1; continue; }
      sharesMap.set(Number(row.member_id), shares);
      contributionMap.set(Number(row.member_id), Math.max(0, contributionValue));
      totalGroupShares += shares;
      totalNetContributions = roundMoney(totalNetContributions + Math.max(0, contributionValue));
    }

    const [mismatchRows] = await connection.query(
      `SELECT COUNT(*) AS mismatch_count
       FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND type = 'SHARE_PURCHASE' AND status = 'POSTED'
         AND (share_value_at_transaction IS NULL OR ABS(amount - (shares_count * share_value_at_transaction)) > 0.009)`,
      [parsedGroupId, parsedCycleId],
    );
    const sharePurchaseMismatchCount = Number(mismatchRows[0]?.mismatch_count || 0);

    const [userRows] = await connection.query(
      `SELECT id, full_name, phone_number FROM users WHERE group_id = ? ORDER BY id`,
      [parsedGroupId],
    );
    const members = userRows.map((member) => {
      const memberId = Number(member.id);
      const totalShares = sharesMap.get(memberId) || 0;
      return {
        memberId,
        fullName: member.full_name,
        phoneNumber: member.phone_number || "",
        totalShares,
        savingsValue: roundMoney(contributionMap.get(memberId) || 0),
        profitShare: null,
        totalPayout: null,
      };
    });

    const cashbook = await getCashbookReport(parsedGroupId, parsedCycleId, { connection });
    const loanFund = cashbook.funds.LOAN_FUND;
    const blockingReasons = [];

    if (totalGroupShares <= 0) blockingReasons.push("No net unredeemed shares remain in this cycle.");
    if (negativeShareBalanceCount > 0) blockingReasons.push(`${negativeShareBalanceCount} member account(s) have negative net share balances. Correct these records before distribution.`);
    if (negativeContributionBalanceCount > 0) blockingReasons.push(`${negativeContributionBalanceCount} member account(s) have negative net contribution balances. Correct these records before distribution.`);
    if (sharePurchaseMismatchCount > 0) blockingReasons.push(`${sharePurchaseMismatchCount} share-purchase transaction(s) are missing or conflict with their recorded transaction-time share price. Review the historical records before distribution.`);
    if (cashbook.outstandingLoans.count > 0) {
      blockingReasons.push(`${cashbook.outstandingLoans.count} loan(s) still have ${cashbook.outstandingLoans.balance.toLocaleString()} RWF outstanding. Settle or formally resolve every outstanding loan before distribution.`);
    }
    if (cashbook.outstandingFines?.count > 0) {
      blockingReasons.push(`${cashbook.outstandingFines.count} fine assessment(s) still have ${cashbook.outstandingFines.balance.toLocaleString()} RWF outstanding. Collect or formally resolve these fines before final distribution.`);
    }
    if (!loanFund.latestReconciliation) {
      blockingReasons.push("The loan fund has not been physically counted and reconciled yet.");
    } else if (!loanFund.reconciliationCurrent) {
      blockingReasons.push("The loan-fund cashbook changed after its last physical count. Reconcile it again.");
    } else if (!loanFund.reconciliationBalanced) {
      blockingReasons.push(`The loan-fund cash count differs from the cashbook by ${loanFund.latestReconciliation.variance.toLocaleString()} RWF. Investigate and resolve the variance before distribution.`);
    }
    if (loanFund.bookBalance < -0.009) blockingReasons.push("The loan-fund book balance is negative; review missing or incorrectly classified transactions.");

    const readyForDistribution = blockingReasons.length === 0;
    const distributableCash = readyForDistribution ? loanFund.latestReconciliation.countedCash : null;
    if (readyForDistribution) {
      const payoutAmounts = allocateCentsByShares(members, totalGroupShares, distributableCash);
      for (const member of members) {
        const payout = roundMoney(payoutAmounts.get(member.memberId) || 0);
        member.totalPayout = payout;
        member.profitShare = roundMoney(payout - member.savingsValue);
      }
    }

    const totalSavingsValue = roundMoney(totalNetContributions);
    const totalInterestCollected = loanFund.interestCollected;
    const totalFinesCollected = loanFund.finesCollected;
    const totalProfitPool = loanFund.recordedNetProfit;
    const finalShareValue = readyForDistribution && totalGroupShares > 0
      ? distributableCash / totalGroupShares
      : null;

    return {
      groupId: parsedGroupId,
      cycleId: parsedCycleId,
      cycleNumber: Number(cycle.cycle_number),
      cycleStatus: cycle.status,
      readyForDistribution,
      blockingReasons,
      distributableCash,
      loanFundBookBalance: loanFund.bookBalance,
      cashbook,
      totalFundValue: readyForDistribution ? distributableCash : loanFund.bookBalance,
      totalSavingsValue,
      totalNetProfit: readyForDistribution ? roundMoney(distributableCash - totalSavingsValue) : null,
      totalShares: totalGroupShares,
      shareOutFormula: "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES",
      shareOutPolicy: String(settings.shareOutPolicy || "Reconciled net Loan Fund cash is allocated in proportion to each member’s net unredeemed shares. A member’s payout can be higher or lower than the member’s net actual contributions, reflecting the cycle’s surplus or loss. Approved mid-cycle redemptions are paid at the face value captured on the request and reduce the member’s shares for later borrowing and final share-out."),
      sharePurchaseMismatchCount,
      memberBreakdown: members,
      hasShares: totalGroupShares > 0,
      message: readyForDistribution
        ? "The Loan Fund reconciles, all loans are settled, and payouts are based on counted Loan Fund cash."
        : "This is not ready for final distribution. Resolve every item below before using payout figures.",
      totalGroupShares,
      totalInterestCollected,
      totalFinesCollected,
      totalProfitPool,
      baseShareValue: roundMoney(baseShareValue),
      finalShareValue,
      payouts: members.map((member) => ({
        memberId: member.memberId,
        fullName: member.fullName,
        phoneNumber: member.phoneNumber,
        sharesOwned: member.totalShares,
        originalInvestment: member.savingsValue,
        profitEarned: member.profitShare,
        totalPayout: member.totalPayout,
      })),
      legacyRepaymentsNeedReview: loanFund.legacyRepaymentCount > 0,
    };
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code === "ER_NO_SUCH_TABLE") {
      const wrappedError = new Error("The fund-ledger migration must be applied before calculating a reconciled share-out preview.");
      wrappedError.statusCode = 503;
      throw wrappedError;
    }
    const wrappedError = new Error(`Share-out calculation failed: ${error.message}`);
    wrappedError.statusCode = 500;
    throw wrappedError;
  } finally {
    connection.release();
  }
}

module.exports = { calculateShareOut };
