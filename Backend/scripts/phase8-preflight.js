"use strict";

require("dotenv").config();
const db = require("../config/db");
const { validateProductionConfig } = require("../security/securityControls");
const { assertConstitutionSettingsMatch } = require("../services/constitutionSettingsValidation");

const REQUIRED_TABLES = [
  "groups", "users", "cycles", "meetings", "transactions", "loans",
  "fund_ledger_entries", "cash_reconciliations", "financial_receipts", "audit_logs",
  "auth_audit_events", "password_reset_tokens", "email_verification_tokens",
  "group_constitutions", "constitution_votes", "withdrawal_requests",
  "loan_restructuring_requests", "financial_idempotency_keys", "member_payment_submissions",
  "loan_applications", "cycle_closures", "cycle_shareout_payouts", "meeting_attendance",
  "meeting_records", "fine_assessments",
];
const REQUIRED_COLUMNS = {
  transactions: ["type", "status", "shares_count", "share_value_at_transaction", "principal_amount", "interest_amount"],
  loans: ["due_date", "balance_remaining", "interest_method", "interest_period_days", "interest_periods_charged"],
  withdrawal_requests: ["share_value_at_request", "shares_to_redeem", "status", "transaction_id", "receipt_id"],
  loan_restructuring_requests: ["loan_id", "original_due_date", "requested_due_date", "status", "reviewed_by"],
  financial_idempotency_keys: ["idempotency_key", "request_hash", "status", "response_json", "completed_at"],
  group_constitutions: ["constitution_json", "status", "approval_method", "resolved_at"],
  users: ["email", "email_verified_at", "approval_status", "is_active", "role"],
  member_payment_submissions: ["purpose", "amount", "intended_recipient_user_id", "fine_assessment_id", "status", "transaction_id", "receipt_id"],
  loan_applications: ["requested_principal", "requested_term_days", "status", "reviewed_by", "loan_id", "disbursed_by"],
};
const REQUIRED_SHARE_OUT_FORMULA = "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES";
function parseJson(value, label) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* report below */ }
  throw new Error(`${label} is not valid JSON.`);
}
async function verifySmtp() {
  const nodemailer = require("nodemailer");
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").trim().toLowerCase() === "true";
  const transport = nodemailer.createTransport({
    host: String(process.env.SMTP_HOST || "").trim(), port, secure,
    requireTLS: !secure && port === 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
  try { await transport.verify(); }
  catch (error) {
    throw new Error(`SMTP verification failed (${String(error?.code || "SMTP_VERIFY_FAILED")}). Check host, port, TLS mode, credentials and sender configuration; no email was sent.`);
  } finally { transport.close(); }
}
async function main() {
  if (String(process.env.NODE_ENV || "").toLowerCase() !== "production") {
    throw new Error("Run with NODE_ENV=production against the intended staging/production configuration.");
  }
  const environmentIssues = validateProductionConfig(process.env);
  if (environmentIssues.length) throw new Error(`Production environment configuration is incomplete:\n${environmentIssues.map((item) => `- ${item}`).join("\n")}`);

  const connection = await db.getConnection();
  try {
    const [[identity]] = await connection.query("SELECT DATABASE() AS database_name, CURRENT_USER() AS db_account, VERSION() AS server_version");
    const databaseName = String(identity?.database_name || "");
    const currentAccount = String(identity?.db_account || "").toLowerCase();
    if (!databaseName || /itsinda/i.test(databaseName)) throw new Error(`Refusing preflight against database '${databaseName || "(none)"}'. Use the independent CORNESTONE database.`);
    if (currentAccount.startsWith("root@") || currentAccount === "root") throw new Error("The application is connected as MariaDB root. Use a dedicated cornestone_app database account with only required privileges.");

    const [tableRows] = await connection.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    const actualTables = new Set(tableRows.map((row) => String(row.TABLE_NAME)));
    const missingTables = REQUIRED_TABLES.filter((table) => !actualTables.has(table));
    if (missingTables.length) throw new Error(`Phase 8 schema is missing tables: ${missingTables.join(", ")}. Back up the database and apply the Phase 8 configuration command after backing up the database.`);

    const [columnRows] = await connection.query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()");
    const columnsByTable = new Map();
    for (const row of columnRows) {
      const table = String(row.TABLE_NAME);
      if (!columnsByTable.has(table)) columnsByTable.set(table, new Set());
      columnsByTable.get(table).add(String(row.COLUMN_NAME));
    }
    const missingColumns = [];
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of columns) if (!columnsByTable.get(table)?.has(column)) missingColumns.push(`${table}.${column}`);
    }
    if (missingColumns.length) throw new Error(`Phase 8 schema is missing columns: ${missingColumns.join(", ")}. Apply the Phase 8 migration before deployment.`);
    const [txTypeRows] = await connection.query("SHOW COLUMNS FROM transactions LIKE 'type'");
    const transactionEnum = String(txTypeRows[0]?.Type || "");
    if (!transactionEnum.includes("SHARE_REDEMPTION")) throw new Error("transactions.type does not support SHARE_REDEMPTION. Apply Phase 7 schema changes.");

    const [groupRows] = await connection.query("SELECT id, name, company_key, settings FROM `groups`");
    if (groupRows.length !== 1 || String(groupRows[0]?.name || "") !== "CORNESTONE Co.LTD." || String(groupRows[0]?.company_key || "") !== "cornestone") {
      throw new Error(`Expected exactly one CORNESTONE Co.LTD. company record, found ${groupRows.length}. Do not deploy a multi-group or misidentified database.`);
    }
    const group = groupRows[0];
    const groupId = Number(group.id);
    const settings = parseJson(group.settings, "CORNESTONE company settings");
    if (String(settings.socialFundMode || "NONE").toUpperCase() !== "NONE" || Number(settings.socialFundContributionAmount || 0) !== 0) {
      throw new Error("Social Fund is enabled in company settings; CORNESTONE excludes Social Fund contributions.");
    }

    const [adminRows] = await connection.query(
      "SELECT COUNT(*) AS count FROM users WHERE group_id = ? AND role = 'ADMIN' AND is_active = 1 AND approval_status = 'APPROVED' AND email_verified_at IS NOT NULL AND email IS NOT NULL",
      [groupId],
    );
    if (Number(adminRows[0]?.count || 0) < 1) throw new Error("At least one active, approved, email-verified ADMIN is required.");

    const [cycles] = await connection.query("SELECT id, cycle_number, status FROM cycles WHERE group_id = ? AND status = 'ACTIVE' ORDER BY id", [groupId]);
    if (cycles.length !== 1) throw new Error(`Expected exactly one ACTIVE savings cycle, found ${cycles.length}. Resolve cycle state before deployment.`);

    const [constitutionRows] = await connection.query(
      "SELECT id, version_number, constitution_json, status, approval_method FROM group_constitutions WHERE group_id = ? AND status = 'CURRENT' ORDER BY version_number DESC LIMIT 2",
      [groupId],
    );
    if (constitutionRows.length !== 1) throw new Error(`Expected exactly one current constitution version, found ${constitutionRows.length}.`);
    const constitution = constitutionRows[0];
    if (constitution.approval_method !== "MEMBER_VOTE") {
      throw new Error("The current constitution is still LEGACY_IMPORTED and has not been formally ratified. Submit the initial rules and proposed share-out formula in Constitution & Rules and obtain the required member vote before inviting real-money transactions.");
    }
    const terms = parseJson(constitution.constitution_json, "Current constitution");
    if (terms.shareOutFormula !== REQUIRED_SHARE_OUT_FORMULA) throw new Error("The current member-approved constitution does not include the documented share-out formula. Submit and approve an amendment before deployment.");
    assertConstitutionSettingsMatch(settings, terms);

    const [[staleKeys]] = await connection.query(
      "SELECT COUNT(*) AS count FROM financial_idempotency_keys WHERE group_id = ? AND status = 'PROCESSING' AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)",
      [groupId],
    );
    if (Number(staleKeys?.count || 0)) throw new Error(`${staleKeys.count} financial action(s) have been stuck in PROCESSING for more than 15 minutes. Review matching transactions, ledger entries, receipts and audit logs before resolving the markers; do not blindly delete them.`);
    const [[pendingWithdrawals]] = await connection.query("SELECT COUNT(*) AS count FROM withdrawal_requests WHERE group_id = ? AND status IN ('REQUESTED','APPROVED')", [groupId]);
    const [[pendingRestructurings]] = await connection.query("SELECT COUNT(*) AS count FROM loan_restructuring_requests WHERE group_id = ? AND status = 'REQUESTED'", [groupId]);
    const [[pendingMemberPayments]] = await connection.query("SELECT COUNT(*) AS count FROM member_payment_submissions WHERE group_id = ? AND status = 'REQUESTED'", [groupId]);
    const [[pendingLoanApplications]] = await connection.query("SELECT COUNT(*) AS count FROM loan_applications WHERE group_id = ? AND status IN ('REQUESTED','APPROVED')", [groupId]);

    console.log("PASS: production environment validates and the API database account is non-root.");
    console.log(`PASS: database '${databaseName}' (${identity.server_version}) has all ${REQUIRED_TABLES.length} required core and Phase 8 and member-finance workflow tables.`);
    console.log("PASS: single-company identity, email-verified administrator, Social Fund exclusion and share-redemption schema verified.");
    console.log(`PASS: active company settings match member-approved Constitution & Rules (maximum initial loan term ${terms.maxLoanTermDays ?? Number(terms.maxLoanDurationMonths) * 30} days; service-charge rate ${Number(terms.interestRate ?? terms.monthlyInterestRate) * 100}%; period ${terms.interestPeriodDays} days; savings window ${terms.virtualMeetingWindowDays}/${terms.meetingIntervalDays} days; cycle ${terms.cycleDurationMonths} months).`);
    console.log(`PASS: current constitution v${constitution.version_number} was member-vote approved and includes the share-out formula.`);
    console.log("PASS: no stale idempotency PROCESSING markers older than 15 minutes were found.");
    if (Number(pendingWithdrawals?.count || 0)) console.warn(`WARNING: ${pendingWithdrawals.count} withdrawal request(s) are pending or approved but unpaid. Resolve or explicitly carry them into launch.`);
    if (Number(pendingRestructurings?.count || 0)) console.warn(`WARNING: ${pendingRestructurings.count} loan restructuring request(s) still need committee decisions.`);
    if (Number(pendingMemberPayments?.count || 0)) console.warn(`WARNING: ${pendingMemberPayments.count} member payment submission(s) still await confirmation/rejection.`);
    if (Number(pendingLoanApplications?.count || 0)) console.warn(`WARNING: ${pendingLoanApplications.count} loan application(s) are awaiting decision/disbursement.`);
  } finally {
    connection.release();
  }
  await verifySmtp();
  console.log("PASS: SMTP connection and authentication verified without sending an email.");
  console.log("\nPhase 9 production preflight passed. Still perform a browser smoke test, frontend build/lint, backup restore, hosting/HTTPS checks, and final financial/legal sign-off.");
}

main().catch(async (error) => {
  console.error(`Phase 9 production preflight FAILED: ${error.message}`);
  try { await db.end(); } catch { /* retain primary error */ }
  process.exitCode = 1;
});
