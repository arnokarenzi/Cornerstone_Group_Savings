"use strict";

const DISABLED_MESSAGE = "Late-share/Gusibuza is disabled in the CORNESTONE online application. Shares can be purchased only during scheduled virtual payment windows.";

async function listEligibleGusibuzaMeetings() {
  throw new Error(DISABLED_MESSAGE);
}

async function recordGusibuza() {
  throw new Error(DISABLED_MESSAGE);
}

module.exports = { listEligibleGusibuzaMeetings, recordGusibuza };
