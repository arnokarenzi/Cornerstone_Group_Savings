"use strict";

const db = require("../config/db");
const { synchronizeVirtualPaymentWindow } = require("./meetingService");
const { insertLedgerEntry } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { repayLoan, getOutstandingLoans } = require("./loanService");
const { getVirtualPaymentWindowStatus, DEFAULT_TIME_ZONE } = require("./virtualPaymentWindow");
const { getOutstandingFines } = require("./fineService");
const { validatePaymentPurpose } = require("./memberPaymentRules");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; return error; }
function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw fail(`${label} must be a positive integer.`);
  return parsed;
}
function positiveMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 9999999999.99) throw fail("Payment amount must be greater than zero and within the supported limit.");
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}
function parseSettings(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(String(value || "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { throw fail("Company constitution settings contain invalid JSON.", 500); }
}
function auditMeta(input = {}) { return { ipAddress: input.ipAddress || null, userAgent: input.userAgent || null }; }

async function requireActiveCycle(connection, groupId, cycleId, lock = false) {
  const [rows] = await connection.query(
    `SELECT id, start_date, status FROM cycles WHERE id = ? AND group_id = ? ${lock ? "FOR UPDATE" : ""}`,
    [cycleId, groupId],
  );
  if (!rows.length) throw fail("The selected cycle does not belong to CORNESTONE.", 404);
  if (rows[0].status !== "ACTIVE") throw fail("This financial action is available only during an active savings cycle.", 409);
  return rows[0];
}

async function getPaymentRecipients(groupId) {
  const [rows] = await db.query(
    `SELECT id, full_name, role FROM users
     WHERE group_id = ? AND is_active = 1 AND approval_status = 'APPROVED'
       AND email_verified_at IS NOT NULL AND role IN ('TREASURER','SECRETARY','CHAIRPERSON','ADMIN')
     ORDER BY full_name, id`, [positiveId(groupId, "Group ID")],
  );
  return rows.map((row) => ({ id: Number(row.id), fullName: row.full_name, role: row.role }));
}

async function createMemberPaymentSubmission(input) {
  const groupId = positiveId(input.groupId, "Group ID");
  const cycleId = positiveId(input.cycleId, "Cycle ID");
  const memberId = positiveId(input.memberId, "Member ID");
  const recipientId = positiveId(input.intendedRecipientUserId, "Committee recipient");
  const rawPurpose = String(input.purpose || "").trim().toUpperCase();
  const paymentMethod = String(input.paymentMethod || "").trim().toUpperCase();
  const amount = positiveMoney(input.amount);
  const notes = String(input.notes || "").trim();
  const transferReference = String(input.transferReference || "").trim().toUpperCase().slice(0, 150) || null;
  const loanId = input.loanId == null || input.loanId === "" ? null : positiveId(input.loanId, "Loan ID");
  const fineAssessmentId = input.fineAssessmentId == null || input.fineAssessmentId === "" ? null : positiveId(input.fineAssessmentId, "Fine assessment ID");
  const purpose = validatePaymentPurpose(rawPurpose, loanId, fineAssessmentId);
  if (!["CASH_TO_COMMITTEE", "BANK_TRANSFER", "OTHER_MANUAL"].includes(paymentMethod)) throw fail("Choose a supported manual payment method.");
  if (notes.length < 5 || notes.length > 1000) throw fail("Payment details must be between 5 and 1,000 characters.");
  if (paymentMethod === "BANK_TRANSFER" && (!transferReference || transferReference.length < 4)) throw fail("A bank transfer reference of at least four characters is required.");
  if (recipientId === memberId) throw fail("You cannot assign yourself as the committee recipient for your own payment.");

  // Synchronize the calendar-based virtual window before opening the submission transaction.
  let meetingId = null;
  if (purpose === "SHARE_PURCHASE") {
    const window = await synchronizeVirtualPaymentWindow(groupId, cycleId, memberId, auditMeta(input));
    if (!window.virtualWindow?.isOpen || !window.meetings?.length) {
      throw fail(`Share contributions are currently closed. The next virtual window opens ${window.virtualWindow?.nextOpenDate || "on the next scheduled date"}. Loan repayments can be submitted on any day.`, 409);
    }
    meetingId = positiveId(window.meetings[0].id, "Virtual window ID");
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const cycle = await requireActiveCycle(connection, groupId, cycleId, true);
    const [memberRows] = await connection.query(
      `SELECT id FROM users WHERE id = ? AND group_id = ? AND is_active = 1
         AND approval_status = 'APPROVED' AND email_verified_at IS NOT NULL FOR UPDATE`, [memberId, groupId],
    );
    if (!memberRows.length) throw fail("Only active, approved members with verified email can submit payments.", 403);
    const [recipientRows] = await connection.query(
      `SELECT id, role FROM users WHERE id = ? AND group_id = ? AND is_active = 1
         AND approval_status = 'APPROVED' AND email_verified_at IS NOT NULL
         AND role IN ('TREASURER','SECRETARY','CHAIRPERSON','ADMIN') FOR UPDATE`, [recipientId, groupId],
    );
    if (!recipientRows.length) throw fail("Choose an active, approved committee member to confirm receipt.");
    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [groupId]);
    if (!groupRows.length) throw fail("CORNESTONE company record was not found.", 404);
    const settings = parseSettings(groupRows[0].settings);
    let sharesCount = 0;
    let shareValue = null;
    if (purpose === "SHARE_PURCHASE") {
      const [meetingRows] = await connection.query(
        `SELECT id, meeting_number, status FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE`,
        [meetingId, groupId, cycleId],
      );
      if (!meetingRows.length) throw fail("The scheduled virtual payment window could not be confirmed. Refresh and try again.", 409);
      const actualWindow = getVirtualPaymentWindowStatus({
        cycleStartDate: cycle.start_date,
        intervalDays: Number(settings.meetingIntervalDays ?? 14),
        windowDays: Number(settings.virtualMeetingWindowDays ?? 3),
        timeZone: String(settings.paymentWindowTimeZone || DEFAULT_TIME_ZONE),
      });
      if (!actualWindow.isOpen || Number(meetingRows[0].meeting_number) !== Number(actualWindow.windowNumber)) {
        throw fail(`Share contributions are closed; the next virtual window opens ${actualWindow.nextOpenDate}.`, 409);
      }
      shareValue = Number(settings.shareValue ?? 1000);
      if (!Number.isFinite(shareValue) || shareValue <= 0) throw fail("The constitutional share price is invalid.", 422);
      sharesCount = Math.round(amount / shareValue);
      if (!Number.isSafeInteger(sharesCount) || sharesCount <= 0 || Math.abs(amount - sharesCount * shareValue) > 0.009) {
        throw fail(`Share contribution amount must be a whole number of shares at ${shareValue.toLocaleString()} RWF per share.`);
      }
      const maxShares = Number(settings.maxSharesPerMeeting ?? settings.maxSharesPerWindow ?? 30);
      const [postedRows] = await connection.query(
        `SELECT COALESCE(SUM(shares_count),0) AS shares_count FROM transactions
         WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND type = 'SHARE_PURCHASE'
           AND status = 'POSTED' AND COALESCE(credited_meeting_id, meeting_id) = ? FOR UPDATE`,
        [groupId, cycleId, memberId, meetingId],
      );
      const [reservedRows] = await connection.query(
        `SELECT COALESCE(SUM(shares_count),0) AS shares_count FROM member_payment_submissions
         WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND meeting_id = ?
           AND purpose = 'SHARE_PURCHASE' AND status = 'REQUESTED' FOR UPDATE`,
        [groupId, cycleId, memberId, meetingId],
      );
      const previous = Number(postedRows[0]?.shares_count || 0) + Number(reservedRows[0]?.shares_count || 0);
      if (previous + sharesCount > maxShares) throw fail(`This payment would exceed the limit of ${maxShares} shares in the current virtual window. You have ${Math.max(0, maxShares - previous)} share(s) available in this window.`);
      if (meetingRows[0].status !== "OPEN") throw fail("The virtual savings window closed while this request was being prepared. Refresh and try again.", 409);
    } else if (purpose === "LOAN_REPAYMENT") {
      const [loanRows] = await connection.query(
        `SELECT id FROM loans WHERE id = ? AND group_id = ? AND cycle_id = ? AND member_id = ?
         AND status IN ('ACTIVE','DEFAULTED') AND balance_remaining > 0.009 FOR UPDATE`, [loanId, groupId, cycleId, memberId],
      );
      if (!loanRows.length) throw fail("Select one of your active or defaulted loans with an outstanding balance.");
      // Use the same due-now projection shown in the passbook, including the configured service-charge period
      // charge that has accrued but has not yet been persisted by a repayment.
      const projectedLoans = await getOutstandingLoans(groupId, cycleId, memberId, connection);
      const projectedLoan = projectedLoans.find((loan) => Number(loan.loanId) === loanId);
      if (!projectedLoan) throw fail("The selected loan has no current outstanding balance.");
      const [reservedRows] = await connection.query(
        `SELECT COALESCE(SUM(amount), 0) AS reserved_amount FROM member_payment_submissions
         WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND loan_id = ?
           AND purpose = 'LOAN_REPAYMENT' AND status = 'REQUESTED'`, [groupId, cycleId, memberId, loanId],
      );
      const reservedAmount = Number(reservedRows[0]?.reserved_amount || 0);
      if (amount + reservedAmount > Number(projectedLoan.balanceRemaining) + 0.009) {
        throw fail(`This repayment plus your other pending repayments would exceed the current projected balance of ${Number(projectedLoan.balanceRemaining).toLocaleString()} RWF. Pending repayment requests reserve part of that balance until confirmed or rejected.`, 409);
      }
    } else if (purpose === "FINE_PAYMENT") {
      const [fineRows] = await connection.query(
        `SELECT id, member_id, amount, amount_paid, status, fine_label, reason
         FROM fine_assessments
         WHERE id = ? AND group_id = ? AND cycle_id = ? AND member_id = ?
           AND status IN ('OUTSTANDING','PARTIALLY_PAID') FOR UPDATE`,
        [fineAssessmentId, groupId, cycleId, memberId],
      );
      if (!fineRows.length) throw fail("Select one of your outstanding fines in this savings cycle.");
      const fine = fineRows[0];
      const balance = Math.max(0, Math.round((Number(fine.amount) - Number(fine.amount_paid)) * 100) / 100);
      const [reservedRows] = await connection.query(
        `SELECT COALESCE(SUM(amount), 0) AS reserved_amount FROM member_payment_submissions
         WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND fine_assessment_id = ?
           AND purpose = 'FINE_PAYMENT' AND status = 'REQUESTED' FOR UPDATE`,
        [groupId, cycleId, memberId, fineAssessmentId],
      );
      const reserved = Number(reservedRows[0]?.reserved_amount || 0);
      if (amount + reserved > balance + 0.009) {
        throw fail(`This payment plus other pending requests exceeds the remaining fine balance of ${balance.toLocaleString()} RWF.`, 409);
      }
      meetingId = null;
    }
    const [inserted] = await connection.query(
      `INSERT INTO member_payment_submissions
       (group_id, cycle_id, member_id, purpose, amount, shares_count, share_value_at_submission, loan_id, fine_assessment_id, meeting_id,
        payment_method, transfer_reference, notes, intended_recipient_user_id, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [groupId, cycleId, memberId, purpose, amount, sharesCount, shareValue, loanId, fineAssessmentId, meetingId, paymentMethod,
        transferReference, notes, recipientId, memberId],
    );
    await writeAuditEvent(connection, {
      groupId, cycleId, meetingId, actorUserId: memberId,
      action: "MEMBER_PAYMENT_SUBMITTED", entityType: "MEMBER_PAYMENT", entityId: inserted.insertId,
      afterData: { purpose, amount, sharesCount, loanId, fineAssessmentId, paymentMethod, transferReference, intendedRecipientUserId: recipientId }, ...auditMeta(input),
    });
    await connection.commit();
    return { id: Number(inserted.insertId), purpose, amount, sharesCount, loanId, fineAssessmentId, meetingId, paymentMethod, transferReference, status: "REQUESTED", intendedRecipientUserId: recipientId };
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (error.code === "ER_DUP_ENTRY") throw fail("This payment reference has already been submitted. Check the existing payment records before retrying.", 409);
    throw error;
  } finally { connection.release(); }
}

async function getMemberOutstandingFines(groupId, cycleId, memberId) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const mid = positiveId(memberId, "Member ID");
  const fines = await getOutstandingFines(gid, cid, mid);
  if (!fines.length) return [];
  const [reservedRows] = await db.query(
    `SELECT fine_assessment_id, COALESCE(SUM(amount), 0) AS reserved_amount
     FROM member_payment_submissions
     WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND purpose = 'FINE_PAYMENT' AND status = 'REQUESTED'
     GROUP BY fine_assessment_id`, [gid, cid, mid],
  );
  const reserved = new Map(reservedRows.map((row) => [Number(row.fine_assessment_id), Number(row.reserved_amount || 0)]));
  return fines.map((fine) => ({
    ...fine,
    pendingPaymentAmount: Math.round((reserved.get(Number(fine.fineId)) || 0) * 100) / 100,
    availableForRequest: Math.max(0, Math.round((Number(fine.balanceRemaining) - (reserved.get(Number(fine.fineId)) || 0)) * 100) / 100),
  }));
}

async function listMemberPaymentSubmissions(groupId, cycleId, userId, isLeader) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const uid = positiveId(userId, "User ID");
  const values = [gid, cid];
  let memberFilter = "";
  if (!isLeader) { memberFilter = " AND p.member_id = ?"; values.push(uid); }
  const [rows] = await db.query(
    `SELECT p.id, p.group_id AS groupId, p.cycle_id AS cycleId, p.member_id AS memberId,
       m.full_name AS memberName, p.purpose, p.amount, p.shares_count AS sharesCount,
       p.share_value_at_submission AS shareValueAtSubmission, p.loan_id AS loanId,
       p.fine_assessment_id AS fineAssessmentId, fine.fine_label AS fineLabel, fine.reason AS fineReason,
       p.meeting_id AS meetingId, p.payment_method AS paymentMethod, p.transfer_reference AS transferReference,
       p.notes, p.intended_recipient_user_id AS intendedRecipientUserId, recipient.full_name AS recipientName,
       p.status, p.requested_by AS requestedBy, p.verified_by AS verifiedBy, verifier.full_name AS verifierName,
       p.verified_at AS verifiedAt, p.decision_notes AS decisionNotes, p.transaction_id AS transactionId,
       p.receipt_id AS receiptId, r.receipt_number AS receiptNumber, p.created_at AS createdAt
     FROM member_payment_submissions p
     JOIN users m ON m.id = p.member_id
     JOIN users recipient ON recipient.id = p.intended_recipient_user_id
     LEFT JOIN users verifier ON verifier.id = p.verified_by
     LEFT JOIN financial_receipts r ON r.id = p.receipt_id
     LEFT JOIN fine_assessments fine ON fine.id = p.fine_assessment_id
     WHERE p.group_id = ? AND p.cycle_id = ?${memberFilter}
     ORDER BY CASE p.status WHEN 'REQUESTED' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, p.created_at DESC, p.id DESC`, values,
  );
  return rows.map((row) => ({
    ...row,
    id: Number(row.id), groupId: Number(row.groupId), cycleId: Number(row.cycleId), memberId: Number(row.memberId),
    amount: Number(row.amount), sharesCount: Number(row.sharesCount || 0),
    shareValueAtSubmission: row.shareValueAtSubmission == null ? null : Number(row.shareValueAtSubmission),
    loanId: row.loanId == null ? null : Number(row.loanId), fineAssessmentId: row.fineAssessmentId == null ? null : Number(row.fineAssessmentId), meetingId: row.meetingId == null ? null : Number(row.meetingId),
    intendedRecipientUserId: Number(row.intendedRecipientUserId), requestedBy: Number(row.requestedBy),
    verifiedBy: row.verifiedBy == null ? null : Number(row.verifiedBy), transactionId: row.transactionId == null ? null : Number(row.transactionId),
    receiptId: row.receiptId == null ? null : Number(row.receiptId),
  }));
}

async function rejectMemberPaymentSubmission({ groupId, requestId, actorUserId, notes, audit = {} }) {
  const gid = positiveId(groupId, "Group ID");
  const rid = positiveId(requestId, "Payment request ID");
  const actorId = positiveId(actorUserId, "Reviewer ID");
  const reason = String(notes || "").trim();
  if (reason.length < 5 || reason.length > 1000) throw fail("Provide a rejection reason between 5 and 1,000 characters.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT p.*, u.role AS recipient_role, u.is_active AS recipient_active,
        u.approval_status AS recipient_approval_status, u.email_verified_at AS recipient_email_verified_at
       FROM member_payment_submissions p JOIN users u ON u.id = p.intended_recipient_user_id
       WHERE p.id = ? AND p.group_id = ? FOR UPDATE`, [rid, gid],
    );
    if (!rows.length) throw fail("Payment submission not found.", 404);
    const request = rows[0];
    if (Number(request.intended_recipient_user_id) !== actorId) throw fail("Only the designated receiving committee member can confirm or reject this payment.", 403);
    if (!LEADERSHIP_ROLES.includes(String(request.recipient_role).toUpperCase()) || Number(request.recipient_active) !== 1 || request.recipient_approval_status !== "APPROVED" || !request.recipient_email_verified_at) throw fail("The designated recipient is no longer an active, approved, email-verified committee member.", 403);
    if (Number(request.member_id) === actorId) throw fail("You cannot approve or reject your own payment.", 403);
    if (String(request.status) !== "REQUESTED") throw fail("Only a pending payment can be rejected.", 409);
    await connection.query(
      `UPDATE member_payment_submissions SET status = 'REJECTED', verified_by = ?, verified_at = CURRENT_TIMESTAMP, decision_notes = ? WHERE id = ? AND status = 'REQUESTED'`,
      [actorId, reason, rid],
    );
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: request.cycle_id, meetingId: request.meeting_id, actorUserId: actorId,
      action: "MEMBER_PAYMENT_REJECTED", entityType: "MEMBER_PAYMENT", entityId: rid,
      beforeData: { status: request.status }, afterData: { status: "REJECTED", reason }, ...auditMeta(audit),
    });
    await connection.commit();
    return { id: rid, status: "REJECTED", decisionNotes: reason };
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

async function approveSharePayment({ groupId, requestId, actorUserId, audit = {} }) {
  const gid = positiveId(groupId, "Group ID");
  const rid = positiveId(requestId, "Payment request ID");
  const actorId = positiveId(actorUserId, "Reviewer ID");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT p.*, recipient.role AS recipient_role, recipient.is_active AS recipient_active,
        recipient.approval_status AS recipient_approval_status, recipient.email_verified_at AS recipient_email_verified_at
       FROM member_payment_submissions p JOIN users recipient ON recipient.id = p.intended_recipient_user_id
       WHERE p.id = ? AND p.group_id = ? FOR UPDATE`, [rid, gid],
    );
    if (!rows.length) throw fail("Payment submission not found.", 404);
    const request = rows[0];
    if (request.purpose !== "SHARE_PURCHASE") throw fail("This payment uses the loan repayment workflow.");
    if (request.status !== "REQUESTED") throw fail("Only a pending payment can be confirmed.", 409);
    if (Number(request.intended_recipient_user_id) !== actorId) throw fail("Only the designated receiving committee member can confirm this payment.", 403);
    if (!LEADERSHIP_ROLES.includes(String(request.recipient_role).toUpperCase()) || Number(request.recipient_active) !== 1 || request.recipient_approval_status !== "APPROVED" || !request.recipient_email_verified_at) throw fail("The designated recipient is no longer an active, approved, email-verified committee member.", 403);
    if (Number(request.member_id) === actorId) throw fail("You cannot confirm your own payment.", 403);
    const cycle = await requireActiveCycle(connection, gid, Number(request.cycle_id), true);
    const [memberRows] = await connection.query("SELECT id FROM users WHERE id = ? AND group_id = ? AND is_active = 1 FOR UPDATE", [request.member_id, gid]);
    if (!memberRows.length) throw fail("The member account is no longer active.", 409);
    const [meetingRows] = await connection.query(
      `SELECT id, meeting_number FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE`,
      [request.meeting_id, gid, request.cycle_id],
    );
    if (!meetingRows.length) throw fail("The virtual window recorded for this payment could not be found.", 409);
    const [settingsRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [gid]);
    if (!settingsRows.length) throw fail("CORNESTONE company record was not found.", 404);
    const settings = parseSettings(settingsRows[0].settings);
    const shareValue = Number(request.share_value_at_submission);
    const sharesCount = Number(request.shares_count);
    const amount = Number(request.amount);
    if (!Number.isFinite(shareValue) || shareValue <= 0 || !Number.isSafeInteger(sharesCount) || sharesCount <= 0 || Math.abs(amount - shareValue * sharesCount) > 0.009) {
      throw fail("Stored share payment details do not balance. Do not confirm; ask leadership to investigate.", 409);
    }
    const maxShares = Number(settings.maxSharesPerMeeting ?? settings.maxSharesPerWindow ?? 30);
    const [postedRows] = await connection.query(
      `SELECT COALESCE(SUM(shares_count),0) AS shares_count FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND type = 'SHARE_PURCHASE' AND status = 'POSTED'
         AND COALESCE(credited_meeting_id, meeting_id) = ? FOR UPDATE`,
      [gid, request.cycle_id, request.member_id, request.meeting_id],
    );
    const [pendingRows] = await connection.query(
      `SELECT COALESCE(SUM(shares_count),0) AS shares_count FROM member_payment_submissions
       WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND meeting_id = ? AND purpose = 'SHARE_PURCHASE'
         AND status = 'REQUESTED' AND id <> ? FOR UPDATE`,
      [gid, request.cycle_id, request.member_id, request.meeting_id, rid],
    );
    if (Number(postedRows[0]?.shares_count || 0) + sharesCount + Number(pendingRows[0]?.shares_count || 0) > maxShares) {
      throw fail("Confirming this contribution would exceed the member's maximum shares for the recorded virtual window. Review pending submissions before proceeding.", 409);
    }
    const [inserted] = await connection.query(
      `INSERT INTO transactions (group_id, cycle_id, meeting_id, member_id, type, amount, shares_count, share_value_at_transaction, created_by)
       VALUES (?, ?, ?, ?, 'SHARE_PURCHASE', ?, ?, ?, ?)`,
      [gid, request.cycle_id, request.meeting_id, request.member_id, amount, sharesCount, shareValue, actorId],
    );
    const ledger = await insertLedgerEntry(connection, {
      groupId: gid, cycleId: Number(request.cycle_id), meetingId: Number(request.meeting_id), memberId: Number(request.member_id),
      fundType: "LOAN_FUND", entryType: "SHARE_PURCHASE", direction: "IN", amount, profitEffect: 0,
      notes: `Verified member payment #${rid}: ${sharesCount} share(s) for virtual window #${meetingRows[0].meeting_number}.`,
      sourceType: "TRANSACTION", sourceId: inserted.insertId, sourceComponent: "TOTAL", createdBy: actorId,
    });
    const receipt = await createReceipt(connection, {
      groupId: gid, cycleId: Number(request.cycle_id), meetingId: Number(request.meeting_id), memberId: Number(request.member_id),
      sourceType: "TRANSACTION", sourceId: inserted.insertId, sourceComponent: "TOTAL", activityType: "SHARE_PURCHASE",
      amount, summary: `Verified member contribution for ${sharesCount} share(s)`,
      details: { transactionId: inserted.insertId, memberPaymentSubmissionId: rid, ledgerEntryId: ledger, sharesCount, shareValue, paymentMethod: request.payment_method, transferReference: request.transfer_reference },
      issuedBy: actorId,
    });
    await connection.query(
      `UPDATE member_payment_submissions SET status = 'APPROVED', verified_by = ?, verified_at = CURRENT_TIMESTAMP,
       transaction_id = ?, receipt_id = ?, decision_notes = 'Receipt confirmed and posted to the financial ledger.' WHERE id = ? AND status = 'REQUESTED'`,
      [actorId, inserted.insertId, receipt.id, rid],
    );
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: Number(request.cycle_id), meetingId: Number(request.meeting_id), actorUserId: actorId,
      action: "MEMBER_PAYMENT_CONFIRMED", entityType: "MEMBER_PAYMENT", entityId: rid,
      beforeData: { status: "REQUESTED" }, afterData: { status: "APPROVED", amount, transactionId: inserted.insertId, ledgerEntryId: ledger, receiptNumber: receipt.receiptNumber }, ...auditMeta(audit),
    });
    await connection.commit();
    return { id: rid, status: "APPROVED", transactionId: Number(inserted.insertId), ledgerEntryId: Number(ledger), receipt };
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

