"use strict";

const db = require("../config/db");
const { insertLedgerEntry, getBookBalance, getLastLedgerEntryId, roundMoney } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}
function money(value, label = "Amount") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than zero.`);
  return roundMoney(parsed);
}
function parseSettings(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { const result = JSON.parse(raw); return result && typeof result === "object" && !Array.isArray(result) ? result : {}; }
    catch { throw new Error("Company constitution settings contain invalid JSON."); }
  }
  return {};
}
function statusError(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; return error; }

async function lockActiveCycle(connection, groupId, cycleId) {
  const [rows] = await connection.query("SELECT id, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cycleId, groupId]);
  if (!rows.length) throw statusError("The selected cycle does not belong to CORNESTONE.", 404);
  if (rows[0].status !== "ACTIVE") throw statusError("Withdrawals can only be processed during an active savings cycle.", 409);
}

async function getSharePosition(connection, groupId, cycleId, memberId, excludeRequestId = null, lock = false) {
  if (lock) await connection.query("SELECT id FROM users WHERE id = ? AND group_id = ? FOR UPDATE", [memberId, groupId]);
  const [shareRows] = await connection.query(
    `SELECT COALESCE(SUM(CASE
       WHEN type = 'SHARE_PURCHASE' AND status = 'POSTED' THEN shares_count
       WHEN type = 'SHARE_REDEMPTION' AND status = 'POSTED' THEN -shares_count
       ELSE 0 END), 0) AS net_shares
     FROM transactions WHERE group_id = ? AND cycle_id = ? AND member_id = ?`,
    [groupId, cycleId, memberId],
  );
  const requestParams = [groupId, cycleId, memberId];
  let exclude = "";
  if (excludeRequestId != null) { exclude = " AND id <> ?"; requestParams.push(excludeRequestId); }
  const [reservedRows] = await connection.query(
    `SELECT COALESCE(SUM(shares_to_redeem), 0) AS reserved_shares
     FROM withdrawal_requests WHERE group_id = ? AND cycle_id = ? AND member_id = ?
       AND status IN ('REQUESTED','APPROVED')${exclude}${lock ? " FOR UPDATE" : ""}`,
    requestParams,
  );
  const netShares = Number(shareRows[0]?.net_shares || 0);
  const reservedShares = Number(reservedRows[0]?.reserved_shares || 0);
  return { netShares, reservedShares, availableShares: Math.max(0, netShares - reservedShares) };
}

async function requireNoPendingLoanApplications(connection, groupId, cycleId, memberId) {
  const [rows] = await connection.query(
    `SELECT id, status FROM loan_applications
     WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND status IN ('REQUESTED','APPROVED')
     ORDER BY id ASC FOR UPDATE`, [groupId, cycleId, memberId],
  );
  if (rows.length) {
    throw statusError(`Withdrawal is blocked while loan application(s) ${rows.map((row) => `#${row.id}`).join(', ')} are awaiting a decision or disbursement. Complete or reject those applications first.`, 409);
  }
}

async function requireNoOutstandingLoans(connection, groupId, cycleId, memberId) {
  const [rows] = await connection.query(
    `SELECT id, balance_remaining FROM loans
     WHERE group_id = ? AND cycle_id = ? AND member_id = ?
       AND status IN ('ACTIVE','DEFAULTED') AND balance_remaining > 0.009
     ORDER BY id ASC FOR UPDATE`,
    [groupId, cycleId, memberId],
  );
  if (rows.length) throw statusError(`Withdrawal is blocked while loan(s) ${rows.map((row) => `#${row.id}`).join(", ")} have an outstanding principal or service-charge balance. An extension does not settle the loan; repay the outstanding balance before requesting a payout.`, 409);
}

async function getGroupAndShareValue(connection, groupId) {
  const [rows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [groupId]);
  if (!rows.length) throw statusError("CORNESTONE company record was not found.", 404);
  const settings = parseSettings(rows[0].settings);
  const shareValue = Number(settings.shareValue);
  if (!Number.isFinite(shareValue) || shareValue <= 0) throw statusError("The constitutional share price is invalid.", 422);
  return { settings, shareValue: roundMoney(shareValue) };
}

async function requireCurrentBalancedCashCount(connection, groupId, cycleId) {
  const [rows] = await connection.query(
    `SELECT variance, ledger_entry_id_at_count, counted_cash
     FROM cash_reconciliations WHERE group_id = ? AND cycle_id = ? AND fund_type = 'LOAN_FUND'
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [groupId, cycleId],
  );
  if (!rows.length) throw statusError("The Loan Fund must be physically counted and reconciled before a withdrawal payout.", 409);
  const latestLedgerId = await getLastLedgerEntryId(connection, groupId, cycleId, "LOAN_FUND");
  const countedLedgerId = rows[0].ledger_entry_id_at_count == null ? null : Number(rows[0].ledger_entry_id_at_count);
  if (latestLedgerId !== countedLedgerId) throw statusError("The Loan Fund ledger has changed since its last cash count. Reconcile it again before paying this withdrawal.", 409);
  const variance = roundMoney(rows[0].variance);
  if (Math.abs(variance) >= 0.01) throw statusError(`The latest Loan Fund reconciliation has an unresolved variance of ${variance.toLocaleString()} RWF.`, 409);
  return roundMoney(rows[0].counted_cash);
}

