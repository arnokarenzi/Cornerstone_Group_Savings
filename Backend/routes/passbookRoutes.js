const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { verifyToken, verifyGroupOwnership } = require("../middleware/auth");
const { getMemberPassbook } = require("../services/passbookService");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];

function parsePositiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    const error = new Error(`${label} must be a positive integer.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

router.get(
  "/groups/:groupId/members/:memberId/passbook",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const groupId = parsePositiveId(req.params.groupId, "Group ID");
      const memberId = parsePositiveId(req.params.memberId, "Member ID");
      const cycleId = req.query.cycleId ? parsePositiveId(req.query.cycleId, "Cycle ID") : null;

      // A member can only access their own passbook. Only verified group leadership
      // can inspect another member's passbook, and the service verifies group membership.
      if (Number(req.user.id) !== memberId && !LEADERSHIP_ROLES.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: "Members can only view their own digital passbook." });
      }

      const passbook = await getMemberPassbook(groupId, memberId, cycleId);
      res.json({ success: true, passbook });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "Could not load the digital passbook." });
    }
  },
);

module.exports = router;
