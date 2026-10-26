const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { getOutstandingLoans } = require("../services/loanService");
const { getOutstandingFines } = require("../services/fineService");
const { verifyToken, requireRole, verifyGroupOwnership } = require("../middleware/auth");
const { financialIdempotency } = require("../middleware/financialIdempotency");
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];


router.get(
  "/groups/:groupId/loans/outstanding",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { cycleId, memberId } = req.query;
      const loans = await getOutstandingLoans(groupId, cycleId, memberId);
      const fines = await getOutstandingFines(groupId, cycleId, memberId);
      return res.status(200).json({ success: true, loans, fines });
    } catch (error) {
      return sendRouteError(res, error, {
        fallbackStatus: 400,
        fallbackMessage: "Could not load outstanding loans for this borrower.",
      });
    }
  },
);

router.post(
  "/groups/:groupId/loans",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  (req, res) => res.status(410).json({
    success: false,
    message: "Direct loan issuance is disabled. Members must submit a loan application, receive an independent committee decision, and have an approved application disbursed through the application workflow.",
  }),
);

router.post(
  "/loans/:loanId/repay",
  verifyToken,
  requireRole(LEADERSHIP_ROLES),
  financialIdempotency,
  (req, res) => res.status(410).json({
    success: false,
    message: "Direct loan repayment entry is disabled. The borrower must submit the repayment in My Digital Passbook and the designated committee recipient must confirm actual receipt before the ledger and receipt are posted.",
  }),
);

module.exports = router;
