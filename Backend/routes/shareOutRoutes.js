const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { calculateShareOut } = require("../services/shareOutService");
const { verifyToken, verifyGroupOwnership } = require("../middleware/auth");

// Calculate share-out distributions for a cycle (Requires token and group ownership)
router.get(
  "/groups/:groupId/cycles/:cycleId/share-out-preview",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const { groupId, cycleId } = req.params;
      if (!Number.isSafeInteger(Number(groupId)) || Number(groupId) <= 0 ||
          !Number.isSafeInteger(Number(cycleId)) || Number(cycleId) <= 0) {
        return res.status(400).json({
          success: false,
          message: "A valid group ID and cycle ID are required.",
        });
      }

      const report = await calculateShareOut(Number(groupId), Number(cycleId));
      res.status(200).json({
        success: true,
        message: "Share-out calculation generated successfully",
        report,
      });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "Failed to calculate share-out preview." });
    }
  },
);

module.exports = router;
