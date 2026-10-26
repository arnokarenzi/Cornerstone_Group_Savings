"use strict";

require("dotenv").config();
const fs = require("node:fs/promises");
const nodeFs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

function buildDatabaseTlsOptions(env = process.env) {
  const enabled = String(env.DB_SSL_ENABLED || "false").trim().toLowerCase() === "true";
  if (!enabled) return undefined;

  let ca;
  const encodedCa = String(env.DB_SSL_CA_BASE64 || "").trim();
  const caPath = String(env.DB_SSL_CA || "").trim();
  if (encodedCa) {
    ca = Buffer.from(encodedCa, "base64").toString("utf8");
    if (!ca.includes("BEGIN CERTIFICATE")) {
      throw new Error("DB_SSL_CA_BASE64 must be the base64-encoded PEM CA certificate supplied by the database provider.");
    }
  } else if (caPath) {
    ca = nodeFs.readFileSync(caPath, "utf8");
    if (!ca.includes("BEGIN CERTIFICATE")) {
      throw new Error("DB_SSL_CA must point to a PEM CA certificate file supplied by the database provider.");
    }
  }

  // Validate the server certificate using the supplied provider CA, or Node's
  // trusted root store when the provider uses a publicly trusted certificate.
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

async function main() {
  const databaseName = String(process.env.DB_NAME || "cornestone_online_db").trim();
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error("DB_NAME may contain only letters, numbers, and underscores.");
  }
  if (databaseName.toLowerCase().includes("itsinda")) {
    throw new Error("Refusing to install CORNESTONE into an Itsinda database. Configure a new database such as cornestone_online_db.");
  }
  if (databaseName.toLowerCase() !== "cornestone_online_db" && process.env.ALLOW_CUSTOM_DB_NAME !== "1") {
    throw new Error("For safety, fresh installation expects DB_NAME=cornestone_online_db. To use another newly created database name, set ALLOW_CUSTOM_DB_NAME=1 after confirming it is separate from the old app.");
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: databaseName,
    multipleStatements: true,
    charset: "utf8mb4",
    ssl: buildDatabaseTlsOptions(),
  });

  try {
    const [existingTables] = await connection.query("SHOW TABLES");
    if (existingTables.length) {
      throw new Error(`Database ${databaseName} is not empty (${existingTables.length} tables found). This installer is for a new, empty database and will not alter or delete existing data.`);
    }

    const root = path.resolve(__dirname, "..");
    const corePath = path.join(root, "schema", "000-core-schema.sql");
    console.log(`Installing clean CORNESTONE core schema into ${databaseName}...`);
    await connection.query(await fs.readFile(corePath, "utf8"));

    const migrationsDir = path.join(root, "migrations");
    const migrations = (await fs.readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));
    for (const migration of migrations) {
      console.log(`Applying ${migration}...`);
      await connection.query(await fs.readFile(path.join(migrationsDir, migration), "utf8"));
    }
    console.log("Fresh database schema and migrations installed successfully.");
    console.log("Next step: provision the initial administrator with npm run provision:company and the BOOTSTRAP_ADMIN_* environment variables.");
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Fresh install stopped: ${error.message}`);
  console.error("If a migration failed after installation began, do not blindly rerun this script. Review the SQL error and, for a genuinely new database with no data to preserve, recreate the empty database before retrying.");
  process.exitCode = 1;
});
