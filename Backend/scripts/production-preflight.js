"use strict";

require("dotenv").config();
const db = require("../config/db");
const { validateProductionConfig } = require("../security/securityControls");
const { assertEmailProviderConfiguration } = require("../services/emailService");

const REQUIRED_TABLES = [
  "groups", "users", "cycles", "meetings", "transactions", "loans",
  "fund_ledger_entries", "cash_reconciliations", "financial_receipts", "audit_logs",
  "auth_audit_events", "password_reset_tokens", "email_verification_tokens",
  "group_constitutions", "constitution_votes", "fine_assessments", "meeting_records",
  "meeting_attendance", "cycle_closures", "cycle_shareout_payouts",
];
const REQUIRED_COLUMNS = {
  groups: ["company_key", "settings"],
  users: ["email", "email_verified_at", "approval_status", "token_version", "is_active"],
  cycles: ["cycle_number", "start_date", "end_date", "status"],
  transactions: ["type", "status", "shares_count", "principal_amount", "interest_amount"],
  loans: ["due_date", "balance_remaining", "interest_method", "interest_period_days", "interest_periods_charged"],
  fund_ledger_entries: ["fund_type", "source_type", "source_id", "source_component"],
  cash_reconciliations: ["ledger_entry_id_at_count", "variance", "witness_member_id"],
  financial_receipts: ["receipt_number", "source_type", "source_id", "source_component"],
  auth_audit_events: ["event_type", "details_json", "created_at"],
  email_verification_tokens: ["token_hash", "expires_at", "used_at"],
  password_reset_tokens: ["token_hash", "expires_at", "used_at"],
};

function safeSettings(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(String(raw || "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error("The CORNESTONE company settings are not valid JSON.");
  }
}



async function main() {
  if (String(process.env.NODE_ENV || "").toLowerCase() !== "production") {
    throw new Error("Run this command with NODE_ENV=production so it checks the actual production settings.");
  }
  const configurationProblems = validateProductionConfig(process.env);
  if (configurationProblems.length) {
    throw new Error(`Production environment configuration is incomplete:\n${configurationProblems.map((problem) => `- ${problem}`).join("\n")}`);
  }

  const connection = await db.getConnection();
  try {
    const [[identity]] = await connection.query("SELECT DATABASE() AS database_name, CURRENT_USER() AS db_account, VERSION() AS server_version");
    const databaseName = String(identity?.database_name || "");
    const databaseAccount = String(identity?.db_account || "").toLowerCase();
    if (databaseName.toLowerCase().includes("itsinda")) throw new Error("Refusing production preflight against an Itsinda database.");
    if (databaseAccount.startsWith("root@") || databaseAccount === "root") throw new Error("The live API is connected as a MariaDB root account. Configure a dedicated cornestone_app account with only required database privileges.");
    if (!databaseName) throw new Error("The configured database connection did not select a database.");

    const [tableRows] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
    );
    const actualTables = new Set(tableRows.map((row) => String(row.TABLE_NAME)));
    const missingTables = REQUIRED_TABLES.filter((table) => !actualTables.has(table));
    if (missingTables.length) throw new Error(`Required application tables are missing. Apply the correct schema/migrations before deployment: ${missingTables.join(", ")}.`);
    const [columnRows] = await connection.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`,
    );
    const columnsByTable = new Map();
    for (const row of columnRows) {
      if (!columnsByTable.has(String(row.TABLE_NAME))) columnsByTable.set(String(row.TABLE_NAME), new Set());
      columnsByTable.get(String(row.TABLE_NAME)).add(String(row.COLUMN_NAME));
    }
    const missingColumns = [];
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of columns) if (!columnsByTable.get(table)?.has(column)) missingColumns.push(`${table}.${column}`);
    }
    if (missingColumns.length) throw new Error(`Required schema columns are missing. Apply/repair the correct migrations before deployment: ${missingColumns.join(", ")}.`);

    const [groupRows] = await connection.query("SELECT id, name, settings FROM `groups` ORDER BY id");
    if (groupRows.length !== 1 || String(groupRows[0]?.name || "") !== "CORNESTONE Co.LTD.") {
      throw new Error(`Expected exactly one CORNESTONE Co.LTD. company record; found ${groupRows.length} group/company record(s).`);
    }
    const groupId = Number(groupRows[0].id);
    const settings = safeSettings(groupRows[0].settings);
    const socialFundMode = String(settings.socialFundMode || "NONE").toUpperCase();
    const socialAmount = Number(settings.socialFundContributionAmount || 0);
    if (socialFundMode !== "NONE" || socialAmount !== 0) {
      throw new Error("Company configuration enables a Social Fund. Disable it before production; this app's constitution excludes Social Fund processing.");
    }

    const [admins] = await connection.query(
      `SELECT COUNT(*) AS count FROM users WHERE group_id = ? AND role = 'ADMIN' AND is_active = 1
       AND approval_status = 'APPROVED' AND email_verified_at IS NOT NULL AND email IS NOT NULL`, [groupId],
    );
    if (Number(admins[0]?.count || 0) < 1) throw new Error("No active, approved, email-verified ADMIN account exists. Provision or recover an administrator before deployment.");

    const [liveCycles] = await connection.query(
      "SELECT id, cycle_number, status FROM cycles WHERE group_id = ? AND status IN ('ACTIVE','CLOSING') ORDER BY id", [groupId],
    );
    if (liveCycles.length !== 1) throw new Error(`Expected exactly one active/closing savings cycle; found ${liveCycles.length}. Resolve cycle state before deployment.`);

    console.log("PASS: production environment settings are present and non-placeholder.");
    console.log(`PASS: connected to database '${databaseName}' as a non-root application account (${identity.server_version}).`);
    console.log(`PASS: all ${REQUIRED_TABLES.length} required tables and required authentication/finance columns are present.`);
    console.log("PASS: exactly one CORNESTONE company record exists and Social Fund is disabled.");
    console.log("PASS: at least one active, approved, email-verified administrator exists.");
    console.log(`PASS: one live cycle exists (cycle #${liveCycles[0].cycle_number}, status ${liveCycles[0].status}).`);
  } finally {
    connection.release();
  }

  assertEmailProviderConfiguration(process.env, { production: true });
  console.log("PASS: Resend HTTPS transactional-email configuration validated; no message was sent. Run npm run email:test -- recipient@example.com to verify live delivery.");
  console.log("\nPreflight passed. This does not replace a live browser test, frontend build, backup restore test, or legal/financial sign-off.");
}

main().catch(async (error) => {
  console.error(`Production preflight FAILED: ${error.message}`);
  try { await db.end(); } catch { /* preserve the primary failure */ }
  process.exitCode = 1;
});
