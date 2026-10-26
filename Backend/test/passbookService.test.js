const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPassbookEvents, activityForEntry, entryLabel } = require("../services/passbookHelpers");

function row(overrides = {}) {
  return {
    id: 1, cycle_id: 3, cycle_number: 1, meeting_id: 8, meeting_number: 2,
    created_at: new Date("2026-01-01T10:00:00.000Z"), source_type: "TRANSACTION", source_id: 10,
    source_component: "TOTAL", entry_type: "SHARE_PURCHASE", direction: "IN", amount: "2000.00",
    transaction_id: 10, transaction_type: "SHARE_PURCHASE", transaction_amount: "2000.00",
    shares_count: 2, fine_reason: null, transaction_status: "POSTED", transaction_created_at: new Date("2026-01-01T10:00:00.000Z"),
    ...overrides,
  };
}

test("passbook computes savings running balance from share purchases", () => {
  const result = buildPassbookEvents([row(), row({ id: 2, source_id: 11, transaction_id: 11, created_at: new Date("2026-01-08T10:00:00Z"), transaction_created_at: new Date("2026-01-08T10:00:00Z"), amount: "1000.00", transaction_amount: "1000.00", shares_count: 1 })]);
  assert.equal(result.summary.savingsBalance, 3000);
  assert.equal(result.events[0].runningSavingsBalance, 2000);
  assert.equal(result.events[1].runningSavingsBalance, 3000);
});

test("reversed share purchase reduces running savings and shows a correction", () => {
  const original = row({ transaction_status: "REVERSED" });
  const reversal = row({
    id: 2, source_type: "REVERSAL", source_id: "1", source_component: "REVERSAL",
    entry_type: "SHARE_PURCHASE_REVERSAL", direction: "OUT", amount: "2000.00", reversal_of_entry_id: 1,
    original_entry_type: "SHARE_PURCHASE", original_source_type: "TRANSACTION", original_source_id: 10,
    original_source_component: "TOTAL", original_transaction_id: 10,
    original_transaction_type: "SHARE_PURCHASE", original_transaction_status: "REVERSED",
    original_shares_count: 2, original_fine_reason: null, notes: "Correction entered in error",
    created_at: new Date("2026-01-01T10:05:00.000Z"),
  });
  const result = buildPassbookEvents([original, reversal]);
  assert.equal(result.summary.savingsBalance, 0);
  assert.equal(result.events[0].status, "REVERSED");
  assert.equal(result.events[1].correction, true);
  assert.equal(result.events[1].runningSavingsBalance, 0);
});

test("repayment principal and interest ledger lines appear as one payment", () => {
  const principal = row({
    id: 3, entry_type: "LOAN_PRINCIPAL_REPAYMENT", source_component: "PRINCIPAL", amount: "800.00",
    transaction_id: 20, source_id: 20, transaction_type: "LOAN_REPAYMENT", transaction_amount: "1000.00",
    transaction_principal_amount: "800.00", transaction_interest_amount: "200.00", transaction_loan_id: 5,
    loan_id: 5, transaction_created_at: new Date("2026-01-02T10:00:00Z"),
  });
  const interest = row({
    id: 4, entry_type: "LOAN_INTEREST_REPAYMENT", source_component: "INTEREST", amount: "200.00",
    transaction_id: 20, source_id: 20, transaction_type: "LOAN_REPAYMENT", transaction_amount: "1000.00",
    transaction_principal_amount: "800.00", transaction_interest_amount: "200.00", transaction_loan_id: 5,
    loan_id: 5, transaction_created_at: new Date("2026-01-02T10:00:00Z"),
  });
  const result = buildPassbookEvents([principal, interest]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].amount, 1000);
  assert.equal(result.events[0].principalAmount, 800);
  assert.equal(result.events[0].interestAmount, 200);
  assert.equal(result.summary.totalLoanRepayments, 1000);
});

test("legacy repayment is displayed with unknown split without guessing principal and interest", () => {
  const legacy = row({
    id: 5, entry_type: "LEGACY_REPAYMENT", source_component: "LEGACY", amount: "500.00",
    transaction_type: "LOAN_REPAYMENT", transaction_amount: "500.00", transaction_status: "POSTED",
    transaction_principal_amount: null, transaction_interest_amount: null,
  });
  const result = buildPassbookEvents([legacy]);
  assert.equal(result.events[0].historicalSplitUnavailable, true);
  assert.equal(result.events[0].principalAmount, null);
  assert.equal(result.events[0].interestAmount, null);
  assert.equal(result.summary.legacyRepayments, 500);
});


test("loan issue and repayments show one running loan balance without duplicating repayment ledger lines", () => {
  const disbursement = row({
    id: 20, entry_type: "LOAN_DISBURSEMENT", source_type: "LOAN", source_id: 9,
    source_component: "DISBURSEMENT", loan_id: 9, joined_loan_id: 9,
    transaction_id: null, transaction_type: null, amount: "1000.00", direction: "OUT",
    loan_total_amount_due: "1200.00", created_at: new Date("2026-01-01T10:00:00Z"),
  });
  const principal = row({
    id: 21, entry_type: "LOAN_PRINCIPAL_REPAYMENT", source_component: "PRINCIPAL", amount: "1000.00",
    transaction_id: 50, source_id: 50, transaction_type: "LOAN_REPAYMENT", transaction_amount: "1200.00",
    transaction_principal_amount: "1000.00", transaction_interest_amount: "200.00", transaction_loan_id: 9,
    loan_id: 9, transaction_created_at: new Date("2026-02-01T10:00:00Z"), created_at: new Date("2026-02-01T10:00:00Z"),
  });
  const interest = row({
    id: 22, entry_type: "LOAN_INTEREST_REPAYMENT", source_component: "INTEREST", amount: "200.00",
    transaction_id: 50, source_id: 50, transaction_type: "LOAN_REPAYMENT", transaction_amount: "1200.00",
    transaction_principal_amount: "1000.00", transaction_interest_amount: "200.00", transaction_loan_id: 9,
    loan_id: 9, transaction_created_at: new Date("2026-02-01T10:00:00Z"), created_at: new Date("2026-02-01T10:00:00Z"),
  });
  const result = buildPassbookEvents([disbursement, principal, interest]);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].runningLoanBalance, 1200);
  assert.equal(result.events[1].runningLoanBalance, 0);
  assert.equal(result.summary.totalLoanDisbursed, 1000);
  assert.equal(result.summary.totalLoanRepayments, 1200);
});

