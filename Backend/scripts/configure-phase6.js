"use strict";
require("dotenv").config();
const db = require("../config/db");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULTS = {
  shareValue: 1000,
  minSharesPerMeeting: 0,
  maxSharesPerMeeting: 30,
  loanRatioLimit: 2,
  interestRate: 0.10,
  monthlyInterestRate: 0.10,
  interestMethod: "FLAT_PER_PERIOD",
  interestPeriodDays: 28,
  maxLoanTermDays: 180,
  maxLoanDurationMonths: 6,
  meetingFrequency: "FORTNIGHTLY",
  meetingIntervalDays: 14,
  virtualMeetingWindowDays: 3,
  cycleDurationMonths: 12,
  paymentWindowTimeZone: "Africa/Kigali",
  gusibuzaEnabled: false,
  gusibuzaFeeAmount: 0,
  shareOutFormula: "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES",
  shareOutPolicy: "After all loans and confirmed obligations are settled, the Loan Fund is physically counted and reconciled, and all payout blockers are cleared, the remaining counted Loan Fund cash is distributed in proportion to each member’s net unredeemed shares. A payout may be above or below that member’s net actual share contributions; the cycle’s surplus or loss is shared proportionally by net unredeemed shares. Paid mid-cycle redemptions use the face value captured when the request was submitted, reduce shares and net contributions, and are not included again in final share-out. No Social Fund is included.",
  socialFundMode: "NONE",
  socialFundContributionAmount: 0,
  withdrawalPolicy: "An exceptional withdrawal requires a written request and a recorded committee decision and approval. Withdrawals redeem whole shares at the constitutional face value recorded when requested and remove those shares from future borrowing and share-out calculations. A member with outstanding loan principal or accrued service charges cannot receive a withdrawal payout; a restructuring by itself is not loan settlement or permission to offset debt against savings. A payout is allowed only from reconciled available Loan Fund cash. Every request, decision, payout and receipt is audited. No profit is paid as part of a mid-cycle withdrawal; surplus or loss is reflected in the cycle's final share-out. No Social Fund is included.",
  defaultPolicy: "A missed repayment must be recorded and the member notified promptly. The maximum initial contractual loan term is the value configured in the structured Constitution & Rules loan-term setting, measured from the disbursement date. The initial service charge at the configured rate is due at disbursement, even if the loan is repaid early; each further charge becomes due at the end of the configured service-charge period on the principal then remaining. Any balance unpaid after the contractual due date is in default from the next calendar day; no additional grace period applies. While overdue, the member is not eligible for a new loan unless the committee approves and records one restructuring, which may extend the due date by no more than the maximum loan term configured in the constitution. Restructuring does not forgive principal or accrued service charges. The committee must document contact attempts, any agreed payment plan, decisions and the reasons for any write-off or recovery action. No additional default penalty or automatic seizure of savings applies unless a separately approved constitutional provision and applicable law permit it.",
};

