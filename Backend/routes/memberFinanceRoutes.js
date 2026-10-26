"use strict";
const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { verifyToken, verifyGroupOwnership, requireRole } = require("../middleware/auth");
const { financialIdempotency } = require("../middleware/financialIdempotency");
const { getPaymentRecipients, getMemberOutstandingFines, createMemberPaymentSubmission, listMemberPaymentSubmissions, decideMemberPaymentSubmission } = require("../services/memberPaymentService");
const { getLoanEligibility, listLoanApplications, createLoanApplication, decideLoanApplication, disburseLoanApplication } = require("../services/loanApplicationService");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const auditMeta = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });
const cycleIdFrom = (req) => req.body?.cycleId ?? req.query?.cycleId;

router.get("/groups/:groupId/payment-recipients", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const recipients = await getPaymentRecipients(req.params.groupId);
    return res.json({ success: true, recipients });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load authorized payment recipients." }); }
});

router.get("/groups/:groupId/member-fines", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const cycleId = cycleIdFrom(req);
    if (!cycleId) return res.status(400).json({ success: false, message: "cycleId is required." });
    const fines = await getMemberOutstandingFines(req.params.groupId, cycleId, req.user.id);
    return res.json({ success: true, fines });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load your outstanding fines." }); }
});

router.get("/groups/:groupId/member-payments", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const cycleId = cycleIdFrom(req);
    if (!cycleId) return res.status(400).json({ success: false, message: "cycleId is required." });
    const isLeader = LEADERSHIP_ROLES.includes(String(req.user.role || "").toUpperCase());
    const requests = await listMemberPaymentSubmissions(req.params.groupId, cycleId, req.user.id, isLeader);
    return res.json({ success: true, requests });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load member payment submissions." }); }
});

router.post("/groups/:groupId/member-payments", verifyToken, verifyGroupOwnership, financialIdempotency, async (req, res) => {
  try {
    const request = await createMemberPaymentSubmission({
      groupId: req.params.groupId, cycleId: req.body?.cycleId, memberId: req.user.id,
      purpose: req.body?.purpose, amount: req.body?.amount, loanId: req.body?.loanId, fineAssessmentId: req.body?.fineAssessmentId,
      paymentMethod: req.body?.paymentMethod, transferReference: req.body?.transferReference,
      notes: req.body?.notes, intendedRecipientUserId: req.body?.intendedRecipientUserId,
      ipAddress: req.ip, userAgent: req.get("user-agent"),
    });
    return res.status(201).json({ success: true, message: "Payment submitted for confirmation by the designated committee recipient.", request });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not submit the payment." }); }
});

router.post("/groups/:groupId/member-payments/:requestId/decision", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency, async (req, res) => {
  try {
    const result = await decideMemberPaymentSubmission({
      groupId: req.params.groupId, requestId: req.params.requestId, actorUserId: req.user.id,
      decision: req.body?.decision, notes: req.body?.notes, audit: auditMeta(req),
    });
    return res.json({ success: true, message: result.status === "APPROVED" ? `Payment confirmed and posted${result.receipt?.receiptNumber ? ` (receipt ${result.receipt.receiptNumber})` : ""}.` : "Payment submission rejected; no financial entry was posted.", result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not review the payment submission." }); }
});

router.get("/groups/:groupId/loan-eligibility", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const cycleId = cycleIdFrom(req);
    if (!cycleId) return res.status(400).json({ success: false, message: "cycleId is required." });
    const eligibility = await getLoanEligibility({ groupId: req.params.groupId, cycleId, memberId: req.user.id });
    const { settings, ...safeEligibility } = eligibility;
    return res.json({ success: true, eligibility: safeEligibility });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not calculate your borrowing capacity." }); }
});

router.get("/groups/:groupId/loan-applications", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const cycleId = cycleIdFrom(req);
    if (!cycleId) return res.status(400).json({ success: false, message: "cycleId is required." });
    const isLeader = LEADERSHIP_ROLES.includes(String(req.user.role || "").toUpperCase());
    const applications = await listLoanApplications({ groupId: req.params.groupId, cycleId, userId: req.user.id, isLeader });
    return res.json({ success: true, applications });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load loan applications." }); }
});

router.post("/groups/:groupId/loan-applications", verifyToken, verifyGroupOwnership, financialIdempotency, async (req, res) => {
  try {
    const application = await createLoanApplication({
      groupId: req.params.groupId, cycleId: req.body?.cycleId, memberId: req.user.id,
      requestedPrincipal: req.body?.requestedPrincipal, requestedTermDays: req.body?.requestedTermDays,
      reason: req.body?.reason, audit: auditMeta(req),
    });
    return res.status(201).json({ success: true, message: "Loan application submitted for committee review. This is not yet a loan disbursement.", application });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not submit the loan application." }); }
});

router.post("/groups/:groupId/loan-applications/:applicationId/decision", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency, async (req, res) => {
  try {
    const result = await decideLoanApplication({ groupId: req.params.groupId, applicationId: req.params.applicationId,
      actorUserId: req.user.id, decision: req.body?.decision, notes: req.body?.notes, audit: auditMeta(req) });
    return res.json({ success: true, message: `Loan application ${result.status.toLowerCase()}.`, result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not review the loan application." }); }
});

router.post("/groups/:groupId/loan-applications/:applicationId/disburse", verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency, async (req, res) => {
  try {
    const result = await disburseLoanApplication({ groupId: req.params.groupId, applicationId: req.params.applicationId,
      actorUserId: req.user.id, audit: auditMeta(req) });
    return res.status(201).json({ success: true, message: `Approved loan application disbursed. Loan #${result.loanId}${result.receipt?.receiptNumber ? `; receipt ${result.receipt.receiptNumber}` : ""}.`, loan: result });
  } catch (error) { return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not disburse the approved loan application." }); }
});

module.exports = router;
