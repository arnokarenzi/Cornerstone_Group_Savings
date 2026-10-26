"use strict";
const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { verifyToken, verifyGroupOwnership, requireRole } = require("../middleware/auth");
const { financialIdempotency } = require("../middleware/financialIdempotency");
const { getWithdrawalRequests, createWithdrawalRequest, decideWithdrawalRequest, payWithdrawalRequest } = require("../services/withdrawalService");
const { listLoanRestructurings, requestLoanRestructuring, decideLoanRestructuring } = require("../services/loanRestructuringService");
const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });
function cycleIdFrom(req) { return req.body?.cycleId ?? req.query?.cycleId; }

router.get("/groups/:groupId/withdrawal-requests", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const cycleId = cycleIdFrom(req);
    if (!cycleId) return res.status(400).json({ success: false, message: "cycleId is required." });
    const isLeader = LEADERSHIP_ROLES.includes(String(req.user.role || "").toUpperCase());
    const result = await getWithdrawalRequests(req.params.groupId, cycleId, req.user.id, isLeader);
    return res.json({ success: true, ...result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load withdrawal requests." }); }
});

router.post("/groups/:groupId/withdrawal-requests", verifyToken, verifyGroupOwnership, financialIdempotency, async (req, res) => {
  try {
    const result = await createWithdrawalRequest({ groupId: req.params.groupId, cycleId: req.body?.cycleId, memberId: req.user.id, amount: req.body?.amount, reason: req.body?.reason, actorUserId: req.user.id, auditMeta: auditMetaFor(req) });
    return res.status(201).json({ success: true, message: "Withdrawal request submitted for committee review.", request: result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not submit the withdrawal request." }); }
});

router.post("/groups/:groupId/withdrawal-requests/:requestId/decision", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency, async (req, res) => {
  try {
    const result = await decideWithdrawalRequest({ groupId: req.params.groupId, cycleId: req.body?.cycleId, requestId: req.params.requestId, decision: req.body?.decision, notes: req.body?.notes, actorUserId: req.user.id, auditMeta: auditMetaFor(req) });
    return res.json({ success: true, message: `Withdrawal request ${result.status.toLowerCase()}.`, request: result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not review the withdrawal request." }); }
});

router.post("/groups/:groupId/withdrawal-requests/:requestId/pay", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency, async (req, res) => {
  try {
    const result = await payWithdrawalRequest({ groupId: req.params.groupId, cycleId: req.body?.cycleId, requestId: req.params.requestId, actorUserId: req.user.id, confirmCashHandedOver: req.body?.confirmCashHandedOver === true, auditMeta: auditMetaFor(req) });
    return res.json({ success: true, message: `Withdrawal paid. Receipt ${result.receipt.receiptNumber}.`, payout: result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not record the withdrawal payout." }); }
});

router.get("/groups/:groupId/loan-restructurings", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const cycleId = cycleIdFrom(req);
    if (!cycleId) return res.status(400).json({ success: false, message: "cycleId is required." });
    const isLeader = LEADERSHIP_ROLES.includes(String(req.user.role || "").toUpperCase());
    const requests = await listLoanRestructurings(req.params.groupId, cycleId, req.user.id, isLeader);
    return res.json({ success: true, requests });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load loan restructuring requests." }); }
});

router.post("/groups/:groupId/loans/:loanId/restructurings", verifyToken, verifyGroupOwnership, financialIdempotency, async (req, res) => {
  try {
    const isLeader = LEADERSHIP_ROLES.includes(String(req.user.role || "").toUpperCase());
    const result = await requestLoanRestructuring({ groupId: req.params.groupId, cycleId: req.body?.cycleId, loanId: req.params.loanId, actorUserId: req.user.id, isLeader, requestedDueDate: req.body?.requestedDueDate, reason: req.body?.reason, auditMeta: auditMetaFor(req) });
    return res.status(201).json({ success: true, message: "Loan restructuring request submitted for committee review.", request: result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not submit the restructuring request." }); }
});

router.post("/groups/:groupId/loan-restructurings/:requestId/decision", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency, async (req, res) => {
  try {
    const result = await decideLoanRestructuring({ groupId: req.params.groupId, cycleId: req.body?.cycleId, requestId: req.params.requestId, decision: req.body?.decision, notes: req.body?.notes, actorUserId: req.user.id, auditMeta: auditMetaFor(req) });
    return res.json({ success: true, message: `Loan restructuring request ${result.status.toLowerCase()}.`, request: result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not review the restructuring request." }); }
});

module.exports = router;
