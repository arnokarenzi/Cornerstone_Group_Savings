"use strict";
require("dotenv").config();
const db = require("../config/db");

const RULES = {
  shareValue: 1000,
  minSharesPerMeeting: 0,
  maxSharesPerMeeting: 30,
  loanRatioLimit: 2,
  interestRate: 0.10,
  monthlyInterestRate: 0.10,
  interestMethod: "FLAT_PER_PERIOD",
  interestPeriodDays: 28,
  maxLoanTermDays: 180,
  meetingFrequency: "FORTNIGHTLY",
  meetingIntervalDays: 14,
  virtualMeetingWindowDays: 3,
  paymentWindowTimeZone: "Africa/Kigali",
  cycleDurationMonths: 12,
  shareOutFormula: "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES",
  socialFundMode: "NONE",
  socialFundContributionAmount: 0,
  gusibuzaEnabled: false,
  gusibuzaFeeAmount: 0,
  withdrawalPolicy: "Savings are intended to remain in the cycle until cycle closing. An exceptional withdrawal or a departure during the cycle requires a written request, a recorded committee decision, and a verified account reconciliation. Outstanding loan principal and confirmed charges must be settled or covered by a documented repayment agreement before final settlement. Every approved withdrawal must record the amount, reason, approvers, date, and receipt. No automatic forfeiture or deduction is applied unless expressly authorized by the constitution and applicable law.",
  defaultPolicy: "A missed repayment must be recorded and the member notified promptly. The maximum initial contractual loan term is the value configured in the structured Constitution & Rules loan-term setting, measured from the disbursement date. The initial service charge at the configured rate is due at disbursement, even if the loan is repaid early; each further charge becomes due at the end of the configured service-charge period on the principal then remaining. Any balance unpaid after the contractual due date is in default from the next calendar day; no additional grace period applies. While overdue, the member is not eligible for a new loan unless the committee approves and records one restructuring, which may extend the due date by no more than the maximum loan term configured in the constitution. Restructuring does not forgive principal or accrued service charges. The committee must document contact attempts, any agreed payment plan, decisions and the reasons for any write-off or recovery action. No additional default penalty or automatic seizure of savings applies unless a separately approved constitutional provision and applicable law permit it."
};

async function main() {
  const connection = await db.getConnection();
  try {
    // Phase 2 narrows the database enum definitions to the only active online
    // financial types. Refuse to discard any legacy entries if someone has
    // started recording them before applying this phase.
    const [[socialTransactions]] = await connection.query(
      "SELECT COUNT(*) AS count FROM transactions WHERE type = 'SOCIAL_FUND'",
    );
    const [[lateShareTransactions]] = await connection.query(
      "SELECT COUNT(*) AS count FROM transactions WHERE type = 'GUSIBUZA_FEE' OR (type = 'SHARE_PURCHASE' AND credited_meeting_id IS NOT NULL AND credited_meeting_id <> meeting_id)",
    );
    const [[socialLedger]] = await connection.query(
      "SELECT COUNT(*) AS count FROM fund_ledger_entries WHERE fund_type = 'SOCIAL_FUND' OR entry_type = 'GUSIBUZA_FEE' OR entry_type LIKE '%SOCIAL_FUND%'",
    );
    const [[socialCounts]] = await connection.query(
      "SELECT COUNT(*) AS count FROM cash_reconciliations WHERE fund_type = 'SOCIAL_FUND'",
    );
    const legacyRows = Number(socialTransactions.count || 0) + Number(lateShareTransactions.count || 0)
      + Number(socialLedger.count || 0) + Number(socialCounts.count || 0);
    if (legacyRows > 0) {
      throw new Error(`Found ${legacyRows} Social Fund or Gusibuza records. The online-only schema will not discard historical records; review or export them before retrying Phase 2.`);
    }
    await connection.query("ALTER TABLE transactions MODIFY COLUMN type ENUM('SHARE_PURCHASE','LOAN_DISBURSEMENT','LOAN_REPAYMENT','FINE_PAYMENT') NOT NULL");
    await connection.query("ALTER TABLE fund_ledger_entries MODIFY COLUMN fund_type ENUM('LOAN_FUND') NOT NULL");
    await connection.query("ALTER TABLE cash_reconciliations MODIFY COLUMN fund_type ENUM('LOAN_FUND') NOT NULL");

    await connection.beginTransaction();
    const [groupRows] = await connection.query("SELECT id, settings FROM `groups` ORDER BY id");
    if (!groupRows.length) throw new Error("No CORNESTONE company record exists yet. Run npm run provision:company first.");
    for (const row of groupRows) {
      let settings = row.settings;
      if (typeof settings === "string") settings = JSON.parse(settings || "{}");
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
      // Discover the current constitution before applying defaults. Phase 2 is
      // safe to rerun: once members have approved a constitution, preserve its
      // current numeric terms instead of resetting them to the initial defaults.
      const [constitutionRows] = await connection.query(
        `SELECT id, constitution_json, approval_method FROM group_constitutions
         WHERE group_id = ? AND status = 'CURRENT' ORDER BY version_number DESC LIMIT 1 FOR UPDATE`,
        [row.id],
      );
      const current = constitutionRows[0];
      const constitutionIsMemberApproved = current?.approval_method === "MEMBER_VOTE";
      const next = constitutionIsMemberApproved
        ? { ...settings, socialFundMode: "NONE", socialFundContributionAmount: 0, gusibuzaEnabled: false, gusibuzaFeeAmount: 0 }
        : { ...settings, ...RULES };
      delete next.socialFundFixedContribution;
      delete next.gusibuzaFeeMode;
      await connection.query("UPDATE `groups` SET settings = ? WHERE id = ?", [JSON.stringify(next), row.id]);
      if (current && current.approval_method === "LEGACY_IMPORTED") {
        let terms = current.constitution_json;
        if (typeof terms === "string") terms = JSON.parse(terms || "{}");
        if (!terms || typeof terms !== "object" || Array.isArray(terms)) terms = {};
        const mergedTerms = {
          ...terms,
          ...RULES,
          fineRules: Array.isArray(terms.fineRules) ? terms.fineRules : [],
          allowOtherFines: typeof terms.allowOtherFines === "boolean" ? terms.allowOtherFines : true,
        };
        await connection.query(
          "UPDATE group_constitutions SET constitution_json = ? WHERE id = ? AND approval_method = 'LEGACY_IMPORTED'",
          [JSON.stringify(mergedTerms), current.id],
        );
      }
      await connection.query(
        "UPDATE cycles SET end_date = DATE_ADD(start_date, INTERVAL 12 MONTH) WHERE group_id = ? AND status = 'ACTIVE' AND end_date IS NULL",
        [row.id],
      );
    }
    await connection.commit();
    console.log(`Phase 2 defaults applied to ${groupRows.length} company record(s).`);
    console.log("Settings updated; interim legacy constitution defaults refreshed if applicable.");
    console.log("Existing transaction and loan history was not deleted or rewritten.");
    console.log("Active cycles without an end date were assigned a 12-month end date.");
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error(`Phase 2 configuration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    connection.release();
    await db.end?.();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