async function approveFinePayment({ groupId, requestId, actorUserId, audit = {} }) {
  const gid = positiveId(groupId, "Group ID");
  const rid = positiveId(requestId, "Payment request ID");
  const actorId = positiveId(actorUserId, "Reviewer ID");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT p.*, recipient.role AS recipient_role, recipient.is_active AS recipient_active,
        recipient.approval_status AS recipient_approval_status, recipient.email_verified_at AS recipient_email_verified_at
       FROM member_payment_submissions p JOIN users recipient ON recipient.id = p.intended_recipient_user_id
       WHERE p.id = ? AND p.group_id = ? FOR UPDATE`, [rid, gid],
    );
    if (!rows.length) throw fail("Payment submission not found.", 404);
    const request = rows[0];
    if (request.purpose !== "FINE_PAYMENT") throw fail("This payment is not a fine payment.");
    if (request.status !== "REQUESTED") throw fail("Only a pending payment can be confirmed.", 409);
    if (Number(request.intended_recipient_user_id) !== actorId) throw fail("Only the designated receiving committee member can confirm this payment.", 403);
    if (!LEADERSHIP_ROLES.includes(String(request.recipient_role).toUpperCase()) || Number(request.recipient_active) !== 1 || request.recipient_approval_status !== "APPROVED" || !request.recipient_email_verified_at) throw fail("The designated recipient is no longer an active, approved, email-verified committee member.", 403);
    if (Number(request.member_id) === actorId) throw fail("You cannot confirm your own payment.", 403);
    await requireActiveCycle(connection, gid, Number(request.cycle_id), true);
    const [memberRows] = await connection.query("SELECT id FROM users WHERE id = ? AND group_id = ? AND is_active = 1 FOR UPDATE", [request.member_id, gid]);
    if (!memberRows.length) throw fail("The member account is no longer active.", 409);
    const [fineRows] = await connection.query(
      `SELECT * FROM fine_assessments WHERE id = ? AND group_id = ? AND cycle_id = ? AND member_id = ?
         AND status IN ('OUTSTANDING','PARTIALLY_PAID') FOR UPDATE`,
      [request.fine_assessment_id, gid, request.cycle_id, request.member_id],
    );
    if (!fineRows.length) throw fail("The outstanding fine was settled or no longer belongs to this member and cycle. Do not confirm this request.", 409);
    const fine = fineRows[0];
    const amount = positiveMoney(request.amount);
    const currentBalance = Math.max(0, Math.round((Number(fine.amount) - Number(fine.amount_paid)) * 100) / 100);
    if (amount > currentBalance + 0.009) throw fail(`This payment exceeds the remaining fine balance of ${currentBalance.toLocaleString()} RWF.`, 409);
    const paidToDate = Math.round((Number(fine.amount_paid) + amount) * 100) / 100;
    const remaining = Math.max(0, Math.round((Number(fine.amount) - paidToDate) * 100) / 100);
    const fineStatus = remaining < 0.01 ? "PAID" : "PARTIALLY_PAID";
    const [inserted] = await connection.query(
      `INSERT INTO transactions (group_id, cycle_id, meeting_id, member_id, fine_assessment_id, type, amount, shares_count, fine_reason, created_by)
       VALUES (?, ?, NULL, ?, ?, 'FINE_PAYMENT', ?, 0, ?, ?)`,
      [gid, request.cycle_id, request.member_id, request.fine_assessment_id, amount, fine.reason || fine.fine_label, actorId],
    );
    const ledgerId = await insertLedgerEntry(connection, {
      groupId: gid, cycleId: Number(request.cycle_id), meetingId: null, memberId: Number(request.member_id),
      fundType: "LOAN_FUND", entryType: "FINE_PAYMENT", direction: "IN", amount, profitEffect: amount,
      notes: `Verified member payment #${rid} for fine #${request.fine_assessment_id}: ${fine.reason || fine.fine_label}.`,
      sourceType: "TRANSACTION", sourceId: inserted.insertId, sourceComponent: "TOTAL", createdBy: actorId,
    });
    await connection.query("UPDATE fine_assessments SET amount_paid = ?, status = ? WHERE id = ?", [paidToDate, fineStatus, request.fine_assessment_id]);
    await connection.query("UPDATE cycles SET total_fines_collected = COALESCE(total_fines_collected, 0) + ? WHERE id = ? AND group_id = ?", [amount, request.cycle_id, gid]);
    const receipt = await createReceipt(connection, {
      groupId: gid, cycleId: Number(request.cycle_id), meetingId: null, memberId: Number(request.member_id),
      sourceType: "TRANSACTION", sourceId: inserted.insertId, sourceComponent: "TOTAL", activityType: "FINE_PAYMENT",
      amount, summary: `Verified payment for fine ${fine.reason || fine.fine_label}`,
      details: { transactionId: inserted.insertId, memberPaymentSubmissionId: rid, fineId: Number(request.fine_assessment_id), fineLabel: fine.fine_label, amountPaid: amount, amountPaidToDate: paidToDate, balanceRemaining: remaining, status: fineStatus, paymentMethod: request.payment_method, transferReference: request.transfer_reference },
      issuedBy: actorId,
    });
    await connection.query(
      `UPDATE member_payment_submissions SET status = 'APPROVED', verified_by = ?, verified_at = CURRENT_TIMESTAMP,
       transaction_id = ?, receipt_id = ?, decision_notes = 'Receipt confirmed and posted to the financial ledger.' WHERE id = ? AND status = 'REQUESTED'`,
      [actorId, inserted.insertId, receipt.id, rid],
    );
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: Number(request.cycle_id), actorUserId: actorId, action: "MEMBER_FINE_PAYMENT_CONFIRMED",
      entityType: "MEMBER_PAYMENT", entityId: rid,
      beforeData: { status: "REQUESTED", fineBalance: currentBalance },
      afterData: { status: "APPROVED", amount, fineBalance: remaining, transactionId: inserted.insertId, ledgerEntryId: ledgerId, receiptNumber: receipt.receiptNumber },
      ...auditMeta(audit),
    });
    await connection.commit();
    return { id: rid, status: "APPROVED", transactionId: Number(inserted.insertId), ledgerEntryId: Number(ledgerId), receipt };
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

