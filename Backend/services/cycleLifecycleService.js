"use strict";

const db = require("../config/db");
const { calculateShareOut } = require("./shareOutService");
const { getBookBalance, getLastLedgerEntryId, insertLedgerEntry, roundMoney } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { positiveId, cashAmount, mapPayout, findOtherLiveCycle } = require("./cycleLifecycleHelpers");
const { synchronizeVirtualPaymentWindow } = require("./meetingService");
const { shareOutRatificationBlocker, assertShareOutRatified } = require("./shareOutApprovalPolicy");

function statusError(message, statusCode = 409, blockingReasons = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (blockingReasons) error.blockingReasons = blockingReasons;
  return error;
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

async function getCycleLifecycle(groupId, cycleId) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const [cycleRows] = await db.query(
    `SELECT id, group_id, cycle_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
        DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status
     FROM cycles WHERE id = ? AND group_id = ? LIMIT 1`, [cid, gid],
  );
  if (!cycleRows.length) throw statusError("The selected cycle was not found in this group.", 404);
  const cycle = cycleRows[0];
  // Synchronize calendar-derived virtual-window state before checking whether a
  // cycle can close. This closes expired windows even if nobody opened the
  // contribution screen after the three-day window elapsed.
  if (cycle.status === "ACTIVE") await synchronizeVirtualPaymentWindow(gid, cid);
  const [closureRows] = await db.query(
    `SELECT * FROM cycle_closures WHERE group_id = ? AND cycle_id = ? AND status <> 'CANCELLED' LIMIT 1`, [gid, cid],
  );
  const [openRows] = await db.query(
    `SELECT id, meeting_number, date FROM meetings
     WHERE group_id = ? AND cycle_id = ? AND status = 'OPEN'
     ORDER BY meeting_number, id`, [gid, cid],
  );
  const [lastMeetingRows] = await db.query(
    `SELECT id, meeting_number, date, status FROM meetings
     WHERE group_id = ? AND cycle_id = ? ORDER BY meeting_number DESC, id DESC LIMIT 1`, [gid, cid],
  );

  // A virtual contribution window has no physical attendance register. Any active
  // member may witness the final reconciliation; their acknowledgment is still saved.
  const [witnessRows] = await db.query(
    `SELECT id, full_name FROM users WHERE group_id = ? AND COALESCE(is_active, 1) = 1 ORDER BY full_name`, [gid],
  );

  if (closureRows.length) {
    const closure = closureRows[0];
    const [payoutRows] = await db.query(
      `SELECT p.*, u.full_name, u.phone_number
       FROM cycle_shareout_payouts p
       LEFT JOIN users u ON u.id = p.member_id
       WHERE p.group_id = ? AND p.cycle_id = ?
       ORDER BY u.full_name, p.member_id`, [gid, cid],
    );
    const balanceConnection = await db.getConnection();
    let closingLoanBookBalance;
    try {
      closingLoanBookBalance = await getBookBalance(balanceConnection, gid, cid, "LOAN_FUND");
    } finally {
      balanceConnection.release();
    }
    return {
      success: true, cycle, openMeetings: openRows,
      lastMeeting: lastMeetingRows[0] || null,
      currentBookBalances: { loanFund: closingLoanBookBalance },
      witnesses: witnessRows.map((row) => ({ id: Number(row.id), fullName: row.full_name })),
      closure: {
        id: Number(closure.id), status: closure.status,
        distributableCash: roundMoney(closure.distributable_cash),
        snapshot: parseJson(closure.snapshot_json),
        finalLoanFundCash: closure.final_loan_fund_cash == null ? null : roundMoney(closure.final_loan_fund_cash),
        nextCycleId: closure.next_cycle_id == null ? null : Number(closure.next_cycle_id),
        createdAt: closure.created_at, completedAt: closure.completed_at,
        payouts: payoutRows.map(mapPayout),
      },
      readyToPrepare: false, blockingReasons: [],
    };
  }

  if (cycle.status === "CLOSING") {
    throw statusError("This cycle is marked as closing, but its closure record is missing. Do not make manual changes; ask an administrator to inspect the database.", 503);
  }
  if (cycle.status === "COMPLETED") {
    return { success: true, cycle, openMeetings: openRows, lastMeeting: lastMeetingRows[0] || null, witnesses: [], closure: null, readyToPrepare: false, blockingReasons: ["This cycle is already completed."] };
  }

  const report = await calculateShareOut(gid, cid);
  const [currentConstitutionRows] = await db.query(
    `SELECT status, approval_method, constitution_json FROM group_constitutions
     WHERE group_id = ? AND status = 'CURRENT' ORDER BY version_number DESC LIMIT 1`, [gid],
  );
  const shareOutBlocker = shareOutRatificationBlocker(currentConstitutionRows[0] || null);
  const blockingReasons = [...(report.blockingReasons || [])];
  if (shareOutBlocker) blockingReasons.unshift(shareOutBlocker);
  if (openRows.length) blockingReasons.unshift(`Close all ${openRows.length} open meeting(s) before starting cycle share-out.`);
  return {
    success: true, cycle, report, openMeetings: openRows,
    lastMeeting: lastMeetingRows[0] || null,
    witnesses: witnessRows.map((row) => ({ id: Number(row.id), fullName: row.full_name })),
    closure: null, currentBookBalances: { loanFund: report.cashbook.funds.LOAN_FUND.bookBalance },
    readyToPrepare: blockingReasons.length === 0 && cycle.status === "ACTIVE", blockingReasons,
  };
}

