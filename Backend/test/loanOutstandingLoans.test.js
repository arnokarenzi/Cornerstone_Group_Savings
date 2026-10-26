"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
// Stub the DB pool before loading the service so this unit test never requires
// database credentials, the dotenv parser, or a running MySQL/MariaDB server.
const dbModulePath = require.resolve("../config/db");
const db = { query: async () => { throw new Error("Unexpected database call"); } };
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: db,
};
const { getOutstandingLoans } = require("../services/loanService");
const originalQuery = db.query;

test("lists only the selected borrower's outstanding loans for the active cycle", async () => {
  const calls = [];
  db.query = async (sql, values) => {
    calls.push({ sql: String(sql), values });
    if (calls.length === 1) return [[{ id: 17, cycle_number: 2 }], []];
    if (calls.length === 2) return [[{ id: 44 }], []];
    if (calls.length === 3) return [[{
      id: 81,
      cycle_id: 17,
      principal_amount: "15000.00",
      total_interest_due: "1500.00",
      total_amount_due: "16500.00",
      balance_remaining: "6500.00",
      due_date: "2026-11-01",
      status: "ACTIVE",
      disbursed_at: "2026-10-01T00:00:00.000Z",
    }], []];
    if (calls.length === 4) return [[], []]; // no dated principal repayments
    throw new Error("Unexpected database call");
  };

  try {
    const loans = await getOutstandingLoans(3, 17, 44);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].values, [17, 3]);
    assert.deepEqual(calls[1].values, [44, 3]);
    assert.deepEqual(calls[2].values, [3, 17, 44]);
    assert.match(calls[2].sql, /member_id = \?/);
    assert.match(calls[2].sql, /status IN \('ACTIVE','DEFAULTED'\)/);
    assert.match(calls[2].sql, /balance_remaining > 0\.009/);
    assert.deepEqual(loans, [{
      loanId: 81,
      cycleId: 17,
      cycleNumber: 2,
      principalAmount: 15000,
      principalBalanceRemaining: null,
      interestBalanceRemaining: null,
      totalInterestDue: 1500,
      totalAmountDue: 16500,
      balanceRemaining: 6500,
      interestMethod: "LEGACY_FIXED",
      interestPeriodDays: null,
      dueDate: "2026-11-01",
      status: "ACTIVE",
      disbursedAt: "2026-10-01T00:00:00.000Z",
    }]);
  } finally {
    db.query = originalQuery;
  }
});

test("does not list loans for a cycle that is not active in the group", async () => {
  let calls = 0;
  db.query = async () => {
    calls += 1;
    return [[], []];
  };
  try {
    await assert.rejects(
      getOutstandingLoans(3, 17, 44),
      (error) => error.statusCode === 400 && /not active/.test(error.message),
    );
    assert.equal(calls, 1);
  } finally {
    db.query = originalQuery;
  }
});

test("rejects a borrower ID that does not belong to the selected group", async () => {
  let calls = 0;
  db.query = async () => {
    calls += 1;
    return calls === 1 ? [[{ id: 17, cycle_number: 2 }], []] : [[], []];
  };
  try {
    await assert.rejects(
      getOutstandingLoans(3, 17, 44),
      (error) => error.statusCode === 404 && /does not belong/.test(error.message),
    );
    assert.equal(calls, 2);
  } finally {
    db.query = originalQuery;
  }
});
