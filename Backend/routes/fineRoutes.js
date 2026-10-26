"use strict";

const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { verifyToken, requireRole, verifyGroupOwnership } = require("../middleware/auth");
const { financialIdempotency } = require("../middleware/financialIdempotency");


const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
router.post(
  "/groups/:groupId/fines/:fineId/payments",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  (req, res) => res.status(410).json({
    success: false,
    message: "Direct fine-payment entry is disabled. The member must submit the payment in My Digital Passbook and the designated committee recipient must confirm actual receipt before the ledger and receipt are posted.",
  }),
);

module.exports = router;
