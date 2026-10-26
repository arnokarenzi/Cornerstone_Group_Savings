"use strict";

require("dotenv").config();
const fs = require("node:fs");
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
    ca = fs.readFileSync(caPath, "utf8");
    if (!ca.includes("BEGIN CERTIFICATE")) {
      throw new Error("DB_SSL_CA must point to a PEM CA certificate file supplied by the database provider.");
    }
  }

  // Keep certificate validation on. If no private CA is supplied, Node's trusted
  // root CA store is used; managed database providers such as Aiven may require
  // their service CA to be supplied through DB_SSL_CA or DB_SSL_CA_BASE64.
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

const poolOptions = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "cornestone_online_db",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  enableKeepAlive: true,
};
const databaseTls = buildDatabaseTlsOptions();
if (databaseTls) poolOptions.ssl = databaseTls;
const pool = mysql.createPool(poolOptions);

module.exports = pool;
