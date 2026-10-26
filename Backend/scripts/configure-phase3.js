"use strict";
require("dotenv").config();
const db = require("../config/db");

async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS matches FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Number(rows[0]?.matches || 0) > 0;
}

async function tableExists(connection, table) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS matches FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return Number(rows[0]?.matches || 0) > 0;
}

async function main() {
  const connection = await db.getConnection();
  try {
    const [[database]] = await connection.query("SELECT DATABASE() AS name");
    const databaseName = String(database?.name || "");
    if (!databaseName || databaseName.toLowerCase().includes("itsinda") || databaseName !== String(process.env.DB_NAME || "cornestone_online_db")) {
      throw new Error(`Refusing Phase 3 migration on database '${databaseName || "(none)"}'. Set DB_NAME=cornestone_online_db and use the CORNESTONE Phase 2 database.`);
    }
    const [companyRows] = await connection.query("SELECT id FROM `groups` WHERE company_key = 'cornestone' LIMIT 1");
    if (!companyRows.length) throw new Error("CORNESTONE company record was not found. Complete Phase 1/2 setup first.");
    if (!(await tableExists(connection, "users"))) throw new Error("The users table does not exist. Complete the Phase 1 fresh database setup first.");

    const hasTokenVersion = await columnExists(connection, "users", "token_version");
    if (!hasTokenVersion) {
      await connection.query("ALTER TABLE users ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0");
      console.log("Added users.token_version for session revocation after password reset.");
    } else {
      console.log("users.token_version already exists.");
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id BIGINT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_email_verification_token_hash (token_hash),
        KEY idx_email_verification_user_expiry (user_id, expires_at),
        CONSTRAINT fk_email_verification_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
    if (!(await tableExists(connection, "password_reset_tokens"))) {
      await connection.query(`
        CREATE TABLE password_reset_tokens (
          id BIGINT NOT NULL AUTO_INCREMENT,
          user_id INT NOT NULL,
          token_hash CHAR(64) NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          used_at TIMESTAMP NULL DEFAULT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_password_reset_token_hash (token_hash),
          KEY idx_password_reset_user_expiry (user_id, expires_at),
          CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
      `);
    }
    if (!(await tableExists(connection, "auth_audit_events"))) {
      await connection.query(`
        CREATE TABLE auth_audit_events (
          id BIGINT NOT NULL AUTO_INCREMENT,
          user_id INT NULL,
          email VARCHAR(254) NULL,
          event_type VARCHAR(60) NOT NULL,
          success TINYINT(1) NOT NULL DEFAULT 0,
          ip_address VARCHAR(64) NULL,
          user_agent VARCHAR(500) NULL,
          details_json JSON NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_auth_audit_email_created (email, created_at),
          KEY idx_auth_audit_user_created (user_id, created_at),
          CONSTRAINT fk_auth_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
      `);
    }

    // Preserve access for existing trusted, approved users (especially the first
    // administrator). Public registrations are created unverified and pending.
    const [updateResult] = await connection.query(
      "UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE approval_status = 'APPROVED' AND email_verified_at IS NULL",
    );
    console.log("Phase 3 authentication schema is ready.");
    console.log(`Existing approved accounts marked email-verified: ${updateResult.affectedRows}.`);
    console.log("New self-registrations now require email verification and committee approval.");
    console.log("Existing users and financial records were preserved.");
  } catch (error) {
    console.error(`Phase 3 configuration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    connection.release();
    await db.end().catch(() => {});
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
