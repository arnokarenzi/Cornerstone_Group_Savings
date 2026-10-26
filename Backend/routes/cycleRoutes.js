"use strict";

const express = require("express");
const router = express.Router();
const { verifyToken, verifyGroupOwnership, requireRole } = require("../middleware/auth");
const { financialIdempotency } = require("../middleware/financialIdempotency");
const { sendRouteError } = require("../utils/routeErrors");
const { getCycleLifecycle, prepareCycleClosure, recordCyclePayout, cancelCycleClosure, completeCycleAndStartNext } = require("../services/cycleLifecycleService");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

router.get(
  "/:groupId/cycles/:cycleId/lifecycle",
  verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const lifecycle = await getCycleLifecycle(req.params.groupId, req.params.cycleId);
      return res.status(200).json({ success: true, lifecycle });
    } catch (error) {
      if (Array.isArray(error.blockingReasons)) {
        return res.status(error.statusCode || 409).json({ success: false, message: error.message, blockingReasons: error.blockingReasons });
      }
      return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load the cycle management status." });
    }
  },
);

router.post(
  "/:groupId/cycles/:cycleId/closure/prepare",
  verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency,
  async (req, res) => {
    try {
      const result = await prepareCycleClosure(req.params.groupId, req.params.cycleId, req.user.id, auditMetaFor(req));
      return res.status(201).json({ success: true, message: "Share-out register prepared and the cycle is locked against new financial entries. Record each member payout, then perform the final witnessed cash count.", closure: result });
    } catch (error) {
      if (Array.isArray(error.blockingReasons)) {
        return res.status(error.statusCode || 409).json({ success: false, message: error.message, blockingReasons: error.blockingReasons });
      }
      return sendRouteError(res, error, { fallbackStatus: 409, fallbackMessage: "Could not prepare cycle share-out." });
    }
  },
);

router.post(
  "/:groupId/cycles/:cycleId/closure/cancel",
  verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency,
  async (req, res) => {
    try {
      const result = await cancelCycleClosure(req.params.groupId, req.params.cycleId, req.user.id, req.body?.reason, auditMetaFor(req));
      return res.status(200).json({ success: true, message: result.message, cycle: result });
    } catch (error) {
      return sendRouteError(res, error, { fallbackStatus: 409, fallbackMessage: "Could not cancel share-out preparation." });
    }
  },
);

router.post(
  "/:groupId/cycles/:cycleId/closure/payouts/:payoutId/record",
  verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency,
  async (req, res) => {
    try {
      const result = await recordCyclePayout(
        req.params.groupId, req.params.cycleId, req.params.payoutId, req.user.id,
        req.body?.confirmCashHandedOver === true, auditMetaFor(req),
      );
      return res.status(201).json({ success: true, message: `Recorded share-out payout of ${Number(result.amount).toLocaleString()} RWF to ${result.memberName}. Receipt ${result.receipt.receiptNumber} was saved.`, payout: result });
    } catch (error) {
      return sendRouteError(res, error, { fallbackStatus: 409, fallbackMessage: "Could not record the member payout." });
    }
  },
);

router.post(
  "/:groupId/cycles/:cycleId/closure/complete",
  verifyToken, verifyGroupOwnership, requireRole(LEADERSHIP_ROLES), financialIdempotency,
  async (req, res) => {
    try {
      const result = await completeCycleAndStartNext(req.params.groupId, req.params.cycleId, req.body || {}, req.user.id, auditMetaFor(req));
      return res.status(200).json({
        success: true,
        message: `Cycle ${result.completedCycle.cycleNumber} is closed. Cycle ${result.nextCycle.cycle_number} is now active. Only the Loan Fund was reconciled; CORNESTONE has no Social Fund.`,
        ...result,
      });
    } catch (error) {
      return sendRouteError(res, error, { fallbackStatus: 409, fallbackMessage: "Could not complete the cycle and create the next cycle." });
    }
  },
);

module.exports = router;
