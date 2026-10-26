function roundMoney(value) {
  const number = Number(value || 0);
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function activityForEntry(entryType, transactionType = null) {
  const type = String(entryType || "").toUpperCase();
  const txType = String(transactionType || "").toUpperCase();
  if (type.startsWith("SHARE_PURCHASE") || txType === "SHARE_PURCHASE" || type.startsWith("SHARE_REDEMPTION") || txType === "SHARE_REDEMPTION") return "SAVINGS";
  if (type.startsWith("FINE_PAYMENT") || txType === "FINE_PAYMENT") return "FINE";
  if (type === "LOAN_DISBURSEMENT" || txType === "LOAN_DISBURSEMENT") return "LOAN_DISBURSEMENT";
  if (type === "SHARE_OUT_DISTRIBUTION") return "SHARE_OUT_PAYOUT";
  if (type === "LOAN_PRINCIPAL_REPAYMENT" || type === "LOAN_INTEREST_REPAYMENT" || txType === "LOAN_REPAYMENT") return "LOAN_REPAYMENT";
  if (type === "LEGACY_REPAYMENT") return "LEGACY_REPAYMENT";
  return "OTHER";
}

function entryLabel(category, entryType, transactionType, isReversal = false) {
  if (isReversal) {
    const originalCategory = activityForEntry(entryType, transactionType);
    const originalLabel = {
      SAVINGS: "Share purchase correction",
      FINE: "Fine payment correction",
      LOAN_DISBURSEMENT: "Loan disbursement correction",
      LOAN_REPAYMENT: "Loan repayment correction",
      SHARE_OUT_PAYOUT: "Cycle share-out payout correction",
    }[originalCategory] || "Financial correction";
    return originalLabel;
  }
  const type = String(transactionType || entryType || "").toUpperCase();
  const labels = {
    SHARE_PURCHASE: "Savings / share purchase",
    SHARE_REDEMPTION: "Savings withdrawal / share redemption",
    FINE_PAYMENT: "Fine paid",
    LOAN_DISBURSEMENT: "Loan disbursed",
    LOAN_REPAYMENT: "Loan repayment",
    LEGACY_REPAYMENT: "Historical loan repayment — split unavailable",
    LOAN_PRINCIPAL_REPAYMENT: "Loan principal repaid",
    LOAN_INTEREST_REPAYMENT: "Loan interest/service charge paid",
    SHARE_OUT_DISTRIBUTION: "Cycle share-out payout",
  };
  return labels[type] || labels[String(entryType || "").toUpperCase()] || String(entryType || "Financial activity").replaceAll("_", " ").toLowerCase();
}

/**
 * Convert ledger rows into member-readable, meeting-by-meeting passbook events.
 * Pure function so event grouping and running balances can be tested without MySQL.
 */
function buildPassbookEvents(rows) {
  const events = [];
  const repaymentEvents = new Map();

  for (const row of rows) {
    const sourceType = String(row.source_type || "");
    const sourceComponent = String(row.source_component || "");
    const isReversal = sourceType === "REVERSAL" || row.reversal_of_entry_id != null || String(row.entry_type || "").endsWith("_REVERSAL");
    const underlyingEntryType = isReversal ? (row.original_entry_type || String(row.entry_type || "").replace(/_REVERSAL$/, "")) : row.entry_type;
    const underlyingSourceType = isReversal ? (row.original_source_type || "") : sourceType;
    const underlyingSourceComponent = isReversal ? (row.original_source_component || "") : sourceComponent;
    const transactionType = isReversal ? row.original_transaction_type : row.transaction_type;
    const transactionId = isReversal ? row.original_transaction_id : row.transaction_id;
    const transactionStatus = isReversal ? row.original_transaction_status : row.transaction_status;
    const sharesCount = nullableNumber(isReversal ? row.original_shares_count : row.shares_count) || 0;
    const fineReason = isReversal ? row.original_fine_reason : row.fine_reason;
    const category = activityForEntry(underlyingEntryType, transactionType);

    // Repayments have separate principal and interest ledger lines but represent one
    // member-facing payment. Group the lines by transaction so the total isn't duplicated.
    if (!isReversal && underlyingSourceType === "TRANSACTION" &&
        transactionType === "LOAN_REPAYMENT" && ["PRINCIPAL", "INTEREST"].includes(underlyingSourceComponent)) {
      const key = String(transactionId);
      let event = repaymentEvents.get(key);
      if (!event) {
        event = {
          id: `TX-${key}`,
          transactionId: Number(transactionId),
          ledgerEntryIds: [],
          cycleId: Number(row.cycle_id),
          cycleNumber: Number(row.cycle_number),
          meetingId: row.meeting_id == null ? null : Number(row.meeting_id),
          meetingNumber: row.meeting_number == null ? null : Number(row.meeting_number),
          occurredAt: row.transaction_created_at || row.created_at,
          category: "LOAN_REPAYMENT",
          activity: "Loan repayment",
          entryType: "LOAN_REPAYMENT",
          amount: roundMoney(row.transaction_amount ?? 0),
          _transactionAmountAvailable: Number(row.transaction_amount || 0) > 0,
          direction: "IN",
          sharesCount: 0,
          fineReason: null,
          loanId: nullableNumber(row.transaction_loan_id ?? row.loan_id),
          principalAmount: nullableNumber(row.transaction_principal_amount),
          interestAmount: nullableNumber(row.transaction_interest_amount),
          totalAmountDue: nullableNumber(row.loan_total_amount_due),
          status: transactionStatus || "POSTED",
          historicalSplitUnavailable: false,
          correction: false,
          notes: "",
          sourceType: "TRANSACTION",
          sourceId: String(transactionId),
        };
        if (event.principalAmount == null) event.principalAmount = 0;
        if (event.interestAmount == null) event.interestAmount = 0;
        repaymentEvents.set(key, event);
        events.push(event);
      }
      event.ledgerEntryIds.push(Number(row.id));
      if (underlyingSourceComponent === "PRINCIPAL") event.principalAmount = roundMoney(Math.max(event.principalAmount || 0, Number(row.amount || 0)));
      if (underlyingSourceComponent === "INTEREST") event.interestAmount = roundMoney(Math.max(event.interestAmount || 0, Number(row.amount || 0)));
      continue;
    }

    const amount = roundMoney(row.amount);
    const isLegacyRepayment = category === "LEGACY_REPAYMENT" || (transactionType === "LOAN_REPAYMENT" && sourceComponent === "LEGACY");
    const eventCategory = isLegacyRepayment ? "LEGACY_REPAYMENT" : category;
    const label = entryLabel(eventCategory, underlyingEntryType, isLegacyRepayment ? "LEGACY_REPAYMENT" : transactionType, isReversal);
    events.push({
      id: `LE-${row.id}`,
      transactionId: transactionId == null ? null : Number(transactionId),
      ledgerEntryIds: [Number(row.id)],
      cycleId: Number(row.cycle_id),
      cycleNumber: Number(row.cycle_number),
      meetingId: row.meeting_id == null ? null : Number(row.meeting_id),
      meetingNumber: row.meeting_number == null ? null : Number(row.meeting_number),
      occurredAt: row.created_at,
      category: eventCategory,
      activity: label,
      entryType: row.entry_type,
      amount,
      direction: row.direction,
      sharesCount,
      fineReason: fineReason || (isReversal ? row.notes : null) || null,
      loanId: nullableNumber(row.loan_id ?? row.joined_loan_id ?? row.transaction_loan_id),
      principalAmount: isLegacyRepayment ? null : nullableNumber(row.transaction_principal_amount),
      interestAmount: isLegacyRepayment ? null : nullableNumber(row.transaction_interest_amount),
      totalAmountDue: nullableNumber(row.loan_total_amount_due),
      status: isReversal ? "CORRECTION" : (transactionStatus || "POSTED"),
      historicalSplitUnavailable: isLegacyRepayment,
      correction: isReversal,
      notes: row.notes || "",
      sourceType: sourceType || null,
      sourceId: row.source_id == null ? null : String(row.source_id),
      _rawDirection: row.direction,
      _underlyingEntryType: underlyingEntryType,
    });
  }

  for (const event of repaymentEvents.values()) {
    if (!event._transactionAmountAvailable) {
      event.amount = roundMoney((event.principalAmount || 0) + (event.interestAmount || 0));
    }
    delete event._transactionAmountAvailable;
  }

  events.sort((a, b) => {
    const timeDifference = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
    if (timeDifference !== 0) return timeDifference;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });

  let savingsBalance = 0;
  let finesPaid = 0;
  let totalLoanDisbursed = 0;
  let totalLoanRepayments = 0;
  let principalRepaid = 0;
  let interestPaid = 0;
  let legacyRepayments = 0;
  let runningLoanBalance = 0;
  const outstandingByLoan = new Map();

  for (const event of events) {
    const signed = event.direction === "IN" ? event.amount : -event.amount;
    if (event.category === "SAVINGS") savingsBalance = roundMoney(savingsBalance + signed);
    if (event.category === "FINE") finesPaid = roundMoney(finesPaid + signed);
    if (event.category === "LOAN_DISBURSEMENT") {
      totalLoanDisbursed = roundMoney(totalLoanDisbursed + event.amount);
      const initialDue = event.totalAmountDue == null ? event.amount : event.totalAmountDue;
      if (event.loanId != null) {
        outstandingByLoan.set(event.loanId, roundMoney((outstandingByLoan.get(event.loanId) || 0) + initialDue));
      }
    }
    if (event.category === "LOAN_REPAYMENT") {
      totalLoanRepayments = roundMoney(totalLoanRepayments + event.amount);
      principalRepaid = roundMoney(principalRepaid + (event.principalAmount || 0));
      interestPaid = roundMoney(interestPaid + (event.interestAmount || 0));
      if (event.loanId != null && outstandingByLoan.has(event.loanId)) {
        outstandingByLoan.set(event.loanId, Math.max(0, roundMoney(outstandingByLoan.get(event.loanId) - event.amount)));
      }
    }
    if (event.category === "LEGACY_REPAYMENT") {
      totalLoanRepayments = roundMoney(totalLoanRepayments + event.amount);
      legacyRepayments = roundMoney(legacyRepayments + event.amount);
    }
    runningLoanBalance = roundMoney([...outstandingByLoan.values()].reduce((sum, value) => sum + value, 0));
    event.runningSavingsBalance = savingsBalance;
    event.runningFinesPaid = finesPaid;
    event.runningLoanBalance = runningLoanBalance;
    delete event._rawDirection;
    delete event._underlyingEntryType;
  }

  return {
    events,
    summary: {
      savingsBalance,
      finesPaid,
      totalLoanDisbursed,
      totalLoanRepayments,
      principalRepaid,
      interestPaid,
      legacyRepayments,
    },
  };
}


module.exports = { buildPassbookEvents, roundMoney, activityForEntry, entryLabel };