test("legacy Social Fund entries are not included in current passbook totals", () => {
  const social = row({ id: 30, entry_type: "SOCIAL_FUND_CONTRIBUTION", transaction_type: "SOCIAL_FUND", amount: "500.00", transaction_amount: "500.00" });
  const fine = row({ id: 31, entry_type: "FINE_PAYMENT", transaction_type: "FINE_PAYMENT", source_id: 31, transaction_id: 31, amount: "300.00", transaction_amount: "300.00", fine_reason: "Late arrival" });
  const socialReversal = row({
    id: 32, entry_type: "SOCIAL_FUND_CONTRIBUTION_REVERSAL", source_type: "REVERSAL", source_id: "30",
    source_component: "REVERSAL", direction: "OUT", amount: "500.00", reversal_of_entry_id: 30,
    original_entry_type: "SOCIAL_FUND_CONTRIBUTION", original_source_type: "TRANSACTION", original_source_id: 30,
    original_source_component: "TOTAL", original_transaction_id: 30, original_transaction_type: "SOCIAL_FUND",
    original_transaction_status: "REVERSED", original_shares_count: 0,
  });
  const fineReversal = row({
    id: 33, entry_type: "FINE_PAYMENT_REVERSAL", source_type: "REVERSAL", source_id: "31",
    source_component: "REVERSAL", direction: "OUT", amount: "300.00", reversal_of_entry_id: 31,
    original_entry_type: "FINE_PAYMENT", original_source_type: "TRANSACTION", original_source_id: 31,
    original_source_component: "TOTAL", original_transaction_id: 31, original_transaction_type: "FINE_PAYMENT",
    original_transaction_status: "REVERSED", original_shares_count: 0, original_fine_reason: "Late arrival",
  });
  const result = buildPassbookEvents([social, fine, socialReversal, fineReversal]);
  assert.equal(result.summary.finesPaid, 0);
  assert.equal(Object.hasOwn(result.summary, "socialFundContributions"), false);
  assert.equal(result.events[0].category, "OTHER");
});

test("repayment amount can be reconstructed from ledger components when an older transaction has no split columns", () => {
  const principal = row({
    id: 40, entry_type: "LOAN_PRINCIPAL_REPAYMENT", source_component: "PRINCIPAL", amount: "700.00",
    transaction_id: 70, source_id: 70, transaction_type: "LOAN_REPAYMENT", transaction_amount: null,
    transaction_principal_amount: null, transaction_interest_amount: null, transaction_loan_id: 12,
    loan_id: 12, transaction_created_at: new Date("2026-03-01T10:00:00Z"),
  });
  const interest = row({
    id: 41, entry_type: "LOAN_INTEREST_REPAYMENT", source_component: "INTEREST", amount: "100.00",
    transaction_id: 70, source_id: 70, transaction_type: "LOAN_REPAYMENT", transaction_amount: null,
    transaction_principal_amount: null, transaction_interest_amount: null, transaction_loan_id: 12,
    loan_id: 12, transaction_created_at: new Date("2026-03-01T10:00:00Z"),
  });
  const result = buildPassbookEvents([principal, interest]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].amount, 800);
  assert.equal(result.events[0].principalAmount, 700);
  assert.equal(result.events[0].interestAmount, 100);
});


test("legacy late-share fee entries are not categorized as an active contribution type", () => {
  assert.equal(activityForEntry("GUSIBUZA_FEE", "GUSIBUZA_FEE"), "OTHER");
  const fee = row({
    id: 60, source_id: 60, transaction_id: 60, entry_type: "GUSIBUZA_FEE", source_component: "TOTAL",
    transaction_type: "GUSIBUZA_FEE", amount: "100.00", transaction_amount: "100.00", shares_count: 0,
  });
  const result = buildPassbookEvents([fee]);
  assert.equal(result.events[0].category, "OTHER");
  assert.equal(result.summary.savingsBalance, 0);
});

test("cycle share-out payout appears in the member passbook as a cash payout", () => {
  const payout = row({
    id: 90, member_id: 15, entry_type: "SHARE_OUT_DISTRIBUTION", source_type: "CYCLE_PAYOUT",
    source_id: "12", source_component: "TOTAL", transaction_id: null, transaction_type: null,
    amount: "3450.50", direction: "OUT", notes: "Cycle 1 share-out payment",
  });
  const result = buildPassbookEvents([payout]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].category, "SHARE_OUT_PAYOUT");
  assert.equal(result.events[0].activity, "Cycle share-out payout");
  assert.equal(result.events[0].amount, 3450.5);
  assert.equal(result.events[0].direction, "OUT");
});
