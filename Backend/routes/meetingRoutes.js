const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { openMeeting, synchronizeVirtualPaymentWindow, closeMeeting, recordMeetingTransactions } = require("../services/meetingService");
const { listEligibleGusibuzaMeetings, recordGusibuza } = require("../services/gusibuzaService");
const { verifyToken, requireRole, verifyGroupOwnership } = require("../middleware/auth");
const { financialIdempotency } = require("../middleware/financialIdempotency");
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];

// List open meetings for a group's selected cycle; used by loan and cashbook forms.
router.get(
  "/groups/:groupId/meetings/open",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const cycleId = Number(req.query.cycleId);
      if (!Number.isSafeInteger(groupId) || groupId <= 0 || !Number.isSafeInteger(cycleId) || cycleId <= 0) {
        return res.status(400).json({ success: false, message: "A valid group ID and cycle ID are required." });
      }
      const result = await synchronizeVirtualPaymentWindow(groupId, cycleId, req.user?.id ?? null, auditMetaFor(req));
      return res.status(200).json({ success: true, meetings: result.meetings,
        nextMeetingNumber: result.nextMeetingNumber, virtualWindow: result.virtualWindow });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
    }
  },
);


// List earlier closed meetings that have room for late share purchases under the approved gusibuza rule.
router.get(
  "/groups/:groupId/gusibuza/eligible-meetings",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      if (!req.user || Number(req.user.groupId) !== groupId) return res.status(403).json({ success: false, message: "Access forbidden. Group ID mismatch." });
      const result = await listEligibleGusibuzaMeetings(groupId, req.query.cycleId, req.query.currentMeetingId, req.query.memberId);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load eligible gusibuza meetings." });
    }
  },
);

// Record late shares and any required gusibuza fee in the current open meeting, credited to a prior meeting.
router.post(
  "/meetings/:meetingId/gusibuza",
  verifyToken,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  async (req, res) => {
    try {
      const meetingId = Number(req.params.meetingId);
      const groupId = Number(req.body.groupId);
      if (!Number.isSafeInteger(meetingId) || meetingId <= 0 || !Number.isSafeInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ success: false, message: "Valid current meeting and group IDs are required." });
      }
      if (!req.user || Number(req.user.groupId) !== groupId) return res.status(403).json({ success: false, message: "Access forbidden. Group ID mismatch." });
      const result = await recordGusibuza({
        groupId, cycleId: req.body.cycleId, currentMeetingId: meetingId,
        memberId: req.body.memberId, targetMeetingId: req.body.targetMeetingId,
        sharesCount: req.body.sharesCount, createdBy: req.user.id, auditMeta: auditMetaFor(req),
      });
      return res.status(201).json({ success: true, message: `Gusibuza recorded: ${result.sharesCount} share(s) credited to Meeting #${result.targetMeetingNumber}.`, gusibuza: result });
    } catch (error) {
      return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not record gusibuza." });
    }
  },
);

router.post(
  "/groups/:groupId/meetings",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { cycleId, meetingNumber, date } = req.body;
      const meeting = await openMeeting(groupId, cycleId, meetingNumber, date, req.user.id, auditMetaFor(req));
      res.status(201).json({ success: true, message: "Meeting opened successfully", meeting });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    }
  },
);

router.post(
  "/groups/:groupId/meetings/:meetingId/close",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const meetingId = Number(req.params.meetingId);
      const cycleId = Number(req.body.cycleId);
      if (![groupId, meetingId, cycleId].every((value) => Number.isSafeInteger(value) && value > 0)) {
        return res.status(400).json({ success: false, message: "Valid group, meeting and cycle IDs are required." });
      }
      if (!req.user || String(req.user.groupId) !== String(groupId)) {
        return res.status(403).json({ success: false, message: "Access forbidden. Group ID mismatch." });
      }
      const meeting = await closeMeeting(groupId, cycleId, meetingId, req.user.id, auditMetaFor(req));
      const saved = meeting.persistedRecords || {};
      res.status(200).json({
        success: true,
        message: `Meeting #${meeting.meetingNumber} closed and committed to the database. Saved record counts: ${saved.transactions ?? 0} transaction(s) including ${saved.loanRepayments ?? 0} loan repayment(s), ${saved.cashbookEntries ?? 0} cashbook entry/entries, ${saved.receipts ?? 0} receipt(s), ${saved.fineAssessments ?? 0} fine assessment(s), ${saved.loansDisbursed ?? 0} loan disbursement(s), ${saved.cashReconciliations ?? 0} cash reconciliation(s), ${saved.attendanceRows ?? 0} attendance row(s), and ${saved.meetingNotes ?? 0} meeting record(s).`,
        meeting,
      });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Failed to close the meeting." });
    }
  },
);

router.post(
  "/meetings/:meetingId/transactions",
  verifyToken,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  async (req, res) => {
    try {
      const meetingId = Number(req.params.meetingId);
      const groupId = Number(req.body.groupId);
      const cycleId = Number(req.body.cycleId);
      const memberId = Number(req.body.memberId);
      const { transactions, fineAssessment = null } = req.body;

      if (!Number.isSafeInteger(meetingId) || meetingId <= 0) {
        return res.status(400).json({ success: false, message: "A valid virtual savings window ID is required. Refresh the window status and retry." });
      }
      if (!req.user || String(req.user.groupId) !== String(groupId)) {
        return res.status(403).json({ success: false, message: "Access forbidden. Group ID mismatch." });
      }
      if (!Array.isArray(transactions)) {
        return res.status(400).json({ success: false, message: "Transactions must be supplied as a list, even when recording a fine only." });
      }
      if (transactions.length > 0) {
        return res.status(410).json({
          success: false,
          message: "Direct share/financial transaction entry is disabled. Members must submit payments in My Digital Passbook and the designated receiving committee member must confirm actual receipt before the ledger is posted.",
        });
      }

      const result = await recordMeetingTransactions(
        groupId, cycleId, meetingId, memberId, transactions, req.user.id, auditMetaFor(req), fineAssessment,
      );
      res.status(201).json({
        success: true,
        message: result.fineAssessment ? "Member contributions recorded and the fine was added to outstanding fines." : "Transactions recorded successfully",
        transactions: result.transactions,
        fineAssessment: result.fineAssessment,
      });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    }
  },
);

module.exports = router;
