"use strict";

const db = require("../config/db");
const { issueLoan, getOutstandingLoans } = require("./loanService");
const { calculateBorrowingCapacity } = require("./loanEligibilityMath");
const { writeAuditEvent } = require("./auditService");
const { DEFAULT_LOAN_DEFAULT_GRACE_DAYS, PAYMENT_POLICY_TIME_ZONE, getTodayIsoInTimeZone, isLoanPastGracePeriod, addCalendarDays } = require("./loanDefaultPolicy");

function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; return error; }
function id(value, label) { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw fail(`${label} must be a positive integer.`); return n; }
function money(value, label) { const n = Number(value); if (!Number.isFinite(n) || n <= 0 || n > 9999999999.99) throw fail(`${label} must be greater than zero and within the supported limit.`); return Math.round((n + Number.EPSILON) * 100) / 100; }
function parseSettings(raw) { if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw; try { const value = JSON.parse(String(raw || "{}")); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { throw fail("Company constitution settings contain invalid JSON.", 500); } }
function auditMeta(input = {}) { return { ipAddress: input.ipAddress || null, userAgent: input.userAgent || null }; }
const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];

async function getBorrowingSnapshot(connection, groupId, cycleId, memberId, excludeApplicationId = null, lockMember = false) {
  const [cycleRows] = await connection.query(`SELECT id, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE`, [cycleId, groupId]);
  if (!cycleRows.length) throw fail("The selected cycle does not belong to CORNESTONE.", 404);
  if (cycleRows[0].status !== "ACTIVE") throw fail("Loan applications are available only during an active savings cycle.", 409);
  const [memberRows] = await connection.query(
    `SELECT id FROM users WHERE id = ? AND group_id = ? AND is_active = 1 AND approval_status = 'APPROVED' AND email_verified_at IS NOT NULL ${lockMember ? "FOR UPDATE" : ""}`,
    [memberId, groupId],
  );
  if (!memberRows.length) throw fail("Only active, approved members with verified email can request a loan.", 403);
  const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [groupId]);
  if (!groupRows.length) throw fail("CORNESTONE company record was not found.", 404);
  const settings = parseSettings(groupRows[0].settings);
  const loanRatioLimit = Number(settings.loanRatioLimit);
  const shareValue = Number(settings.shareValue);
  const configuredMaxLoanTermDays = settings.maxLoanTermDays ?? (Number(settings.maxLoanDurationMonths) > 0 ? Number(settings.maxLoanDurationMonths) * 30 : undefined);
  const maxLoanTermDays = Number(configuredMaxLoanTermDays);
  const interestRate = Number(settings.interestRate ?? settings.monthlyInterestRate);
  const interestPeriodDays = Number(settings.interestPeriodDays);
  const interestMethod = String(settings.interestMethod || "").toUpperCase();
  const maxSharesPerWindow = Number(settings.maxSharesPerMeeting ?? settings.maxSharesPerWindow);
  if (!Number.isFinite(loanRatioLimit) || loanRatioLimit <= 0 || !Number.isFinite(shareValue) || shareValue <= 0 || !Number.isSafeInteger(maxLoanTermDays) || maxLoanTermDays <= 0 || maxLoanTermDays > 3660 || !Number.isFinite(interestRate) || interestRate < 0 || interestRate > 1 || !Number.isSafeInteger(interestPeriodDays) || interestPeriodDays <= 0 || interestPeriodDays > 3660 || interestMethod !== "FLAT_PER_PERIOD" || !Number.isSafeInteger(maxSharesPerWindow) || maxSharesPerWindow < 0) {
    throw fail("The active Constitution & Rules loan settings are missing or invalid. Reload or repair the approved constitution before accepting loan applications.", 422);
  }
  const [shareRows] = await connection.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN amount WHEN type = 'SHARE_REDEMPTION' THEN -amount ELSE 0 END),0) AS savings_value,
       COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN shares_count WHEN type = 'SHARE_REDEMPTION' THEN -shares_count ELSE 0 END),0) AS net_shares
     FROM transactions WHERE group_id = ? AND cycle_id = ? AND member_id = ?
       AND type IN ('SHARE_PURCHASE','SHARE_REDEMPTION') AND status = 'POSTED'`, [groupId, cycleId, memberId],
  );
  const eligibleSavings = Math.max(0, Math.round((Number(shareRows[0]?.savings_value || 0) + Number.EPSILON) * 100) / 100);
  const netShares = Math.max(0, Number(shareRows[0]?.net_shares || 0));
  const [principalRows] = await connection.query(
    `SELECT COALESCE(SUM(GREATEST(l.principal_amount - COALESCE(p.principal_paid,0),0)),0) AS outstanding_principal
     FROM loans l LEFT JOIN (
       SELECT loan_id, SUM(COALESCE(principal_amount,0)) AS principal_paid FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND type = 'LOAN_REPAYMENT' AND status = 'POSTED' GROUP BY loan_id
     ) p ON p.loan_id = l.id
     WHERE l.group_id = ? AND l.cycle_id = ? AND l.member_id = ? AND l.status NOT IN ('REPAID','CANCELLED') AND l.principal_amount > 0`,
    [groupId, cycleId, groupId, cycleId, memberId],
  );
  const outstandingPrincipal = Math.max(0, Math.round((Number(principalRows[0]?.outstanding_principal || 0) + Number.EPSILON) * 100) / 100);
  const [openWithdrawalRows] = await connection.query(
    `SELECT id FROM withdrawal_requests WHERE group_id = ? AND cycle_id = ? AND member_id = ?
     AND status IN ('REQUESTED','APPROVED') ORDER BY id ASC FOR UPDATE`, [groupId, cycleId, memberId],
  );
  const openWithdrawalRequests = openWithdrawalRows.length;
  const { grossBorrowingLimit } = calculateBorrowingCapacity({ eligibleSavings, loanRatioLimit });
  const applicationParams = [groupId, cycleId, memberId];
  let exclude = "";
  if (excludeApplicationId != null) { exclude = " AND id <> ?"; applicationParams.push(Number(excludeApplicationId)); }
  const [reservedRows] = await connection.query(
    `SELECT COALESCE(SUM(requested_principal),0) AS reserved FROM loan_applications
     WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND status IN ('REQUESTED','APPROVED')${exclude} FOR UPDATE`, applicationParams,
  );
  const reservedApplications = Math.max(0, Number(reservedRows[0]?.reserved || 0));
  const [defaultRows] = await connection.query(
    `SELECT id, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date_iso FROM loans
     WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND status IN ('ACTIVE','DEFAULTED') AND balance_remaining > 0.009 AND due_date IS NOT NULL
     ORDER BY due_date ASC, id ASC FOR UPDATE`, [groupId, cycleId, memberId],
  );
  const today = getTodayIsoInTimeZone(new Date(), PAYMENT_POLICY_TIME_ZONE);
  const overdueLoan = defaultRows.find((loan) => isLoanPastGracePeriod(String(loan.due_date_iso), today, DEFAULT_LOAN_DEFAULT_GRACE_DAYS));
  const outstandingLoans = await getOutstandingLoans(groupId, cycleId, memberId, connection);
  const borrowingCapacity = calculateBorrowingCapacity({ eligibleSavings, loanRatioLimit, outstandingPrincipal, reservedApplications });
  const availableBorrowing = openWithdrawalRequests > 0 ? 0 : borrowingCapacity.availableBorrowing;
  return { groupId, cycleId, memberId, settings, shareValue, loanRatioLimit, interestRate, interestPeriodDays, interestMethod, maxLoanTermDays, maxSharesPerWindow, eligibleSavings, netShares,
    grossBorrowingLimit, outstandingPrincipal, reservedApplications, openWithdrawalRequests, availableBorrowing,
    defaultedLoan: overdueLoan ? { id: Number(overdueLoan.id), dueDate: overdueLoan.due_date_iso, defaultStarts: addCalendarDays(String(overdueLoan.due_date_iso), DEFAULT_LOAN_DEFAULT_GRACE_DAYS + 1) } : null,
    outstandingLoans: outstandingLoans.map((loan) => ({ id: Number(loan.loanId), loanId: Number(loan.loanId), principalAmount: Number(loan.principalAmount), balanceRemaining: Number(loan.balanceRemaining), dueDate: loan.dueDate, totalInterestDue: Number(loan.totalInterestDue), totalAmountDue: Number(loan.totalAmountDue), status: loan.status })) };
}

async function getLoanEligibility({ groupId, cycleId, memberId }) {
  const connection = await db.getConnection();
  try {
    const snapshot = await getBorrowingSnapshot(connection, id(groupId, "Group ID"), id(cycleId, "Cycle ID"), id(memberId, "Member ID"));
    return { ...snapshot, canApply: !snapshot.defaultedLoan && snapshot.openWithdrawalRequests === 0 && snapshot.availableBorrowing > 0 };
  } finally { connection.release(); }
}

async function listLoanApplications({ groupId, cycleId, userId, isLeader }) {
  const values = [id(groupId, "Group ID"), id(cycleId, "Cycle ID")];
  const scope = isLeader ? "" : " AND a.member_id = ?";
  if (!isLeader) values.push(id(userId, "User ID"));
  const [rows] = await db.query(
    `SELECT a.id, a.group_id AS groupId, a.cycle_id AS cycleId, a.member_id AS memberId, u.full_name AS memberName,
       a.requested_principal AS requestedPrincipal, a.requested_term_days AS requestedTermDays, a.reason, a.status,
       a.requested_by AS requestedBy, a.reviewed_by AS reviewedBy, reviewer.full_name AS reviewerName,
       a.reviewed_at AS reviewedAt, a.decision_notes AS decisionNotes, a.loan_id AS loanId,
       a.disbursed_by AS disbursedBy, disburser.full_name AS disburserName, a.disbursed_at AS disbursedAt, a.created_at AS createdAt
     FROM loan_applications a JOIN users u ON u.id = a.member_id
     LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by LEFT JOIN users disburser ON disburser.id = a.disbursed_by
     WHERE a.group_id = ? AND a.cycle_id = ?${scope}
     ORDER BY CASE a.status WHEN 'REQUESTED' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'DISBURSED' THEN 2 ELSE 3 END, a.created_at DESC`, values,
  );
  return rows.map((row) => ({ ...row, id: Number(row.id), groupId: Number(row.groupId), cycleId: Number(row.cycleId), memberId: Number(row.memberId),
    requestedPrincipal: Number(row.requestedPrincipal), requestedTermDays: Number(row.requestedTermDays), requestedBy: Number(row.requestedBy),
    reviewedBy: row.reviewedBy == null ? null : Number(row.reviewedBy), loanId: row.loanId == null ? null : Number(row.loanId),
    disbursedBy: row.disbursedBy == null ? null : Number(row.disbursedBy) }));
}

async function createLoanApplication({ groupId, cycleId, memberId, requestedPrincipal, requestedTermDays, reason, audit = {} }) {
  const gid = id(groupId, "Group ID"); const cid = id(cycleId, "Cycle ID"); const mid = id(memberId, "Member ID");
  const principal = money(requestedPrincipal, "Requested principal");
  const termDays = Number(requestedTermDays);
  const cleanReason = String(reason || "").trim();
  if (!Number.isSafeInteger(termDays) || termDays < 1 || termDays > 3660) throw fail("Requested repayment term must be a whole number of days within the supported 3,660-day range.");
  if (cleanReason.length < 10 || cleanReason.length > 1000) throw fail("Loan reason must be between 10 and 1,000 characters.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const snapshot = await getBorrowingSnapshot(connection, gid, cid, mid, null, true);
    if (snapshot.openWithdrawalRequests > 0) throw fail("Loan applications are paused while you have a pending or approved withdrawal request. Complete or reject the withdrawal request first so savings and borrowing limits remain consistent.", 409);
    if (snapshot.defaultedLoan) throw fail(`Loan #${snapshot.defaultedLoan.id} is in default from ${snapshot.defaultedLoan.defaultStarts}. Repay it or obtain an approved restructuring before requesting another loan.`, 409);
    if (termDays > snapshot.maxLoanTermDays) throw fail(`The active constitution allows a maximum initial loan term of ${snapshot.maxLoanTermDays} days.`);
    if (principal > snapshot.availableBorrowing + 0.009) throw fail(`The request exceeds your current available borrowing capacity of ${snapshot.availableBorrowing.toLocaleString()} RWF. This figure accounts for eligible savings, outstanding principal, and pending loan applications.`, 409);
    const [inserted] = await connection.query(
      `INSERT INTO loan_applications (group_id, cycle_id, member_id, requested_principal, requested_term_days, reason, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [gid, cid, mid, principal, termDays, cleanReason, mid],
    );
    await writeAuditEvent(connection, { groupId: gid, cycleId: cid, actorUserId: mid, action: "LOAN_APPLICATION_SUBMITTED", entityType: "LOAN_APPLICATION", entityId: inserted.insertId,
      afterData: { requestedPrincipal: principal, requestedTermDays: termDays, reason: cleanReason, availableBorrowingBeforeRequest: snapshot.availableBorrowing }, ...auditMeta(audit) });
    await connection.commit();
    return { id: Number(inserted.insertId), groupId: gid, cycleId: cid, memberId: mid, requestedPrincipal: principal, requestedTermDays: termDays, reason: cleanReason, status: "REQUESTED" };
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

async function decideLoanApplication({ groupId, applicationId, actorUserId, decision, notes, audit = {} }) {
  const gid = id(groupId, "Group ID"); const appId = id(applicationId, "Loan application ID"); const actorId = id(actorUserId, "Reviewer ID");
  const normalized = String(decision || "").trim().toUpperCase();
  const cleanNotes = String(notes || "").trim().slice(0, 1000);
  if (!["APPROVE", "REJECT"].includes(normalized)) throw fail("Decision must be APPROVE or REJECT.");
  if (normalized === "REJECT" && cleanNotes.length < 5) throw fail("Provide a rejection reason of at least five characters.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT * FROM loan_applications WHERE id = ? AND group_id = ? FOR UPDATE", [appId, gid]);
    if (!rows.length) throw fail("Loan application not found.", 404);
    const app = rows[0];
    if (Number(app.member_id) === actorId) throw fail("You cannot approve or reject your own loan application.", 403);
    if (app.status !== "REQUESTED") throw fail("Only a pending loan application can be decided.", 409);
    if (normalized === "APPROVE") {
      const snapshot = await getBorrowingSnapshot(connection, gid, Number(app.cycle_id), Number(app.member_id), appId, true);
      if (snapshot.openWithdrawalRequests > 0) throw fail("This loan cannot be approved while the member has a pending or approved withdrawal request. Resolve the withdrawal first.", 409);
      if (snapshot.defaultedLoan) throw fail(`The member has defaulted loan #${snapshot.defaultedLoan.id}; resolve or restructure it before approving another loan.`, 409);
      if (Number(app.requested_principal) > snapshot.availableBorrowing + 0.009) throw fail(`The member's remaining eligible borrowing capacity is ${snapshot.availableBorrowing.toLocaleString()} RWF, below this request. Reject it or ask the member to submit a smaller amount.`, 409);
      if (Number(app.requested_term_days) > snapshot.maxLoanTermDays) throw fail("The requested term exceeds the current constitutional maximum.", 409);
    }
    const nextStatus = normalized === "APPROVE" ? "APPROVED" : "REJECTED";
    await connection.query(
      `UPDATE loan_applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, decision_notes = ? WHERE id = ? AND status = 'REQUESTED'`,
      [nextStatus, actorId, cleanNotes || null, appId],
    );
    await writeAuditEvent(connection, { groupId: gid, cycleId: Number(app.cycle_id), actorUserId: actorId, action: `LOAN_APPLICATION_${nextStatus}`, entityType: "LOAN_APPLICATION", entityId: appId,
      beforeData: { status: app.status }, afterData: { status: nextStatus, requestedPrincipal: Number(app.requested_principal), requestedTermDays: Number(app.requested_term_days), notes: cleanNotes || null }, ...auditMeta(audit) });
    await connection.commit();
    return { id: appId, status: nextStatus, decisionNotes: cleanNotes || null };
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

