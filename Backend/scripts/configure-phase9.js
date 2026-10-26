"use strict";
require("dotenv").config();
const db = require("../config/db");

async function main() {
  const connection = await db.getConnection();
  try {
    const [[identity]] = await connection.query("SELECT DATABASE() AS database_name");
    const databaseName = String(identity?.database_name || "");
    if (databaseName !== String(process.env.DB_NAME || "cornestone_online_db") || /itsinda/i.test(databaseName)) {
      throw new Error(`Refusing Phase 9 migration against '${databaseName || "(none)"}'. Confirm DB_NAME=cornestone_online_db and the independent CORNESTONE database.`);
    }
    const [tables] = await connection.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loan_applications'");
    if (!tables.length) throw new Error("loan_applications table is missing. Apply Phase 8 configuration before Phase 9.");
    const [createRows] = await connection.query("SHOW CREATE TABLE loan_applications");
    const createSql = String(createRows[0]?.["Create Table"] || createRows[0]?.["Create View"] || "");
    const hasNamedCheck = /CONSTRAINT\s+[`\\"]?chk_loan_app_term[`\\"]?\s+CHECK/i.test(createSql);
    const checkAllowsConstitutionTerms = hasNamedCheck && /chk_loan_app_term[\s\S]*?requested_term_days[\s\S]*?<=\s*3660/i.test(createSql);
    if (checkAllowsConstitutionTerms) {
      console.log("Phase 9 migration already applied: loan application terms can be stored up to the application's safe schema ceiling; the backend enforces the currently approved constitutional limit.");
      return;
    }
    if (hasNamedCheck) await connection.query("ALTER TABLE loan_applications DROP CONSTRAINT chk_loan_app_term");
    await connection.query("ALTER TABLE loan_applications ADD CONSTRAINT chk_loan_app_term CHECK (requested_term_days > 0 AND requested_term_days <= 3660)");
    console.log("Phase 9 migration applied. The database allows the safe schema range up to 3,660 days, while the service enforces the current Constitution & Rules maximum on each request, approval and disbursement.");
    console.log("Existing loan applications and loans were not changed.");
  } finally {
    connection.release();
    await db.end?.();
  }
}
main().catch((error) => { console.error(`Phase 9 configuration failed: ${error.message}`); process.exitCode = 1; });
