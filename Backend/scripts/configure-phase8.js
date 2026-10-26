"use strict";
require("dotenv").config();
const db = require("../config/db");
const fs = require("node:fs/promises");
const path = require("node:path");

async function tableExists(connection, table) {
  const [rows] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table],
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function main() {
  const connection = await db.getConnection();
  try {
    const [[identity]] = await connection.query("SELECT DATABASE() AS database_name");
    const databaseName = String(identity?.database_name || "");
    if (databaseName !== String(process.env.DB_NAME || "cornestone_online_db") || /itsinda/i.test(databaseName)) {
      throw new Error(`Refusing Phase 8 configuration against '${databaseName || "(none)"}'. Confirm DB_NAME=cornestone_online_db and use the independent CORNESTONE database.`);
    }
    const [companies] = await connection.query("SELECT id, name, company_key FROM `groups` WHERE company_key = 'cornestone'");
    if (companies.length !== 1 || companies[0].name !== "CORNESTONE Co.LTD.") {
      throw new Error(`Expected one CORNESTONE Co.LTD. company record; found ${companies.length}. No changes made.`);
    }
    for (const table of ["users", "cycles", "meetings", "transactions", "loans", "fund_ledger_entries", "financial_receipts", "audit_logs", "financial_idempotency_keys", "withdrawal_requests", "loan_restructuring_requests", "fine_assessments"]) {
      if (!(await tableExists(connection, table))) throw new Error(`Required table '${table}' is missing. Apply earlier phase migrations first.`);
    }
    const file = path.join(__dirname, "..", "migrations", "2026-10-25-phase8-member-finance-workflows.sql");
    const sql = (await fs.readFile(file, "utf8")).replace(/^--.*$/gm, "").trim();
    for (const statement of sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      await connection.query(statement);
    }
    console.log("Phase 8 schema configured successfully.");
    console.log("Created/verified member payment submissions and loan applications tables.");
    console.log("No existing financial rows, constitution settings, or administrator account were changed.");
  } finally {
    connection.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error(`Phase 8 configuration failed: ${error.message}`);
  process.exitCode = 1;
});
