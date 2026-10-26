const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { verifyToken, requireRole, verifyGroupOwnership } = require("../middleware/auth");
const { getConstitution, createConstitutionProposal, castConstitutionVote } = require("../services/constitutionService");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

router.get(
  "/:groupId/constitution",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const snapshot = await getConstitution(groupId, Number(req.user.id));
      res.json({ success: true, constitution: snapshot });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not load the group constitution." });
    }
  },
);

router.post(
  "/:groupId/constitution/proposals",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const proposal = await createConstitutionProposal(
        groupId,
        Number(req.user.id),
        req.body?.terms,
        req.body?.reason,
        auditMetaFor(req),
      );
      res.status(201).json({ success: true, message: "Constitution proposal submitted. It will take effect only after member approval.", proposal });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not submit the constitution proposal." });
    }
  },
);

router.post(
  "/:groupId/constitution/proposals/:proposalId/votes",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const proposalId = Number(req.params.proposalId);
      if (!Number.isSafeInteger(proposalId) || proposalId <= 0) {
        return res.status(400).json({ success: false, message: "A valid constitution proposal ID is required." });
      }
      const result = await castConstitutionVote(groupId, proposalId, Number(req.user.id), req.body?.vote, auditMetaFor(req));
      res.status(200).json({ success: true, message: result.status === "CURRENT" ? "The group approved the new constitution. Its rules are now active." : result.status === "REJECTED" ? "The group rejected this constitution proposal." : result.status === "DEADLOCKED" ? "The proposal ended without a majority. Leadership may submit a revised proposal." : "Your vote has been recorded.", result });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not record your vote." });
    }
  },
);

module.exports = router;
