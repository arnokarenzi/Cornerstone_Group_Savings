"use strict";

const REQUIRED_SHARE_OUT_FORMULA = "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES";

function parseTerms(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Return a user-facing launch/closure blocker, or null when ratification is valid. */
function shareOutRatificationBlocker(row) {
  if (!row || String(row.status || "").toUpperCase() !== "CURRENT") {
    return "Cycle share-out is blocked until CORNESTONE has a current constitution formally approved by member vote in Constitution & Rules.";
  }
  if (String(row.approval_method || "").toUpperCase() !== "MEMBER_VOTE") {
    return "Cycle share-out is blocked because the current constitution is still an interim legacy version. Submit the current rules and share-out formula for member approval in Constitution & Rules.";
  }
  const terms = parseTerms(row.constitution_json ?? row.terms);
  if (terms.shareOutFormula !== REQUIRED_SHARE_OUT_FORMULA) {
    return "Cycle share-out is blocked because the current member-approved constitution does not record the required proportional net-unredeemed-share formula. Submit and approve a constitution amendment before closing the cycle.";
  }
  return null;
}

function assertShareOutRatified(row) {
  const message = shareOutRatificationBlocker(row);
  if (message) {
    const error = new Error(message);
    error.statusCode = 409;
    error.code = "SHARE_OUT_POLICY_NOT_RATIFIED";
    throw error;
  }
  return true;
}

function isEligibleConstitutionVoter(user) {
  if (!user) return false;
  const active = user.is_active == null ? true : Number(user.is_active) === 1;
  const approved = String(user.approval_status || "APPROVED").toUpperCase() === "APPROVED";
  const verified = Boolean(user.email_verified_at);
  return active && approved && verified;
}

module.exports = {
  REQUIRED_SHARE_OUT_FORMULA,
  shareOutRatificationBlocker,
  assertShareOutRatified,
  isEligibleConstitutionVoter,
};