function parseRequest(row) {
  return {
    id: Number(row.id), groupId: Number(row.group_id), cycleId: Number(row.cycle_id), memberId: Number(row.member_id),
    memberName: row.member_name || null, email: row.member_email || null,
    requestedAmount: roundMoney(row.requested_amount), shareValueAtRequest: roundMoney(row.share_value_at_request),
    sharesToRedeem: Number(row.shares_to_redeem), reason: row.reason, status: row.status,
    requestedBy: Number(row.requested_by), requestedByName: row.requested_by_name || null,
    reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by), reviewedByName: row.reviewed_by_name || null,
    reviewedAt: row.reviewed_at || null, decisionNotes: row.decision_notes || "",
    paidBy: row.paid_by == null ? null : Number(row.paid_by), paidAt: row.paid_at || null,
    transactionId: row.transaction_id == null ? null : Number(row.transaction_id),
    ledgerEntryId: row.ledger_entry_id == null ? null : Number(row.ledger_entry_id),
    receiptId: row.receipt_id == null ? null : Number(row.receipt_id), createdAt: row.created_at,
  };
}
const REQUEST_SELECT = `SELECT r.*, m.full_name AS member_name, m.email AS member_email,
  requester.full_name AS requested_by_name, reviewer.full_name AS reviewed_by_name
  FROM withdrawal_requests r JOIN users m ON m.id = r.member_id
  LEFT JOIN users requester ON requester.id = r.requested_by
  LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by`;

