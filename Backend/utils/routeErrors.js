"use strict";

const DATABASE_ERROR_PREFIXES = ["ER_", "ECONN", "ETIMEDOUT", "EHOST", "ENOTFOUND", "PROTOCOL_", "EPIPE"];

function isInfrastructureError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.sqlMessage || error.sqlState || error.fatal) return true;
  const code = String(error.code || "");
  return DATABASE_ERROR_PREFIXES.some((prefix) => code.startsWith(prefix));
}

function sendRouteError(res, error, { fallbackStatus = 400, fallbackMessage = "The request could not be completed." } = {}) {
  if (isInfrastructureError(error)) {
    // Keep database/driver details in server logs, never in the HTTP response.
    console.error("[api-infrastructure-error]", String(error.code || "UNKNOWN"), String(error.message || "Unknown infrastructure error"));
    return res.status(500).json({ success: false, message: "A server or database error occurred. Please try again later." });
  }

  const candidateStatus = Number(error?.statusCode);
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
    ? candidateStatus
    : fallbackStatus;
  const message = status >= 500 ? fallbackMessage : (error?.message || fallbackMessage);
  return res.status(status).json({ success: false, message });
}

module.exports = { isInfrastructureError, sendRouteError };
