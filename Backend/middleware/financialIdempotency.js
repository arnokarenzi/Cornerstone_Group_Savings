"use strict";

const db = require("../config/db");
const { requestHash } = require("../utils/idempotencyUtils");

/**
 * DB-backed idempotency fence for authenticated financial writes. Concurrent
 * duplicates are blocked, completed responses replay exactly, and a crashed
 * process leaves a PROCESSING marker that blocks unsafe blind retries.
 */
async function financialIdempotency(req, res, next) {
  const rawKey = String(req.get("Idempotency-Key") || "").trim();
  if (!rawKey || rawKey.length < 16 || rawKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(rawKey)) {
    return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key header is required for financial writes. Retry the same action with the same key if its result is uncertain." });
  }
  const groupId = Number(req.params.groupId ?? req.body?.groupId ?? req.user?.groupId);
  const userId = Number(req.user?.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({ success: false, code: "IDEMPOTENCY_CONTEXT_INVALID", message: "A valid authenticated company context is required for financial writes." });
  }
  if (Number(req.user.groupId) !== groupId) {
    return res.status(403).json({ success: false, code: "IDEMPOTENCY_CONTEXT_FORBIDDEN", message: "Financial write refused because the authenticated account does not belong to this company." });
  }

  const hash = requestHash(req);
  let row;
  let newlyInserted = false;
  try {
    const [insert] = await db.query(
      `INSERT INTO financial_idempotency_keys (group_id, user_id, idempotency_key, request_hash, status)
       VALUES (?, ?, ?, ?, 'PROCESSING')`, [groupId, userId, rawKey, hash],
    );
    row = { id: Number(insert.insertId), status: "PROCESSING", request_hash: hash, user_id: userId };
    newlyInserted = true;
  } catch (error) {
    if (error.code !== "ER_DUP_ENTRY") {
      console.error("Financial idempotency reservation failed:", error.message);
      return res.status(503).json({ success: false, code: "IDEMPOTENCY_RESERVATION_FAILED", message: "Could not establish duplicate-transaction protection. No financial action was run; please retry shortly." });
    }
    try {
      const [rows] = await db.query(
        `SELECT id, user_id, request_hash, status, response_status, response_json
         FROM financial_idempotency_keys WHERE group_id = ? AND idempotency_key = ? LIMIT 1`, [groupId, rawKey],
      );
      row = rows[0];
    } catch (lookupError) {
      console.error("Financial idempotency lookup failed:", lookupError.message);
      return res.status(503).json({ success: false, code: "IDEMPOTENCY_LOOKUP_FAILED", message: "Could not verify whether this financial action was already processed. Check receipts/audit records before retrying." });
    }
  }

  if (!row) return res.status(503).json({ success: false, code: "IDEMPOTENCY_RESULT_UNAVAILABLE", message: "Could not confirm the status of this financial action. Check the audit records before retrying." });
  if (Number(row.user_id) !== userId) return res.status(409).json({ success: false, code: "IDEMPOTENCY_KEY_SCOPE_CONFLICT", message: "This idempotency key belongs to another user. Do not repeat the financial action until its status is reconciled." });
  if (String(row.request_hash) !== hash) return res.status(409).json({ success: false, code: "IDEMPOTENCY_KEY_PAYLOAD_CONFLICT", message: "This idempotency key was already used for a different request. Do not reuse it with changed details." });

  if (!newlyInserted) {
    if (row.status === "COMPLETED") {
      let body;
      try { body = JSON.parse(row.response_json || "null"); } catch { body = null; }
      if (body == null) return res.status(409).json({ success: false, code: "IDEMPOTENCY_RESULT_UNAVAILABLE", message: "A prior result exists but cannot be replayed. Check the receipt and audit record before taking further action." });
      return res.status(Number(row.response_status) || 200).json(body);
    }
    return res.status(409).json({ success: false, code: "IDEMPOTENCY_OUTCOME_UNCERTAIN", message: "This financial action is already processing or requires reconciliation. Do not create a new key or repeat the cash movement; check the audit log and receipts." });
  }

  const originalJson = res.json.bind(res);
  let responseHandled = false;
  res.json = (body) => {
    if (responseHandled) return originalJson(body);
    responseHandled = true;
    const statusCode = Number(res.statusCode || 200);
    // Deterministic 4xx responses mean the business action was rejected before
    // it committed, so release this key for a deliberate retry after the member
    // corrects the request or the blocking condition changes. A 5xx remains
    // PROCESSING because the outcome may be uncertain; blind retries are blocked.
    const writePromise = statusCode >= 400
      ? (statusCode >= 500
          ? Promise.resolve() // retain PROCESSING as a safe reconciliation fence
          : db.query("DELETE FROM financial_idempotency_keys WHERE id = ? AND status = 'PROCESSING'", [row.id]))
      : db.query(
        `UPDATE financial_idempotency_keys SET status = 'COMPLETED', response_status = ?, response_json = ?, completed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'PROCESSING'`, [statusCode, JSON.stringify(body), row.id],
      );
    writePromise.catch((error) => {
      console.error("Could not finalize idempotency response:", error.message);
    }).finally(() => originalJson(body));
    return res;
  };
  return next();
}

module.exports = { financialIdempotency, requestHash };
