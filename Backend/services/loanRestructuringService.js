"use strict";

const db = require("../config/db");
const { writeAuditEvent } = require("./auditService");
const { addCalendarDays, getTodayIsoInTimeZone, PAYMENT_POLICY_TIME_ZONE } = require("./loanDefaultPolicy");
const { parseSettings } = require("./constitutionRules");

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}
function isoDate(value, label) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must be in YYYY-MM-DD format.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error(`${label} must be a valid date.`);
  return text;
}
function statusError(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; return error; }
function parseRow(row) {
  return {
    id: Number(row.id), groupId: Number(row.group_id), cycleId: Number(row.cycle_id),
    loanId: Number(row.loan_id), memberId: Number(row.member_id), memberName: row.member_name || null,
    principalAmount: Number(row.principal_amount || 0), balanceRemaining: Number(row.balance_remaining || 0),
    loanStatus: row.loan_status || null, originalDueDate: row.original_due_date,
    requestedDueDate: row.requested_due_date, reason: row.reason, status: row.status,
    requestedBy: Number(row.requested_by), requestedByName: row.requested_by_name || null,
    reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by), reviewedByName: row.reviewed_by_name || null,
    reviewedAt: row.reviewed_at || null, decisionNotes: row.decision_notes || "", createdAt: row.created_at,
  };
}
const SELECT_REQUESTS = `SELECT r.*, m.full_name AS member_name, requester.full_name AS requested_by_name,
  reviewer.full_name AS reviewed_by_name, l.principal_amount, l.balance_remaining, l.status AS loan_status
  FROM loan_restructuring_requests r JOIN users m ON m.id = r.member_id
  JOIN loans l ON l.id = r.loan_id LEFT JOIN users requester ON requester.id = r.requested_by
  LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by`;