async function decideMemberPaymentSubmission({ groupId, requestId, actorUserId, decision, notes, audit = {} }) {
  const normalized = String(decision || "").trim().toUpperCase();
  if (!["APPROVE", "REJECT"].includes(normalized)) throw fail("Decision must be APPROVE or REJECT.");
  if (normalized === "REJECT") return rejectMemberPaymentSubmission({ groupId, requestId, actorUserId, notes, audit });
  const [rows] = await db.query(
    `SELECT id, group_id, cycle_id, member_id, loan_id, fine_assessment_id, amount, purpose, status, intended_recipient_user_id
     FROM member_payment_submissions WHERE id = ? AND group_id = ? LIMIT 1`,
    [positiveId(requestId, "Payment request ID"), positiveId(groupId, "Group ID")],
  );
  if (!rows.length) throw fail("Payment submission not found.", 404);
  const request = rows[0];
  if (request.status !== "REQUESTED") throw fail("Only a pending payment can be confirmed.", 409);
  if (Number(request.intended_recipient_user_id) !== positiveId(actorUserId, "Reviewer ID")) throw fail("Only the designated receiving committee member can confirm this payment.", 403);
  if (Number(request.member_id) === Number(actorUserId)) throw fail("You cannot confirm your own payment.", 403);
  if (request.purpose === "SHARE_PURCHASE") return approveSharePayment({ groupId, requestId, actorUserId, audit });
  if (request.purpose === "FINE_PAYMENT") return approveFinePayment({ groupId, requestId, actorUserId, audit });
  if (request.purpose === "LOAN_REPAYMENT") {
    const repayment = await repayLoan(request.loan_id, request.amount, request.cycle_id, null, request.group_id, actorUserId, auditMeta(audit), request.member_id, request.id);
    return { id: Number(request.id), status: "APPROVED", transactionId: repayment.transactionId, receipt: repayment.receipt, repayment };
  }
  throw fail("Unsupported payment purpose.", 409);
}

module.exports = { getPaymentRecipients, getMemberOutstandingFines, createMemberPaymentSubmission, listMemberPaymentSubmissions, decideMemberPaymentSubmission };
