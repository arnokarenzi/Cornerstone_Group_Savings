"use strict";

require("dotenv").config();
const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const db = require("../config/db");

const COMPANY_KEY = "cornestone";
const COMPANY_NAME = "CORNESTONE Co.LTD.";

const DEFAULT_SETTINGS = Object.freeze({
  shareValue: 1000,
  minSharesPerMeeting: 0,
  maxSharesPerMeeting: 30,
  loanRatioLimit: 2,
  interestRate: 0.10,
  monthlyInterestRate: 0.10,
  interestMethod: "FLAT_PER_PERIOD",
  interestPeriodDays: 28,
  // Provisional initial term, independently configurable from the service-charge period.
  maxLoanTermDays: 180,
  maxLoanDurationMonths: 6,
  gusibuzaEnabled: false,
  gusibuzaFeeMode: "PER_SHARE",
  gusibuzaFeeAmount: 0,
  socialFundMode: "NONE",
  socialFundContributionAmount: 0,
  fineRules: [],
  allowOtherFines: true,
  meetingFrequency: "FORTNIGHTLY",
  meetingIntervalDays: 14,
  virtualMeetingWindowDays: 3,
  paymentWindowTimeZone: "Africa/Kigali",
  cycleDurationMonths: 12,
  shareOutFormula: "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES",
  withdrawalPolicy: "A member should keep savings in the cycle until cycle closing. An exceptional withdrawal or a departure during the cycle requires a written request, a recorded committee decision, and a verified account reconciliation. Any outstanding loan balance and other confirmed obligations must be settled or covered by a documented repayment agreement before final settlement. The committee must record the amount, reason, approvers, date, and receipt for every approved withdrawal. No automatic forfeiture or deduction may be applied unless it is expressly authorized by the constitution and applicable law.",
  defaultPolicy: "A missed repayment must be recorded and the member notified promptly. The maximum initial contractual loan term is the value configured in the structured Constitution & Rules loan-term setting, measured from the disbursement date. The initial service charge at the configured rate is due at disbursement, even if the loan is repaid early; each further charge becomes due at the end of the configured service-charge period on the principal then remaining. Any balance unpaid after the contractual due date is in default from the next calendar day; no additional grace period applies. While overdue, the member is not eligible for a new loan unless the committee approves and records one restructuring, which may extend the due date by no more than the maximum loan term configured in the constitution. Restructuring does not forgive principal or accrued service charges. The committee must document contact attempts, any agreed payment plan, decisions and the reasons for any write-off or recovery action. No additional default penalty or automatic seizure of savings applies unless a separately approved constitutional provision and applicable law permit it.",
});

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} must be supplied for this one-time setup.`);
  return value;
}

async function main() {
  const databaseName = String(process.env.DB_NAME || "cornestone_online_db").trim();
  if (databaseName.toLowerCase() === "itsinda_db" || databaseName.toLowerCase().includes("itsinda")) {
    throw new Error("Refusing to provision the initial CORNESTONE account against an Itsinda database. Set DB_NAME=cornestone_online_db for the new application database.");
  }

  const fullName = requiredEnv("BOOTSTRAP_ADMIN_NAME").slice(0, 255);
  const email = requiredEnv("BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const password = requiredEnv("BOOTSTRAP_ADMIN_PASSWORD");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL must be a valid email address of at most 254 characters.");
  }
  if (password.length < 12 || password.length > 128) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be between 12 and 128 characters.");
  }
  if (!fullName) throw new Error("BOOTSTRAP_ADMIN_NAME cannot be blank.");

  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const [existingGroupRows] = await connection.query(
      "SELECT id, name FROM `groups` WHERE company_key = ? FOR UPDATE",
      [COMPANY_KEY],
    );
    let groupId;
    if (existingGroupRows.length) {
      groupId = Number(existingGroupRows[0].id);
      const [userRows] = await connection.query(
        "SELECT id FROM users WHERE group_id = ? LIMIT 1 FOR UPDATE",
        [groupId],
      );
      if (userRows.length) {
        throw new Error("The CORNESTONE company already has users. Bootstrap is one-time only and will not create or reset an administrator. Use the normal account recovery process instead.");
      }
    } else {
      const [allGroups] = await connection.query("SELECT COUNT(*) AS total FROM `groups`");
      if (Number(allGroups[0]?.total || 0) > 0) {
        throw new Error("The new database already contains a group/company record. Review it manually before provisioning CORNESTONE.");
      }
      const registrationCode = `CORN-${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
      const [groupResult] = await connection.query(
        "INSERT INTO `groups` (company_key, name, registration_code, settings) VALUES (?, ?, ?, ?)",
        [COMPANY_KEY, COMPANY_NAME, registrationCode, JSON.stringify(DEFAULT_SETTINGS)],
      );
      groupId = Number(groupResult.insertId);
    }

    const [duplicateEmailRows] = await connection.query("SELECT id FROM users WHERE email = ? LIMIT 1 FOR UPDATE", [email]);
    if (duplicateEmailRows.length) throw new Error("That email already belongs to an account. Bootstrap did not change it.");

    const passwordHash = await bcrypt.hash(password, 12);
    const [userResult] = await connection.query(
      `INSERT INTO users
       (group_id, full_name, email, phone_number, password_hash, role, is_active, approval_status, email_verified_at)
       VALUES (?, ?, ?, NULL, ?, 'ADMIN', 1, 'APPROVED', CURRENT_TIMESTAMP)`,
      [groupId, fullName, email, passwordHash],
    );
    const userId = Number(userResult.insertId);

    const [activeCycleRows] = await connection.query(
      "SELECT id FROM cycles WHERE group_id = ? AND status = 'ACTIVE' LIMIT 1 FOR UPDATE",
      [groupId],
    );
    if (!activeCycleRows.length) {
      await connection.query(
        "INSERT INTO cycles (group_id, cycle_number, start_date, end_date, status) VALUES (?, 1, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 12 MONTH), 'ACTIVE')",
        [groupId],
      );
    }

    await connection.query(
      `INSERT INTO auth_audit_events (user_id, email, event_type, success, details_json)
       VALUES (?, ?, 'INITIAL_ADMIN_PROVISIONED', 1, JSON_OBJECT('company', ?, 'role', 'ADMIN'))`,
      [userId, email, COMPANY_NAME],
    );
    await connection.commit();
    transactionStarted = false;

    console.log("CORNESTONE company bootstrap completed successfully.");
    console.log(`Company: ${COMPANY_NAME}`);
    console.log(`Administrator email: ${email}`);
    console.log(`Administrator user ID: ${userId}`);
    console.log("The password is intentionally not printed or saved to a file.");
    console.log("Remove BOOTSTRAP_ADMIN_PASSWORD from the shell/environment after this one-time command completes.");
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error(`Company provisioning failed: ${error.message}`);
  process.exitCode = 1;
});