async function getWithdrawalRequests(groupId, cycleId, actorId, isLeader) {
  const gid = positiveId(groupId, "Group ID"), cid = positiveId(cycleId, "Cycle ID"), uid = positiveId(actorId, "User ID");
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `${REQUEST_SELECT} WHERE r.group_id = ? AND r.cycle_id = ?${isLeader ? "" : " AND r.member_id = ?"} ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
      isLeader ? [gid, cid] : [gid, cid, uid],
    );
    const result = { requests: rows.map(parseRequest) };
    // Also return the signed-in leader's own available shares. Leadership can
    // submit a personal request, but never on another member's behalf.
    const { shareValue } = await getGroupAndShareValue(connection, gid);
    const position = await getSharePosition(connection, gid, cid, uid);
    result.savings = {
      shareValue,
      netShares: position.netShares,
      reservedShares: position.reservedShares,
      availableShares: position.availableShares,
      availableFaceValue: roundMoney(position.availableShares * shareValue),
    };
    return result;
  } finally { connection.release(); }
}

async function createWithdrawalRequest({ groupId, cycleId, memberId, amount, reason, actorUserId, auditMeta = {} }) {
  const gid = positiveId(groupId, "Group ID"), cid = positiveId(cycleId, "Cycle ID"), mid = positiveId(memberId, "Member ID"), actor = positiveId(actorUserId, "Requesting user ID");
  const requestedAmount = money(amount, "Withdrawal amount");
  const why = String(reason || "").trim();
  if (why.length < 10 || why.length > 1000) throw new Error("Please give a reason between 10 and 1,000 characters.");
  if (mid !== actor) throw statusError("Members may request withdrawals only for their own account.", 403);
  const connection = await db.getConnection(); let started = false;
  try {
    await connection.beginTransaction(); started = true;
    await lockActiveCycle(connection, gid, cid);
    const { shareValue } = await getGroupAndShareValue(connection, gid);
    await requireNoOutstandingLoans(connection, gid, cid, mid);
    await requireNoPendingLoanApplications(connection, gid, cid, mid);
    const sharesToRedeem = Math.round(requestedAmount / shareValue);
    if (sharesToRedeem <= 0 || Math.abs(roundMoney(sharesToRedeem * shareValue) - requestedAmount) > 0.009) {
      throw new Error(`Withdrawals redeem whole shares at ${shareValue.toLocaleString()} RWF each. Enter a multiple of that amount.`);
    }
    const position = await getSharePosition(connection, gid, cid, mid, null, true);
    if (sharesToRedeem > position.availableShares) throw statusError(`You can request at most ${roundMoney(position.availableShares * shareValue).toLocaleString()} RWF (${position.availableShares} available unredeemed share(s)). Other open requests reserve some shares.`, 409);
    const [insert] = await connection.query(
      `INSERT INTO withdrawal_requests (group_id, cycle_id, member_id, requested_amount, share_value_at_request, shares_to_redeem, reason, status, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?)`,
      [gid, cid, mid, requestedAmount, shareValue, sharesToRedeem, why, actor],
    );
    await writeAuditEvent(connection, { groupId: gid, cycleId: cid, actorUserId: actor, action: "WITHDRAWAL_REQUESTED", entityType: "WITHDRAWAL_REQUEST", entityId: insert.insertId,
      afterData: { requestedAmount, shareValueAtRequest: shareValue, sharesToRedeem, status: "REQUESTED" }, reason: why, ...auditMeta });
    await connection.commit(); started = false;
    return { id: Number(insert.insertId), status: "REQUESTED", requestedAmount, shareValueAtRequest: shareValue, sharesToRedeem };
  } catch (error) { if (started) await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

async function decideWithdrawalRequest({ groupId, cycleId, requestId, decision, notes, actorUserId, auditMeta = {} }) {
  const gid = positiveId(groupId, "Group ID"), cid = positiveId(cycleId, "Cycle ID"), rid = positiveId(requestId, "Withdrawal request ID"), actor = positiveId(actorUserId, "Reviewer user ID");
  const action = String(decision || "").toUpperCase();
  if (!["APPROVE", "REJECT"].includes(action)) throw new Error("Decision must be APPROVE or REJECT.");
  const decisionNotes = String(notes || "").trim();
  if (action === "REJECT" && decisionNotes.length < 5) throw new Error("A rejection reason of at least 5 characters is required.");
  if (decisionNotes.length > 1000) throw new Error("Decision notes cannot exceed 1,000 characters.");
  const connection = await db.getConnection(); let started = false;
  try {
    await connection.beginTransaction(); started = true;
    await lockActiveCycle(connection, gid, cid);
    const [rows] = await connection.query("SELECT * FROM withdrawal_requests WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE", [rid, gid, cid]);
    if (!rows.length) throw statusError("Withdrawal request not found.", 404);
    const request = rows[0];
    if (Number(request.member_id) === actor || Number(request.requested_by) === actor) {
      throw statusError("A member cannot review their own withdrawal request. Another authorized committee member must make the decision.", 403);
    }
    if (request.status !== "REQUESTED") throw statusError(`This request is already ${request.status.toLowerCase()} and cannot be reviewed again.`, 409);
    if (action === "APPROVE") {
      await requireNoOutstandingLoans(connection, gid, cid, Number(request.member_id));
      await requireNoPendingLoanApplications(connection, gid, cid, Number(request.member_id));
      const position = await getSharePosition(connection, gid, cid, Number(request.member_id), rid, true);
      if (Number(request.shares_to_redeem) > position.availableShares) throw statusError("The member no longer has enough unredeemed shares because another request or transaction changed the balance.", 409);
    }
    const nextStatus = action === "APPROVE" ? "APPROVED" : "REJECTED";
    await connection.query("UPDATE withdrawal_requests SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, decision_notes = ? WHERE id = ?", [nextStatus, actor, decisionNotes || null, rid]);
    await writeAuditEvent(connection, { groupId: gid, cycleId: cid, actorUserId: actor, action: `WITHDRAWAL_${nextStatus}`, entityType: "WITHDRAWAL_REQUEST", entityId: rid,
      beforeData: { status: request.status }, afterData: { status: nextStatus, decisionNotes: decisionNotes || null }, reason: decisionNotes || `Committee ${nextStatus.toLowerCase()} the withdrawal request.`, ...auditMeta });
    await connection.commit(); started = false;
    return { id: rid, status: nextStatus };
  } catch (error) { if (started) await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

async function payWithdrawalRequest({ groupId, cycleId, requestId, actorUserId, confirmCashHandedOver, auditMeta = {} }) {
  const gid = positiveId(groupId, "Group ID"), cid = positiveId(cycleId, "Cycle ID"), rid = positiveId(requestId, "Withdrawal request ID"), actor = positiveId(actorUserId, "Payer user ID");
  if (confirmCashHandedOver !== true) throw new Error("Confirm that the approved withdrawal has actually been paid to the member.");
  const connection = await db.getConnection(); let started = false;
  try {
    await connection.beginTransaction(); started = true;
    await lockActiveCycle(connection, gid, cid);
    const [rows] = await connection.query("SELECT * FROM withdrawal_requests WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE", [rid, gid, cid]);
    if (!rows.length) throw statusError("Withdrawal request not found.", 404);
    const request = rows[0];
    if (Number(request.member_id) === actor) throw statusError("A member cannot record the payout of their own withdrawal. Another authorized committee member must pay it.", 403);
    if (request.reviewed_by != null && Number(request.reviewed_by) === actor) throw statusError("For separation of duties, the person who approved this withdrawal cannot also record its payout. Another committee member must complete payment.", 409);
    if (request.status !== "APPROVED") throw statusError("Only an approved withdrawal can be paid, and it can be paid once only.", 409);
    const memberId = Number(request.member_id);
    await requireNoOutstandingLoans(connection, gid, cid, memberId);
    await requireNoPendingLoanApplications(connection, gid, cid, memberId);
    const position = await getSharePosition(connection, gid, cid, memberId, rid, true);
    const sharesToRedeem = Number(request.shares_to_redeem);
    if (sharesToRedeem > position.availableShares) throw statusError("The member no longer has enough unredeemed shares to complete this payout.", 409);
    const amount = roundMoney(request.requested_amount);
    const countedCash = await requireCurrentBalancedCashCount(connection, gid, cid);
    const bookBalance = await getBookBalance(connection, gid, cid, "LOAN_FUND");
    if (bookBalance < amount - 0.009 || countedCash < amount - 0.009) throw statusError(`The reconciled Loan Fund has only ${Math.min(bookBalance, countedCash).toLocaleString()} RWF available, less than the approved ${amount.toLocaleString()} RWF withdrawal.`, 409);

    const [tx] = await connection.query(
      `INSERT INTO transactions (group_id, cycle_id, meeting_id, member_id, type, amount, shares_count, share_value_at_transaction, created_by, status)
       VALUES (?, ?, NULL, ?, 'SHARE_REDEMPTION', ?, ?, ?, ?, 'POSTED')`,
      [gid, cid, memberId, amount, sharesToRedeem, roundMoney(request.share_value_at_request), actor],
    );
    const ledgerEntryId = await insertLedgerEntry(connection, {
      groupId: gid, cycleId: cid, meetingId: null, memberId, fundType: "LOAN_FUND", entryType: "SHARE_REDEMPTION",
      direction: "OUT", amount, profitEffect: 0, notes: `Approved withdrawal request #${rid}; ${sharesToRedeem} share(s) redeemed.`,
      sourceType: "TRANSACTION", sourceId: tx.insertId, sourceComponent: "TOTAL", createdBy: actor,
    });
    const receipt = await createReceipt(connection, {
      groupId: gid, cycleId: cid, meetingId: null, memberId, sourceType: "TRANSACTION", sourceId: tx.insertId,
      sourceComponent: "TOTAL", activityType: "SHARE_REDEMPTION", amount,
      summary: `Approved withdrawal #${rid} paid`,
      details: { withdrawalRequestId: rid, transactionId: Number(tx.insertId), ledgerEntryId, sharesRedeemed: sharesToRedeem, shareValueAtRequest: roundMoney(request.share_value_at_request), amountPaid: amount }, issuedBy: actor,
    });
    await connection.query(
      `UPDATE withdrawal_requests SET status = 'PAID', paid_by = ?, paid_at = CURRENT_TIMESTAMP, transaction_id = ?, ledger_entry_id = ?, receipt_id = ? WHERE id = ? AND status = 'APPROVED'`,
      [actor, tx.insertId, ledgerEntryId, receipt.id, rid],
    );
    await writeAuditEvent(connection, { groupId: gid, cycleId: cid, actorUserId: actor, action: "WITHDRAWAL_PAID", entityType: "WITHDRAWAL_REQUEST", entityId: rid,
      beforeData: { status: "APPROVED" }, afterData: { status: "PAID", amountPaid: amount, sharesRedeemed: sharesToRedeem, transactionId: Number(tx.insertId), ledgerEntryId, receiptNumber: receipt.receiptNumber }, ...auditMeta });
    await connection.commit(); started = false;
    return { id: rid, status: "PAID", amountPaid: amount, sharesRedeemed: sharesToRedeem, transactionId: Number(tx.insertId), receipt };
  } catch (error) { if (started) await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

module.exports = { getWithdrawalRequests, createWithdrawalRequest, decideWithdrawalRequest, payWithdrawalRequest };
