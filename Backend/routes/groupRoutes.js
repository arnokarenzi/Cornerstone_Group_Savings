const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const db = require("../config/db");
const { groupCreationRateLimit } = require("../middleware/rateLimits");
const { verifyToken, verifyGroupOwnership, requireRole } = require("../middleware/auth");

// CORNESTONE is a single-company application. Public group/company creation is disabled.
router.post("/", groupCreationRateLimit, (req, res) => {
  return res.status(410).json({
    success: false,
    message: "Company registration is disabled. This platform is reserved for CORNESTONE Co.LTD.",
  });
});

// Get the active cycle belonging to a specific group.
router.get(
  "/:groupId/cycles/active",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const [rows] = await db.query(
        `SELECT id, group_id, cycle_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
               DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status
         FROM cycles
         WHERE group_id = ? AND status IN ('ACTIVE', 'CLOSING')
         ORDER BY CASE WHEN status = 'CLOSING' THEN 0 ELSE 1 END, cycle_number DESC, id DESC
         LIMIT 1`,
        [groupId],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No active cycle exists for this group. A leadership member must complete the prior cycle or ask an administrator to create the initial cycle.",
        });
      }

      res.status(200).json({ success: true, cycle: rows[0] });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
    }
  },
);

// Get group details (Requires token and group ownership)
router.get("/:groupId", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const { groupId } = req.params;
    const [rows] = await db.query(
      "SELECT id, name, created_at, settings FROM `groups` WHERE id = ?",
      [groupId],
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    }

    res.status(200).json({ success: true, group: rows[0] });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
  }
});

// Get members of a specific group
router.get(
  "/:groupId/members",
  verifyToken,
  verifyGroupOwnership,
  requireRole(["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"]),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const [rows] = await db.query(
        "SELECT id, full_name, email, phone_number, role, is_active, approval_status, created_at FROM users WHERE group_id = ?",
        [groupId],
      );

      res.status(200).json({ success: true, members: rows });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
    }
  },
);

module.exports = router;