async function listLoanRestructurings(groupId, cycleId, actorUserId, isLeader) {
  const gid = positiveId(groupId, "Group ID"), cid = positiveId(cycleId, "Cycle ID"), actor = positiveId(actorUserId, "User ID");
  const [rows] = await db.query(
    `${SELECT_REQUESTS} WHERE r.group_id = ? AND r.cycle_id = ?${isLeader ? "" : " AND r.member_id = ?"} ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
    isLeader ? [gid, cid] : [gid, cid, actor],
  );
  return rows.map(parseRow);
}

async function requestLoanRestructuring({ groupId, cycleId, loanId, actorUserId, isLeader, requestedDueDate, reason, auditMeta = {} }) {
  const gid = positiveId(groupId, "Group ID"), cid = positiveId(cycleId, "Cycle ID"), lid = positiveId(loanId, "Loan ID"), actor = positiveId(actorUserId, "Requesting user ID");
  const nextDue = isoDate(requestedDueDate, "Requested due date");
  const why = String(reason || "").trim();
  if (why.length < 10 || why.length > 1000) throw new Error("Please give a reason between 10 and 1,000 characters.");
  const today = getTodayIsoInTimeZone(new Date(), PAYMENT_POLICY_TIME_ZONE);
  if (nextDue <= today) throw new Error("The requested due date must be a future Rwanda calendar date.");
  const connection = await db.getConnection(); let started = false;
  try {
    await connection.beginTransaction(); started = true;
    const [cycleRows] = await connection.query("SELECT id, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cid, gid]);
    if (!cycleRows.length || cycleRows[0].status !== "ACTIVE") throw statusError("Loan restructuring can only be requested in the active CORNESTONE cycle.", 409);
    const [loanRows] = await connection.query(
      `SELECT id, group_id, cycle_id, member_id, due_date, status, balance_remaining
       FROM loans WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE`, [lid, gid, cid],
    );
    if (!loanRows.length) throw statusError("Loan not found in the selected company cycle.", 404);
    const loan = loanRows[0];
    if (!isLeader && Number(loan.member_id) !== actor) throw statusError("Members can request restructuring only for their own loans.", 403);
    if (!loan.due_date || !["ACTIVE", "DEFAULTED"].includes(String(loan.status)) || Number(loan.balance_remaining) <= 0.009) throw statusError("Only an unpaid active or defaulted loan can be restructured.", 409);
    const originalDue = loan.due_date instanceof Date
      ? `${loan.due_date.getFullYear()}-${String(loan.due_date.getMonth() + 1).padStart(2, "0")}-${String(loan.due_date.getDate()).padStart(2, "0")}`
      : String(loan.due_date).slice(0, 10);
    if (nextDue <= originalDue) throw new Error("The requested due date must be later than the current contractual due date.");
    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [gid]);
    if (!groupRows.length) throw statusError("CORNESTONE company settings were not found.", 404);
    const settings = parseSettings(groupRows[0].settings);
    const configuredMaximumTerm = Number(settings.maxLoanTermDays ?? (Number(settings.maxLoanDurationMonths) > 0 ? Number(settings.maxLoanDurationMonths) * 30 : NaN));
    if (!Number.isSafeInteger(configuredMaximumTerm) || configuredMaximumTerm < 1 || configuredMaximumTerm > 3660) {
      throw statusError("The constitutional maximum loan term is invalid. Correct it through Constitution & Rules before restructuring loans.", 422);
    }
    const maximumDueDate = addCalendarDays(originalDue, configuredMaximumTerm);
    if (nextDue > maximumDueDate) throw new Error(`A restructuring may extend the due date by no more than ${configuredMaximumTerm} additional days under the current constitution, through ${maximumDueDate}.`);
    const [existingRows] = await connection.query(
      `SELECT id, status FROM loan_restructuring_requests WHERE loan_id = ? AND status IN ('REQUESTED','APPROVED') FOR UPDATE`, [lid],
    );
    if (existingRows.length) throw statusError("This loan already has a pending or approved restructuring request. Resolve it before submitting another.", 409);
    const [insert] = await connection.query(
      `INSERT INTO loan_restructuring_requests (group_id, cycle_id, loan_id, member_id, original_due_date, requested_due_date, reason, status, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?)`,
      [gid, cid, lid, Number(loan.member_id), originalDue, nextDue, why, actor],
    );
    await writeAuditEvent(connection, { groupId: gid, cycleId: cid, actorUserId: actor, action: "LOAN_RESTRUCTURING_REQUESTED", entityType: "LOAN_RESTRUCTURING_REQUEST", entityId: insert.insertId,
      afterData: { loanId: lid, memberId: Number(loan.member_id), originalDueDate: originalDue, requestedDueDate: nextDue, maximumExtensionDays: configuredMaximumTerm, status: "REQUESTED" }, reason: why, ...auditMeta });
    await connection.commit(); started = false;
    return { id: Number(insert.insertId), loanId: lid, status: "REQUESTED", originalDueDate: originalDue, requestedDueDate: nextDue };
  } catch (error) { if (started) await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

async function decideLoanRestructuring({ groupId, cycleId, requestId, decision, notes, actorUserId, auditMeta = {} }) {
  const gid = positiveId(groupId, "Group ID"), cid = positiveId(cycleId, "Cycle ID"), rid = positiveId(requestId, "Restructuring request ID"), actor = positiveId(actorUserId, "Reviewer user ID");
  const action = String(decision || "").toUpperCase();
  if (!["APPROVE", "REJECT"].includes(action)) throw new Error("Decision must be APPROVE or REJECT.");
  const decisionNotes = String(notes || "").trim();
  if (action === "REJECT" && decisionNotes.length < 5) throw new Error("A rejection reason of at least 5 characters is required.");
  if (decisionNotes.length > 1000) throw new Error("Decision notes cannot exceed 1,000 characters.");
  const connection = await db.getConnection(); let started = false;
  try {
    await connection.beginTransaction(); started = true;
    const [cycleRows] = await connection.query("SELECT id, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cid, gid]);
    if (!cycleRows.length || cycleRows[0].status !== "ACTIVE") throw statusError("Restructuring decisions can only be recorded in the active cycle.", 409);
    const [rows] = await connection.query("SELECT * FROM loan_restructuring_requests WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE", [rid, gid, cid]);
    if (!rows.length) throw statusError("Restructuring request not found.", 404);
    const request = rows[0];
    if (Number(request.requested_by) === actor || Number(request.member_id) === actor) {
      throw statusError("The requester or borrower cannot review their own restructuring. Another authorized committee member must decide it.", 403);
    }
    if (request.status !== "REQUESTED") throw statusError(`This request is already ${request.status.toLowerCase()} and cannot be reviewed again.`, 409);
    const [loanRows] = await connection.query("SELECT * FROM loans WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE", [request.loan_id, gid, cid]);
    if (!loanRows.length || !["ACTIVE", "DEFAULTED"].includes(String(loanRows[0].status)) || Number(loanRows[0].balance_remaining) <= 0.009) throw statusError("The loan is no longer eligible for restructuring.", 409);
    const [existingApproved] = await connection.query("SELECT id FROM loan_restructuring_requests WHERE loan_id = ? AND status = 'APPROVED' AND id <> ? LIMIT 1 FOR UPDATE", [request.loan_id, rid]);
    if (action === "APPROVE" && existingApproved.length) throw statusError("This loan already has an approved restructuring. A second extension is not allowed by the current default policy.", 409);
    const nextStatus = action === "APPROVE" ? "APPROVED" : "REJECTED";
    if (action === "APPROVE") {
      const due = request.requested_due_date instanceof Date
        ? `${request.requested_due_date.getFullYear()}-${String(request.requested_due_date.getMonth() + 1).padStart(2, "0")}-${String(request.requested_due_date.getDate()).padStart(2, "0")}`
        : String(request.requested_due_date).slice(0, 10);
      const today = getTodayIsoInTimeZone(new Date(), PAYMENT_POLICY_TIME_ZONE);
      if (due <= today) throw statusError("The requested new due date has passed. The borrower must submit a new request for a future date.", 409);
      await connection.query("UPDATE loans SET due_date = ?, status = 'ACTIVE' WHERE id = ?", [due, request.loan_id]);
    }
    await connection.query("UPDATE loan_restructuring_requests SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, decision_notes = ? WHERE id = ?", [nextStatus, actor, decisionNotes || null, rid]);
    await writeAuditEvent(connection, { groupId: gid, cycleId: cid, actorUserId: actor, action: `LOAN_RESTRUCTURING_${nextStatus}`, entityType: "LOAN_RESTRUCTURING_REQUEST", entityId: rid,
      beforeData: { status: request.status, loanId: Number(request.loan_id), dueDate: request.original_due_date },
      afterData: { status: nextStatus, loanId: Number(request.loan_id), dueDate: action === "APPROVE" ? request.requested_due_date : request.original_due_date, decisionNotes: decisionNotes || null },
      reason: decisionNotes || `Committee ${nextStatus.toLowerCase()} the restructuring request.`, ...auditMeta });
    await connection.commit(); started = false;
    return { id: rid, loanId: Number(request.loan_id), status: nextStatus, dueDate: action === "APPROVE" ? request.requested_due_date : request.original_due_date };
  } catch (error) { if (started) await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}

module.exports = { listLoanRestructurings, requestLoanRestructuring, decideLoanRestructuring };