async function prepareCycleClosure(groupId, cycleId, actorUserId, auditMeta = {}) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const actor = positiveId(actorUserId, "Acting user ID");
  // Bring legacy OPEN rows in line with the automatic calendar schedule before
  // the closing transaction inspects them.
  await synchronizeVirtualPaymentWindow(gid, cid, actor, auditMeta);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // Lock the group first so two cycle transitions for the same group serialize.
    const [groupRows] = await connection.query("SELECT id FROM `groups` WHERE id = ? FOR UPDATE", [gid]);
    if (!groupRows.length) throw statusError("The group was not found.", 404);
    const [cycleRows] = await connection.query(
      `SELECT id, group_id, cycle_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status FROM cycles
       WHERE id = ? AND group_id = ? FOR UPDATE`, [cid, gid],
    );
    if (!cycleRows.length) throw statusError("The selected cycle was not found in this group.", 404);
    if (cycleRows[0].status !== "ACTIVE") throw statusError("Only an active cycle can begin share-out.");
    // Lock and verify the current constitution inside the same transaction. Constitution
    // changes serialize on the group row, so this prevents an unratified formula being
    // used by the final share-out process even if the frontend is bypassed.
    const [currentConstitutionRows] = await connection.query(
      `SELECT status, approval_method, constitution_json FROM group_constitutions
       WHERE group_id = ? AND status = 'CURRENT' ORDER BY version_number DESC LIMIT 1 FOR UPDATE`, [gid],
    );
    try {
      assertShareOutRatified(currentConstitutionRows[0] || null);
    } catch (error) {
      throw statusError(error.message, error.statusCode || 409);
    }
    if (cycleRows[0].end_date) {
      const [dateRows] = await connection.query("SELECT CURDATE() AS today");
      const today = String(dateRows[0]?.today || "").slice(0, 10);
      const endDate = String(cycleRows[0].end_date).slice(0, 10);
      if (today && today < endDate) throw statusError(`This 12-month savings cycle is scheduled to end on ${endDate}. Early share-out is not permitted by the initial CORNESTONE rule.`);
    }
    const [otherLiveCycleRows] = await connection.query(
      `SELECT id, cycle_number, status FROM cycles
       WHERE group_id = ? AND id <> ? AND status IN ('ACTIVE', 'CLOSING') FOR UPDATE`, [gid, cid],
    );
    const otherLiveCycle = findOtherLiveCycle(otherLiveCycleRows, cid);
    if (otherLiveCycle) {
      throw statusError(`Cycle #${otherLiveCycle.cycle_number} is already ${otherLiveCycle.status}. Resolve that cycle before beginning another cycle's share-out.`);
    }
    const [existingClosure] = await connection.query(
      "SELECT id, status FROM cycle_closures WHERE group_id = ? AND cycle_id = ? LIMIT 1 FOR UPDATE", [gid, cid],
    );
    if (existingClosure.length && existingClosure[0].status !== "CANCELLED") throw statusError("Share-out has already been prepared for this cycle. Continue with the saved payout list.");
    if (existingClosure.length) {
      const [paidRows] = await connection.query(
        `SELECT COUNT(*) AS paid_count FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ? AND status = 'PAID'`, [gid, cid],
      );
      if (Number(paidRows[0]?.paid_count || 0) > 0) throw statusError("A cancelled share-out cannot be restarted because a payout has already been recorded.");
      const [ledgerRows] = await connection.query(
        `SELECT COUNT(*) AS payout_ledger_count FROM fund_ledger_entries WHERE group_id = ? AND cycle_id = ? AND source_type = 'CYCLE_PAYOUT'`, [gid, cid],
      );
      if (Number(ledgerRows[0]?.payout_ledger_count || 0) > 0) throw statusError("A payout ledger entry already exists. Do not restart this share-out; ask an administrator to review the cycle history.");
      await connection.query("DELETE FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ?", [gid, cid]);
    }
    const [meetingRows] = await connection.query(
      `SELECT id, meeting_number, status FROM meetings WHERE group_id = ? AND cycle_id = ? ORDER BY meeting_number, id`, [gid, cid],
    );
    const openMeetings = meetingRows.filter((meeting) => meeting.status === "OPEN");
    if (openMeetings.length) throw statusError(`Close Meeting #${openMeetings[0].meeting_number} before starting cycle share-out.`);

    const [pendingPaymentRows] = await connection.query(
      `SELECT COUNT(*) AS pending_count FROM member_payment_submissions
       WHERE group_id = ? AND cycle_id = ? AND status = 'REQUESTED'`, [gid, cid],
    );
    if (Number(pendingPaymentRows[0]?.pending_count || 0) > 0) {
      throw statusError(`There are ${Number(pendingPaymentRows[0].pending_count)} member payment submission(s) awaiting receipt confirmation or rejection. Resolve them before starting share-out.`, 409);
    }
    const [pendingLoanApplicationRows] = await connection.query(
      `SELECT COUNT(*) AS pending_count FROM loan_applications
       WHERE group_id = ? AND cycle_id = ? AND status IN ('REQUESTED','APPROVED')`, [gid, cid],
    );
    if (Number(pendingLoanApplicationRows[0]?.pending_count || 0) > 0) {
      throw statusError(`There are ${Number(pendingLoanApplicationRows[0].pending_count)} loan application(s) awaiting a committee decision or disbursement. Resolve them before starting share-out.`, 409);
    }

    // The cycle row is locked so financial write paths that lock the same row cannot
    // change balances between this readiness check and switching the cycle to CLOSING.
    const report = await calculateShareOut(gid, cid);
    if (!report.readyForDistribution) {
      throw statusError("The cycle is not ready for share-out. Resolve the listed items first.", 409, report.blockingReasons || []);
    }
    const preShareoutLoanCash = roundMoney(report.distributableCash);
    const payoutTotal = roundMoney((report.payouts || []).reduce((sum, payout) => sum + Number(payout.totalPayout || 0), 0));
    if (Math.abs(payoutTotal - preShareoutLoanCash) >= 0.01) {
      throw statusError("The member payout total does not equal the reconciled Loan Fund cash. Share-out was not prepared; review the payout calculation first.", 409);
    }
    const preShareoutSocialCash = 0;
    const snapshot = {
      cycleId: cid, cycleNumber: Number(cycleRows[0].cycle_number),
      preparedAt: new Date().toISOString(), baseShareValue: report.baseShareValue,
      totalShares: report.totalShares, totalSavingsValue: report.totalSavingsValue,
      totalNetProfit: report.totalNetProfit, finalShareValue: report.finalShareValue,
      distributableCash: preShareoutLoanCash,
      memberBreakdown: report.memberBreakdown, payouts: report.payouts,
    };
    let closureId;
    if (existingClosure.length) {
      closureId = Number(existingClosure[0].id);
      await connection.query(
        `UPDATE cycle_closures SET status = 'DISTRIBUTING', distributable_cash = ?, social_fund_cash_at_start = ?,
         snapshot_json = ?, final_loan_fund_cash = NULL, final_social_fund_cash = NULL, witness_member_id = NULL,
         next_cycle_id = NULL, created_by = ?, closed_by = NULL, created_at = CURRENT_TIMESTAMP, completed_at = NULL
         WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'CANCELLED'`,
        [preShareoutLoanCash, preShareoutSocialCash, JSON.stringify(snapshot), actor, closureId, gid, cid],
      );
    } else {
      const [closureResult] = await connection.query(
        `INSERT INTO cycle_closures
         (group_id, cycle_id, status, distributable_cash, social_fund_cash_at_start, snapshot_json, created_by)
         VALUES (?, ?, 'DISTRIBUTING', ?, ?, ?, ?)`,
        [gid, cid, preShareoutLoanCash, preShareoutSocialCash, JSON.stringify(snapshot), actor],
      );
      closureId = Number(closureResult.insertId);
    }
    for (const payout of report.payouts) {
      const amount = roundMoney(payout.totalPayout || 0);
      await connection.query(
        `INSERT INTO cycle_shareout_payouts
         (group_id, cycle_id, member_id, shares_count, savings_amount, profit_amount, payout_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [gid, cid, positiveId(payout.memberId, "Payout member ID"), Number(payout.sharesOwned || 0), roundMoney(payout.originalInvestment || 0), roundMoney(payout.profitEarned || 0), amount, amount > 0 ? "PENDING" : "NOT_PAYABLE"],
      );
    }
    await connection.query("UPDATE cycles SET status = 'CLOSING' WHERE id = ? AND group_id = ? AND status = 'ACTIVE'", [cid, gid]);
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: cid, actorUserId: actor, action: "CYCLE_SHAREOUT_PREPARED",
      entityType: "CYCLE_CLOSURE", entityId: closureId,
      beforeData: { status: "ACTIVE" }, afterData: { status: "CLOSING", distributableCash: preShareoutLoanCash, payoutCount: report.payouts.length, snapshot },
      ...auditMeta,
    });
    await connection.commit();
    return { closureId, cycleId: cid, status: "DISTRIBUTING", distributableCash: preShareoutLoanCash, payoutCount: report.payouts.length };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function recordCyclePayout(groupId, cycleId, payoutId, actorUserId, confirmedHandedOver, auditMeta = {}) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const pid = positiveId(payoutId, "Payout ID");
  const actor = positiveId(actorUserId, "Acting user ID");
  if (confirmedHandedOver !== true) throw new Error("Confirm that the full cash payout has physically been handed to the member.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [cycles] = await connection.query("SELECT id, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cid, gid]);
    if (!cycles.length || cycles[0].status !== "CLOSING") throw statusError("This cycle is not in the share-out payment stage.");
    const [closures] = await connection.query("SELECT * FROM cycle_closures WHERE group_id = ? AND cycle_id = ? FOR UPDATE", [gid, cid]);
    if (!closures.length || closures[0].status !== "DISTRIBUTING") throw statusError("The share-out payout register is not open.");
    const [payoutRows] = await connection.query(
      `SELECT p.*, u.full_name FROM cycle_shareout_payouts p
       JOIN users u ON u.id = p.member_id
       WHERE p.id = ? AND p.group_id = ? AND p.cycle_id = ? FOR UPDATE`, [pid, gid, cid],
    );
    if (!payoutRows.length) throw statusError("The selected payout was not found.", 404);
    const payout = payoutRows[0];
    if (payout.status !== "PENDING") throw statusError("This payout has already been recorded or is not payable.");
    const amount = roundMoney(payout.payout_amount);
    const available = await getBookBalance(connection, gid, cid, "LOAN_FUND");
    if (available + 0.009 < amount) throw statusError("The remaining Loan Fund ledger balance is too low for this payout. Stop and investigate; do not record a manual adjustment to bypass this check.");

    const ledgerEntryId = await insertLedgerEntry(connection, {
      groupId: gid, cycleId: cid, memberId: Number(payout.member_id), fundType: "LOAN_FUND",
      entryType: "SHARE_OUT_DISTRIBUTION", direction: "OUT", amount, profitEffect: 0,
      notes: `Cycle ${closures[0].cycle_id} share-out payment to ${payout.full_name}`,
      sourceType: "CYCLE_PAYOUT", sourceId: pid, sourceComponent: "TOTAL", createdBy: actor,
    });
    const receipt = await createReceipt(connection, {
      groupId: gid, cycleId: cid, memberId: Number(payout.member_id), sourceType: "CYCLE_PAYOUT",
      sourceId: pid, sourceComponent: "TOTAL", activityType: "SHARE_OUT_PAYOUT", amount,
      summary: `Cycle share-out payout to ${payout.full_name}`,
      details: { payoutId: pid, cycleId: cid, shares: Number(payout.shares_count), savingsAmount: roundMoney(payout.savings_amount), profitAmount: roundMoney(payout.profit_amount), cashDisbursed: amount },
      issuedBy: actor,
    });
    await connection.query(
      `UPDATE cycle_shareout_payouts SET status = 'PAID', ledger_entry_id = ?, receipt_id = ?, paid_by = ?, paid_at = CURRENT_TIMESTAMP
       WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'PENDING'`,
      [ledgerEntryId, receipt.id, actor, pid, gid, cid],
    );
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: cid, actorUserId: actor, action: "CYCLE_SHAREOUT_PAYOUT_RECORDED",
      entityType: "CYCLE_SHAREOUT_PAYOUT", entityId: pid, reason: "Leadership confirmed cash was physically handed to the member.",
      beforeData: { status: "PENDING" }, afterData: { status: "PAID", memberId: Number(payout.member_id), memberName: payout.full_name, amount, ledgerEntryId, receiptId: receipt.id }, ...auditMeta,
    });
    await connection.commit();
    return { payoutId: pid, memberId: Number(payout.member_id), memberName: payout.full_name, amount, status: "PAID", receipt };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function cancelCycleClosure(groupId, cycleId, actorUserId, reason, auditMeta = {}) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const actor = positiveId(actorUserId, "Acting user ID");
  const why = String(reason || "").trim();
  if (why.length < 5) throw new Error("Explain why share-out preparation is being cancelled (at least 5 characters).");
  if (why.length > 1000) throw new Error("The cancellation explanation cannot exceed 1,000 characters.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [cycleRows] = await connection.query("SELECT id, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cid, gid]);
    if (!cycleRows.length || cycleRows[0].status !== "CLOSING") throw statusError("This cycle is not in a share-out closing state.");
    const [closureRows] = await connection.query("SELECT * FROM cycle_closures WHERE group_id = ? AND cycle_id = ? FOR UPDATE", [gid, cid]);
    if (!closureRows.length || closureRows[0].status !== "DISTRIBUTING") throw statusError("The share-out preparation cannot be cancelled in its current state.");
    const [paidRows] = await connection.query(
      `SELECT COUNT(*) AS paid_count FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ? AND status = 'PAID'`, [gid, cid],
    );
    const [ledgerRows] = await connection.query(
      `SELECT COUNT(*) AS payout_ledger_count FROM fund_ledger_entries WHERE group_id = ? AND cycle_id = ? AND source_type = 'CYCLE_PAYOUT'`, [gid, cid],
    );
    if (Number(paidRows[0]?.paid_count || 0) > 0 || Number(ledgerRows[0]?.payout_ledger_count || 0) > 0) {
      throw statusError("Share-out preparation cannot be cancelled after any member payout has been recorded. Finish the saved payout list instead.");
    }
    await connection.query("UPDATE cycle_closures SET status = 'CANCELLED' WHERE id = ? AND status = 'DISTRIBUTING'", [Number(closureRows[0].id)]);
    await connection.query("UPDATE cycles SET status = 'ACTIVE' WHERE id = ? AND group_id = ? AND status = 'CLOSING'", [cid, gid]);
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: cid, actorUserId: actor, action: "CYCLE_SHAREOUT_PREPARATION_CANCELLED",
      entityType: "CYCLE_CLOSURE", entityId: closureRows[0].id, reason: why,
      beforeData: { cycleStatus: "CLOSING", closureStatus: "DISTRIBUTING" },
      afterData: { cycleStatus: "ACTIVE", closureStatus: "CANCELLED", noPayoutsRecorded: true }, ...auditMeta,
    });
    await connection.commit();
    return { cycleId: cid, status: "ACTIVE", message: "Share-out preparation was cancelled before any payout. The active cycle has been unlocked." };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function completeCycleAndStartNext(groupId, cycleId, input, actorUserId, auditMeta = {}) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const actor = positiveId(actorUserId, "Acting user ID");
  const finalLoanCash = cashAmount(input.finalLoanFundCash, "Final Loan Fund cash count");
  const witnessMemberId = positiveId(input.witnessMemberId, "Witness member ID");
  if (input.confirmAllPayoutsAndCounts !== true) throw new Error("Confirm that all member payouts are complete and the final Loan Fund cash count has been performed.");

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [groupRows] = await connection.query("SELECT id, settings FROM `groups` WHERE id = ? FOR UPDATE", [gid]);
    if (!groupRows.length) throw statusError("The company record was not found.", 404);
    const groupSettings = parseJson(groupRows[0].settings, {});
    const configuredDuration = Number(groupSettings.cycleDurationMonths ?? 12);
    const cycleDurationMonths = Number.isSafeInteger(configuredDuration) && configuredDuration >= 1 && configuredDuration <= 36 ? configuredDuration : 12;
    const [cycleRows] = await connection.query("SELECT * FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cid, gid]);
    if (!cycleRows.length || cycleRows[0].status !== "CLOSING") throw statusError("The selected cycle is not waiting for share-out completion.");
    const [otherLiveCycleRows] = await connection.query(
      `SELECT id, cycle_number, status FROM cycles WHERE group_id = ? AND id <> ? AND status IN ('ACTIVE', 'CLOSING') FOR UPDATE`, [gid, cid],
    );
    const otherLiveCycle = findOtherLiveCycle(otherLiveCycleRows, cid);
    if (otherLiveCycle) throw statusError(`Cycle #${otherLiveCycle.cycle_number} is already ${otherLiveCycle.status}. Resolve it before starting another cycle.`);
    const [closureRows] = await connection.query("SELECT * FROM cycle_closures WHERE group_id = ? AND cycle_id = ? FOR UPDATE", [gid, cid]);
    if (!closureRows.length || closureRows[0].status !== "DISTRIBUTING") throw statusError("The share-out register is not ready to be completed.");
    const closure = closureRows[0];
    const [pendingRows] = await connection.query(
      `SELECT COUNT(*) AS pending_count FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ? AND status = 'PENDING'`, [gid, cid],
    );
    if (Number(pendingRows[0]?.pending_count || 0) > 0) throw statusError(`${Number(pendingRows[0].pending_count)} member payout(s) remain unrecorded. Record every payout before completing the cycle.`);
    const [witnessRows] = await connection.query(
      `SELECT id, full_name FROM users WHERE id = ? AND group_id = ? AND COALESCE(is_active, 1) = 1 LIMIT 1 FOR UPDATE`,
      [witnessMemberId, gid],
    );
    if (!witnessRows.length) throw statusError("Choose an active CORNESTONE member to witness the final cash-count record.");

    const loanBookBalance = await getBookBalance(connection, gid, cid, "LOAN_FUND");
    const [payoutTotalRows] = await connection.query(
      `SELECT COALESCE(SUM(payout_amount), 0) AS payout_total FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ?`, [gid, cid],
    );
    if (Math.abs(roundMoney(payoutTotalRows[0]?.payout_total || 0) - roundMoney(closure.distributable_cash)) >= 0.01) {
      throw statusError("The member payout register does not add up to the frozen share-out amount. Do not close the cycle; ask leadership to review the payout register.");
    }
    if (loanBookBalance > 0.009) throw statusError(`The Loan Fund still has ${loanBookBalance.toLocaleString()} RWF after payouts. Distribute or formally resolve the remainder before starting the next cycle.`);
    if (loanBookBalance < -0.009) throw statusError("The Loan Fund has a negative closing balance. Correct the underlying records before completing the cycle.");
    const loanVariance = roundMoney(finalLoanCash - loanBookBalance);
    if (Math.abs(loanVariance) >= 0.01) throw statusError(`The final Loan Fund cash count differs from the post-payout cashbook by ${loanVariance.toLocaleString()} RWF. Investigate and reconcile before starting another cycle.`);

    const loanLastEntry = await getLastLedgerEntryId(connection, gid, cid, "LOAN_FUND");
    const [lastMeetingRows] = await connection.query(
      `SELECT id FROM meetings WHERE group_id = ? AND cycle_id = ? ORDER BY meeting_number DESC, id DESC LIMIT 1`, [gid, cid],
    );
    const finalMeetingId = lastMeetingRows.length ? Number(lastMeetingRows[0].id) : null;
    await connection.query(
      `INSERT INTO cash_reconciliations
       (group_id, cycle_id, meeting_id, fund_type, book_balance_at_count, counted_cash, variance,
        ledger_entry_id_at_count, notes, reconciled_by, witness_member_id)
       VALUES (?, ?, ?, 'LOAN_FUND', ?, ?, ?, ?, ?, ?, ?)`,
      [gid, cid, finalMeetingId, loanBookBalance, finalLoanCash, loanVariance, loanLastEntry,
        "Final Loan Fund count recorded during virtual cycle closure after all share-out payouts.", actor, witnessMemberId],
    );

    const [maxRows] = await connection.query("SELECT COALESCE(MAX(cycle_number), 0) AS max_cycle_number FROM cycles WHERE group_id = ?", [gid]);
    const nextCycleNumber = Number(maxRows[0]?.max_cycle_number || 0) + 1;
    await connection.query("UPDATE cycles SET status = 'COMPLETED', end_date = CURDATE() WHERE id = ? AND group_id = ? AND status = 'CLOSING'", [cid, gid]);
    const [nextCycleResult] = await connection.query(
      `INSERT INTO cycles (group_id, cycle_number, start_date, end_date, status)
       VALUES (?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL ${cycleDurationMonths} MONTH), 'ACTIVE')`, [gid, nextCycleNumber],
    );
    const nextCycleId = Number(nextCycleResult.insertId);
    const [nextCycleRows] = await connection.query("SELECT id, cycle_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status FROM cycles WHERE id = ? AND group_id = ?", [nextCycleId, gid]);
    const nextCycleRow = nextCycleRows[0];
    const startDate = String(nextCycleRow.start_date).slice(0, 10);
    await connection.query(
      `UPDATE cycle_closures SET status = 'COMPLETED', final_loan_fund_cash = ?, final_social_fund_cash = 0,
       social_fund_cash_at_start = 0, witness_member_id = ?, next_cycle_id = ?, closed_by = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'DISTRIBUTING'`,
      [finalLoanCash, witnessMemberId, nextCycleId, actor, Number(closure.id), gid, cid],
    );
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: cid, actorUserId: actor, action: "CYCLE_COMPLETED_AND_NEXT_CYCLE_STARTED",
      entityType: "CYCLE_CLOSURE", entityId: closure.id,
      reason: "All share-out payouts were recorded and the final Loan Fund count matched the ledger. CORNESTONE has no Social Fund.",
      beforeData: { cycleStatus: "CLOSING", closureStatus: "DISTRIBUTING" },
      afterData: { cycleStatus: "COMPLETED", finalLoanFundCash: finalLoanCash, witnessMemberId, nextCycle: { id: nextCycleId, cycleNumber: nextCycleNumber, startDate } },
      ...auditMeta,
    });
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: nextCycleId, actorUserId: actor, action: "NEXT_CYCLE_CREATED", entityType: "CYCLE", entityId: nextCycleId,
      afterData: { cycleNumber: nextCycleNumber, startDate, status: "ACTIVE", carriedFromCycleId: cid }, ...auditMeta,
    });
    await connection.commit();
    return {
      completedCycle: { id: cid, cycleNumber: Number(cycleRows[0].cycle_number), status: "COMPLETED" },
      nextCycle: { id: nextCycleId, cycle_number: nextCycleNumber, start_date: startDate, end_date: nextCycleRow.end_date, status: "ACTIVE" },
      finalCounts: { loanFund: finalLoanCash }, witnessName: witnessRows[0].full_name,
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally { connection.release(); }
}

module.exports = { getCycleLifecycle, prepareCycleClosure, recordCyclePayout, cancelCycleClosure, completeCycleAndStartNext };
