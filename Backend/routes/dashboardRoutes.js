const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const {
  getMemberDashboard,
  getGroupDashboard,
} = require("../services/dashboardService");
const { verifyToken, verifyGroupOwnership } = require("../middleware/auth");

// Member dashboard summary (Requires token and matching group ownership)
router.get(
  "/groups/:groupId/cycles/:cycleId/members/:memberId/dashboard",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const { groupId, cycleId, memberId } = req.params;
      const dashboard = await getMemberDashboard(groupId, memberId, cycleId);
      res.status(200).json({ success: true, dashboard });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    }
  },
);

// Group leader macro dashboard summary (Requires token and matching group ownership)
router.get(
  "/groups/:groupId/cycles/:cycleId/dashboard",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const { groupId, cycleId } = req.params;
      const dashboard = await getGroupDashboard(groupId, cycleId);
      res.status(200).json({ success: true, dashboard });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    }
  },
);

module.exports = router;
