"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("member payment CHECK does not reference meeting_id used by ON DELETE SET NULL", () => {
  const migrationPath = path.join(
    __dirname,
    "..",
    "migrations",
    "2026-10-25-phase8-member-finance-workflows.sql",
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  const start = sql.indexOf("CONSTRAINT chk_member_payment_purpose CHECK");
  assert.notEqual(start, -1, "purpose CHECK constraint should exist");
  const end = sql.indexOf(") ENGINE=InnoDB", start);
  assert.notEqual(end, -1, "member payment table should terminate after the CHECK constraint");
  const purposeCheck = sql.slice(start, end);
  assert.doesNotMatch(purposeCheck, /meeting_id/i);
  assert.match(
    sql,
    /CONSTRAINT fk_member_payment_meeting FOREIGN KEY \(meeting_id\) REFERENCES meetings\(id\) ON DELETE SET NULL/i,
  );
});