async function tableExists(connection, table) {
  const [rows] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table],
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column],
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function main() {
  const connection = await db.getConnection();
  try {
    const [[identity]] = await connection.query("SELECT DATABASE() AS database_name");
    const databaseName = String(identity?.database_name || "");
    if (databaseName !== String(process.env.DB_NAME || "cornestone_online_db") || databaseName.toLowerCase().includes("itsinda")) {
      throw new Error(`Refusing Phase 6 configuration against '${databaseName || "(none)"}'. Confirm DB_NAME=cornestone_online_db and that this is the independent CORNESTONE database.`);
    }
    const [companyRows] = await connection.query("SELECT id, settings FROM `groups` WHERE company_key = 'cornestone' FOR UPDATE");
    if (companyRows.length !== 1) throw new Error(`Expected exactly one CORNESTONE company record; found ${companyRows.length}.`);
    for (const table of ["transactions", "loans", "fund_ledger_entries", "financial_receipts", "audit_logs", "cycles", "users", "group_constitutions", "constitution_votes"]) {
      if (!(await tableExists(connection, table))) throw new Error(`Required table '${table}' is missing. Apply the earlier phases before Phase 6.`);
    }

    // Apply idempotent table definitions from the same migration used by fresh install.
    const migrationPath = path.join(__dirname, "..", "migrations", "2026-10-25-phase6-withdrawals-restructuring-idempotency.sql");
    let migration = await fs.readFile(migrationPath, "utf8");
    migration = migration.replace(/^--.*$/gm, "").trim();
    for (const statement of migration.split(/;\s*(?:\n|$)/).map((item) => item.trim()).filter(Boolean)) {
      if (/^ALTER TABLE transactions/i.test(statement) && /MODIFY COLUMN type/i.test(statement)) {
        const [columns] = await connection.query("SHOW COLUMNS FROM transactions LIKE 'type'");
        const enumType = String(columns[0]?.Type || "");
        const existingValues = Array.from(enumType.matchAll(/'([^']+)'/g), (match) => match[1]);
        const desiredValues = ["SHARE_PURCHASE", "SHARE_REDEMPTION", "LOAN_DISBURSEMENT", "LOAN_REPAYMENT", "FINE_PAYMENT"];
        if (existingValues.join("|") !== desiredValues.join("|")) {
          const [[legacyRows]] = await connection.query(
            "SELECT COUNT(*) AS count FROM transactions WHERE type NOT IN ('SHARE_PURCHASE','SHARE_REDEMPTION','LOAN_DISBURSEMENT','LOAN_REPAYMENT','FINE_PAYMENT')",
          );
          if (Number(legacyRows?.count || 0)) throw new Error(`Refusing to remove legacy transaction type values: ${legacyRows.count} row(s) use a type outside the CORNESTONE schema, including possible legacy Social Fund records. Export and review them before migration; no records were changed.`);
          await connection.query(statement);
        }
      } else if (/^ALTER TABLE transactions/i.test(statement) && /ADD COLUMN share_value_at_transaction/i.test(statement)) {
        if (!(await columnExists(connection, "transactions", "share_value_at_transaction"))) await connection.query(statement);
      } else {
        await connection.query(statement);
      }
    }

    await connection.query(
      `UPDATE transactions SET share_value_at_transaction = ROUND(amount / shares_count, 2)
       WHERE type IN ('SHARE_PURCHASE','SHARE_REDEMPTION') AND shares_count > 0
         AND share_value_at_transaction IS NULL`,
    );

    if (await tableExists(connection, "withdrawal_requests") && !(await columnExists(connection, "withdrawal_requests", "share_value_at_request"))) {
      await connection.query("ALTER TABLE withdrawal_requests ADD COLUMN share_value_at_request DECIMAL(12,2) NOT NULL DEFAULT 1000 AFTER requested_amount");
      console.warn("Added the share-value snapshot column to an earlier Phase 6 withdrawal table; existing rows retain a conservative 1,000 RWF snapshot and should be reviewed before payout.");
    }

    const [[loanCount]] = await connection.query("SELECT COUNT(*) AS count FROM loans");
    const [currentConstitutionRows] = await connection.query(
      "SELECT id, constitution_json, approval_method FROM group_constitutions WHERE group_id = ? AND status = 'CURRENT' ORDER BY version_number DESC LIMIT 1",
      [companyRows[0].id],
    );
    const current = currentConstitutionRows[0] || null;
    const initialRulesNotYetRatified = !current || current.approval_method === "LEGACY_IMPORTED";

    let currentSettings = companyRows[0].settings;
    if (typeof currentSettings === "string") currentSettings = JSON.parse(currentSettings || "{}");
    if (!currentSettings || typeof currentSettings !== "object" || Array.isArray(currentSettings)) currentSettings = {};
    // For an unratified legacy import (or first setup), establish the requested
    // initial constitution. If members already approved a constitution, preserve
    // it and require an explicit amendment/vote before deployment if it differs.
    const mergedSettings = initialRulesNotYetRatified
      ? { ...currentSettings, ...DEFAULTS }
      : { ...DEFAULTS, ...currentSettings, socialFundMode: "NONE", socialFundContributionAmount: 0 };
    await connection.query("UPDATE `groups` SET settings = ? WHERE id = ?", [JSON.stringify(mergedSettings), companyRows[0].id]);

    if (current && current.approval_method === "LEGACY_IMPORTED") {
      let terms = current.constitution_json;
      if (typeof terms === "string") terms = JSON.parse(terms || "{}");
      if (!terms || typeof terms !== "object" || Array.isArray(terms)) terms = {};
      const updatedTerms = {
        ...terms,
        ...DEFAULTS,
        fineRules: Array.isArray(terms.fineRules) ? terms.fineRules : [],
        allowOtherFines: typeof terms.allowOtherFines === "boolean" ? terms.allowOtherFines : true,
      };
      await connection.query("UPDATE group_constitutions SET constitution_json = ? WHERE id = ? AND approval_method = 'LEGACY_IMPORTED'", [JSON.stringify(updatedTerms), current.id]);
    } else if (current) {
      const terms = typeof current.constitution_json === "string" ? JSON.parse(current.constitution_json || "{}") : current.constitution_json;
      if (terms?.interestMethod !== "FLAT_PER_PERIOD" || terms?.shareOutFormula !== DEFAULTS.shareOutFormula) {
        console.warn("WARNING: an already member-approved constitution was not overwritten. Review unsupported service-charge methods or a missing share-out formula through a new member-approved Constitution & Rules proposal.");
      }
    }

    console.log("Phase 6 configuration completed.");
    console.log(`New loans use current Constitution & Rules: maximum initial term ${mergedSettings.maxLoanTermDays ?? Number(mergedSettings.maxLoanDurationMonths) * 30} days; initial service charge ${(Number(mergedSettings.interestRate ?? mergedSettings.monthlyInterestRate) * 100).toLocaleString()}% at disbursement; further charges at the configured ${mergedSettings.interestPeriodDays}-day period boundaries. Existing loans retain their saved terms.`);
    console.log("Withdrawals redeem whole shares at face value after committee approval and verified cash reconciliation.");
    console.log("Existing issued loans keep their saved due dates. Existing transaction history was not rewritten.");
    console.log(`Existing loan records found: ${Number(loanCount.count || 0)}.`);
  } catch (error) {
    console.error(`Phase 6 configuration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    connection.release();
    await db.end?.();
  }
}

main().catch((error) => { console.error(`Phase 6 configuration failed: ${error.message}`); process.exitCode = 1; });