async function disburseLoanApplication({ groupId, applicationId, actorUserId, audit = {} }) {
  const gid = id(groupId, "Group ID"); const appId = id(applicationId, "Loan application ID"); const actorId = id(actorUserId, "Disbursement actor ID");
  const [rows] = await db.query(
    `SELECT id, group_id, cycle_id, member_id, requested_principal, requested_term_days, status, requested_by
     FROM loan_applications WHERE id = ? AND group_id = ? LIMIT 1`, [appId, gid],
  );
  if (!rows.length) throw fail("Loan application not found.", 404);
  const app = rows[0];
  if (app.status !== "APPROVED") throw fail("Only an approved loan application can be disbursed.", 409);
  if (Number(app.member_id) === actorId) throw fail("A borrower cannot disburse their own loan.", 403);
  const loan = await issueLoan(gid, Number(app.cycle_id), Number(app.member_id), Number(app.requested_principal), null, actorId, auditMeta(audit), {
    applicationId: appId, termDays: Number(app.requested_term_days),
  });
  return { ...loan, applicationId: appId, applicationStatus: "DISBURSED" };
}

module.exports = { getLoanEligibility, listLoanApplications, createLoanApplication, decideLoanApplication, disburseLoanApplication, getBorrowingSnapshot, LEADERSHIP_ROLES };
