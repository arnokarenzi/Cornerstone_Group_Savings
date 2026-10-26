const db = require("../config/db");
const { insertLedgerEntry, getBookBalance, getLastLedgerEntryId, roundMoney } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { calculateBorrowingCapacity } = require("./loanEligibilityMath");
const { calculateInterestAmount } = require("./constitutionRules");
const { calculateInterestOnRemainingPrincipal, calculatePeriodicServiceChargeAccrual, allocateRepayment } = require("./loanCalculations");
const { DEFAULT_LOAN_DEFAULT_GRACE_DAYS, PAYMENT_POLICY_TIME_ZONE, addCalendarDays, getTodayIsoInTimeZone, isLoanPastGracePeriod } = require("./loanDefaultPolicy");

// Loan terms must come from the currently approved Constitution & Rules settings.
// Initial values belong in constitution provisioning, not as runtime fallbacks here.

function parseSettings(rawSettings) {
  if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) return rawSettings;
  if (typeof rawSettings === "string") {
    try {
      const parsed = JSON.parse(rawSettings);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      throw new Error("Group settings contain invalid JSON.");
    }
  }
  return {};
}

function readNumericSetting(settings, key, { min = 0, exclusiveMin = false, max = Infinity } = {}) {
  const rawValue = settings[key];
  const value = Number(rawValue);
  const belowMinimum = exclusiveMin ? value <= min : value < min;
  if (rawValue === "" || !Number.isFinite(value) || belowMinimum || value > max) {
    const maximumText = Number.isFinite(max) ? ` and no more than ${max}` : "";
    throw new Error(`Group loan setting "${key}" must be a valid number ${exclusiveMin ? "greater than" : "at least"} ${min}${maximumText}.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function requirePositiveAmount(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a number greater than zero.`);
  const rounded = roundMoney(parsed);
  if (rounded <= 0) throw new Error(`${label} must be at least 0.01 RWF.`);
  return rounded;
}

function requireISODate(value, label) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} must be in YYYY-MM-DD format.`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label} must be a valid date in YYYY-MM-DD format.`);
  }
  return date;
}

async function optionalVirtualWindow(connection, meetingId, groupId, cycleId) {
  if (meetingId == null || meetingId === "") return null;
  const parsedMeetingId = requirePositiveInteger(meetingId, "Meeting ID");
  const [meetingRows] = await connection.query(
    `SELECT id FROM meetings
     WHERE id = ? AND group_id = ? AND cycle_id = ? AND status IN ('OPEN','CLOSED')
     FOR UPDATE`,
    [parsedMeetingId, groupId, cycleId],
  );
  if (!meetingRows.length) throw new Error("The selected virtual window does not belong to this group and cycle.");
  return parsedMeetingId;
}

async function requireCurrentBalancedCashCount(connection, groupId, cycleId) {
  const [rows] = await connection.query(
    `SELECT variance, ledger_entry_id_at_count
     FROM cash_reconciliations
     WHERE group_id = ? AND cycle_id = ? AND fund_type = 'LOAN_FUND'
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [groupId, cycleId],
  );
  if (!rows.length) throw new Error("Reconcile the Loan Fund before issuing a loan.");
  const reconciliation = rows[0];
  const latestLedgerId = await getLastLedgerEntryId(connection, groupId, cycleId, "LOAN_FUND");
  const countedLedgerId = reconciliation.ledger_entry_id_at_count == null ? null : Number(reconciliation.ledger_entry_id_at_count);
  if (latestLedgerId !== countedLedgerId) throw new Error("The Loan Fund book changed after the last count. Reconcile it again before issuing a loan.");
  const variance = roundMoney(reconciliation.variance);
  if (Math.abs(variance) >= 0.01) throw new Error(`The Loan Fund has an unresolved cash variance of ${variance.toLocaleString()} RWF. Resolve it and reconcile again before issuing a loan.`);
}

/** Issues a loan without asking the borrower to choose a duration. The current constitution controls its day period. */
async function issueLoan(groupId, cycleId, memberId, principalAmount, meetingId, createdBy, auditMeta = {}, options = {}) {
  const parsedGroupId = requirePositiveInteger(groupId, "Group ID");
  const parsedCycleId = requirePositiveInteger(cycleId, "Cycle ID");
  const parsedMemberId = requirePositiveInteger(memberId, "Borrower member ID");
  const principal = requirePositiveAmount(principalAmount, "Principal amount");
  const parsedCreatedBy = requirePositiveInteger(createdBy, "Recording user ID");

  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [cycleRows] = await connection.query(
      `SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected financial cycle is not active for this group.");
    let loanApplication = null;
    if (options?.applicationId != null) {
      const applicationId = requirePositiveInteger(options.applicationId, "Loan application ID");
      const [applicationRows] = await connection.query(
        `SELECT * FROM loan_applications WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE`,
        [applicationId, parsedGroupId, parsedCycleId],
      );
      if (!applicationRows.length) throw new Error("The approved loan application was not found.");
      loanApplication = applicationRows[0];
      if (loanApplication.status !== "APPROVED") throw new Error("Only an approved loan application can be disbursed.");
      if (Number(loanApplication.member_id) !== parsedMemberId || Math.abs(Number(loanApplication.requested_principal) - principal) > 0.009) throw new Error("Disbursement details do not match the approved loan application.");
      if (Number(loanApplication.requested_by) === parsedCreatedBy) throw new Error("The borrower cannot disburse their own loan.");
      if (Number(loanApplication.reviewed_by) === Number(loanApplication.member_id)) throw new Error("The borrower cannot approve their own loan application.");
      if (Number(loanApplication.reviewed_by) === parsedCreatedBy) throw new Error("A different committee member must confirm the actual loan handover and record disbursement; the approver cannot disburse the same application.");
      if (Number(options.termDays) !== Number(loanApplication.requested_term_days)) throw new Error("The requested loan term does not match the approved application.");
    }
    const parsedMeetingId = await optionalVirtualWindow(connection, meetingId, parsedGroupId, parsedCycleId);

    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [parsedGroupId]);
    if (!groupRows.length) throw new Error("Group not found.");
    const settings = parseSettings(groupRows[0].settings);
    const shareValue = readNumericSetting(settings, "shareValue", { min: 0, exclusiveMin: true, max: 100000000 });
    const loanRatioLimit = readNumericSetting(settings, "loanRatioLimit", { min: 0, exclusiveMin: true, max: 100 });
    const configuredInterestRate = settings.interestRate ?? settings.monthlyInterestRate;
    const interestRate = readNumericSetting({ interestRate: configuredInterestRate }, "interestRate", { min: 0, max: 1 });
    const interestMethodRaw = String(settings.interestMethod || "").toUpperCase();
    const interestMethod = interestMethodRaw === "FLAT_PER_MONTH" ? "FLAT_PER_PERIOD" : interestMethodRaw;
    if (interestMethod !== "FLAT_PER_PERIOD") {
      throw new Error("New loans must use the repeating service-charge method configured in Constitution & Rules. Review and approve a supported service-charge rule before issuing another loan.");
    }
    const interestPeriodDays = requirePositiveInteger(settings.interestPeriodDays, "Constitution service-charge period in days");
    if (interestPeriodDays > 3660) throw new Error("The constitutional service-charge period cannot exceed 3,660 days.");
    // Loan term is separate from the charge period and is read from the currently approved constitution.
    const configuredMaxLoanTermDays = settings.maxLoanTermDays ?? (Number(settings.maxLoanDurationMonths) > 0 ? Number(settings.maxLoanDurationMonths) * 30 : undefined);
    const maxLoanTermDays = requirePositiveInteger(configuredMaxLoanTermDays, "Constitution maximum loan term in days");
    if (maxLoanTermDays > 3660) throw new Error("The constitutional maximum loan term cannot exceed 3,660 days.");
    const loanTermDays = requirePositiveInteger(options?.termDays ?? maxLoanTermDays, "Requested loan term in days");
    if (loanTermDays > maxLoanTermDays) throw new Error(`The requested term exceeds the constitutional maximum of ${maxLoanTermDays} days.`);

    const [memberRows] = await connection.query(
      "SELECT id FROM users WHERE id = ? AND group_id = ? AND is_active = 1",
      [parsedMemberId, parsedGroupId],
    );
    if (!memberRows.length) throw new Error("The selected borrower is not an active member of this group.");

    // A loan is in default from the day after its contractual due date. The implemented
    // committee restructuring workflow is the only way to extend an unpaid loan.
    const [borrowerLoans] = await connection.query(
      `SELECT id, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date_iso, balance_remaining
       FROM loans
       WHERE group_id = ? AND cycle_id = ? AND member_id = ?
         AND status IN ('ACTIVE','DEFAULTED') AND balance_remaining > 0.009 AND due_date IS NOT NULL
       ORDER BY due_date ASC, id ASC FOR UPDATE`,
      [parsedGroupId, parsedCycleId, parsedMemberId],
    );
    const todayKigali = getTodayIsoInTimeZone(new Date(), PAYMENT_POLICY_TIME_ZONE);
    const overdueLoan = borrowerLoans.find((loan) => isLoanPastGracePeriod(
      String(loan.due_date_iso), todayKigali, DEFAULT_LOAN_DEFAULT_GRACE_DAYS,
    ));
    if (overdueLoan) {
      const graceEndDate = addCalendarDays(String(overdueLoan.due_date_iso), DEFAULT_LOAN_DEFAULT_GRACE_DAYS);
      throw new Error(`Loan #${overdueLoan.id} is in default (contractual due date ${overdueLoan.due_date_iso}; default begins ${graceEndDate === overdueLoan.due_date_iso ? addCalendarDays(graceEndDate, 1) : graceEndDate}). No new loan can be issued until it is repaid or a committee-approved restructuring extends its due date.`);
    }

    const [shareRows] = await connection.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN shares_count WHEN type = 'SHARE_REDEMPTION' THEN -shares_count ELSE 0 END), 0) AS total_shares,
         COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' THEN amount WHEN type = 'SHARE_REDEMPTION' THEN -amount ELSE 0 END), 0) AS net_savings_value
       FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND type IN ('SHARE_PURCHASE','SHARE_REDEMPTION') AND status = 'POSTED'`,
      [parsedGroupId, parsedCycleId, parsedMemberId],
    );
    const totalShares = Number(shareRows[0]?.total_shares ?? 0);
    if (!Number.isFinite(totalShares) || totalShares < 0) throw new Error("Could not calculate the borrower's savings.");
    const savingsValue = roundMoney(shareRows[0]?.net_savings_value || 0);
    if (!Number.isFinite(savingsValue) || savingsValue < -0.009) throw new Error("The borrower's net savings value is invalid. Reconcile posted share purchases and redemptions before issuing a loan.");
    const grossBorrowLimit = calculateBorrowingCapacity({ eligibleSavings: savingsValue, loanRatioLimit }).grossBorrowingLimit;
    const [outstandingPrincipalRows] = await connection.query(
      `SELECT COALESCE(SUM(GREATEST(l.principal_amount - COALESCE(p.principal_paid, 0), 0)), 0) AS outstanding_principal
       FROM loans l
       LEFT JOIN (
         SELECT loan_id, SUM(COALESCE(principal_amount, 0)) AS principal_paid
         FROM transactions
         WHERE group_id = ? AND cycle_id = ? AND type = 'LOAN_REPAYMENT' AND status = 'POSTED'
         GROUP BY loan_id
       ) p ON p.loan_id = l.id
       WHERE l.group_id = ? AND l.cycle_id = ? AND l.member_id = ?
         AND l.status NOT IN ('REPAID','CANCELLED') AND l.principal_amount > 0`,
      [parsedGroupId, parsedCycleId, parsedGroupId, parsedCycleId, parsedMemberId],
    );
    const outstandingPrincipal = roundMoney(outstandingPrincipalRows[0]?.outstanding_principal || 0);
    let reservedOtherApplications = 0;
    if (loanApplication) {
      const [reservedRows] = await connection.query(
        `SELECT COALESCE(SUM(requested_principal),0) AS reserved FROM loan_applications
         WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND status IN ('REQUESTED','APPROVED') AND id <> ? FOR UPDATE`,
        [parsedGroupId, parsedCycleId, parsedMemberId, Number(loanApplication.id)],
      );
      reservedOtherApplications = roundMoney(reservedRows[0]?.reserved || 0);
    }
    const maxAdditionalBorrowing = calculateBorrowingCapacity({ eligibleSavings: savingsValue, loanRatioLimit, outstandingPrincipal, reservedApplications: reservedOtherApplications }).availableBorrowing;
    if (principal > maxAdditionalBorrowing + 0.009) {
      throw new Error(`Loan request exceeds the remaining borrowing capacity of ${maxAdditionalBorrowing.toLocaleString()} RWF. The limit is ${loanRatioLimit}× eligible savings (${grossBorrowLimit.toLocaleString()} RWF) less ${outstandingPrincipal.toLocaleString()} RWF outstanding principal.`);
    }

    // Disbursement is a leadership financial action, not a savings contribution,
    // so it is allowed outside the scheduled three-day contribution window.
    await requireCurrentBalancedCashCount(connection, parsedGroupId, parsedCycleId);
    const cashAvailable = await getBookBalance(connection, parsedGroupId, parsedCycleId, "LOAN_FUND");
    if (principal > cashAvailable + 0.001) throw new Error(`The Loan Fund has ${cashAvailable.toLocaleString()} RWF available, which is not enough to disburse ${principal.toLocaleString()} RWF.`);

    // The initial charge uses the rate saved from the constitution at issuance,
    // even if the member repays early. Further charges use this loan's saved
    // service-charge period and rate, not any later constitution amendment.
    const initialInterest = interestMethod === "FLAT_ONCE" || interestMethod === "FLAT_PER_PERIOD"
      ? calculateInterestAmount(principal, interestRate, 1, "FLAT_ONCE") : 0;
    const initialTotalDue = roundMoney(principal + initialInterest);
    const issuedAt = new Date();
    // Calculate due dates from Rwanda's calendar date instead of UTC date so a
    // loan issued shortly after midnight in Kigali is not due one day early.
    const issueDateKigali = getTodayIsoInTimeZone(issuedAt, PAYMENT_POLICY_TIME_ZONE);
    const dueDate = addCalendarDays(issueDateKigali, loanTermDays);
    const chargedPeriods = interestMethod === "FLAT_PER_PERIOD" ? 1 : 0;
    const [loanResult] = await connection.query(
      `INSERT INTO loans
        (group_id, cycle_id, member_id, principal_amount, interest_rate, interest_method,
         interest_period_days, interest_periods_charged, total_interest_due, total_amount_due,
         balance_remaining, due_date, status, disbursed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP)`,
      [parsedGroupId, parsedCycleId, parsedMemberId, principal, interestRate, interestMethod,
        interestPeriodDays, chargedPeriods, initialInterest, initialTotalDue, initialTotalDue, dueDate],
    );

    const ledgerEntryId = await insertLedgerEntry(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      memberId: parsedMemberId, loanId: loanResult.insertId, fundType: "LOAN_FUND",
      entryType: "LOAN_DISBURSEMENT", direction: "OUT", amount: principal, profitEffect: 0,
      notes: `Loan #${loanResult.insertId} disbursed to member ${parsedMemberId}.`,
      sourceType: "LOAN", sourceId: loanResult.insertId, sourceComponent: "DISBURSEMENT", createdBy: parsedCreatedBy,
    });
    const receipt = await createReceipt(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId, memberId: parsedMemberId,
      sourceType: "LOAN", sourceId: loanResult.insertId, sourceComponent: "DISBURSEMENT",
      activityType: "LOAN_DISBURSEMENT", amount: principal,
      summary: `Loan #${loanResult.insertId} disbursed`,
      details: { loanId: loanResult.insertId, ledgerEntryId, principalAmount: principal, interestRate,
        interestMethod, interestPeriodDays, maxLoanTermDays, loanTermDays, initialInterest, totalAmountDue: initialTotalDue, dueDate, loanApplicationId: loanApplication ? Number(loanApplication.id) : null },
      issuedBy: parsedCreatedBy,
    });
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      actorUserId: parsedCreatedBy, action: "LOAN_ISSUED", entityType: "LOAN", entityId: loanResult.insertId,
      afterData: { memberId: parsedMemberId, principalAmount: principal, interestRate, interestMethod,
        interestPeriodDays, maxLoanTermDays, loanTermDays, initialInterest, totalAmountDue: initialTotalDue, dueDate,
        loanApplicationId: loanApplication ? Number(loanApplication.id) : null, receiptNumber: receipt.receiptNumber }, ...auditMeta,
    });

    if (loanApplication) {
      const [applicationUpdate] = await connection.query(
        `UPDATE loan_applications SET status = 'DISBURSED', loan_id = ?, disbursed_by = ?, disbursed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'APPROVED'`,
        [loanResult.insertId, parsedCreatedBy, loanApplication.id, parsedGroupId, parsedCycleId],
      );
      if (Number(applicationUpdate.affectedRows) !== 1) throw new Error("The approved loan application changed while the disbursement was being recorded.");
      await writeAuditEvent(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, actorUserId: parsedCreatedBy,
        action: "LOAN_APPLICATION_DISBURSED", entityType: "LOAN_APPLICATION", entityId: loanApplication.id,
        beforeData: { status: "APPROVED" }, afterData: { status: "DISBURSED", loanId: Number(loanResult.insertId), disbursedBy: parsedCreatedBy, dueDate, loanTermDays, receiptNumber: receipt.receiptNumber }, ...auditMeta,
      });
    }
    await connection.commit();
    transactionStarted = false;
    return { loanId: loanResult.insertId, principalAmount: principal, interestRate, interestMethod,
      interestPeriodDays, maxLoanTermDays, loanTermDays, totalInterestDue: initialInterest, totalAmountDue: initialTotalDue,
      balanceRemaining: initialTotalDue, dueDate, meetingId: parsedMeetingId, receipt, loanApplicationId: loanApplication ? Number(loanApplication.id) : null };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    const wrappedError = new Error(`Loan issuance failed: ${error.message}`, { cause: error });
    wrappedError.code = error.code; wrappedError.sqlMessage = error.sqlMessage; wrappedError.sqlState = error.sqlState;
    throw wrappedError;
  } finally {
    connection.release();
  }
}

/** Repays interest first, then principal, and records both parts in the same DB transaction. */
async function repayLoan(loanId, repaymentAmount, cycleId, meetingId, groupId, createdBy, auditMeta = {}, expectedMemberId = null, paymentSubmissionId = null) {
  const parsedLoanId = requirePositiveInteger(loanId, "Loan ID");
  const parsedCycleId = requirePositiveInteger(cycleId, "Cycle ID");
  const parsedGroupId = requirePositiveInteger(groupId, "Group ID");
  const parsedCreatedBy = requirePositiveInteger(createdBy, "Recording user ID");
  const payment = requirePositiveAmount(repaymentAmount, "Repayment amount");

  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const [cycleRows] = await connection.query(
      `SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected financial cycle is not active for this group.");
    // Loan repayments are accepted outside the virtual savings window. If a virtual
    // window ID is supplied, it is recorded as context but is not required.
    const parsedMeetingId = await optionalVirtualWindow(connection, meetingId, parsedGroupId, parsedCycleId);

    const [loanRows] = await connection.query(
      `SELECT * FROM loans
       WHERE id = ? AND group_id = ? AND cycle_id = ? AND status IN ('ACTIVE','DEFAULTED')
       FOR UPDATE`,
      [parsedLoanId, parsedGroupId, parsedCycleId],
    );
    if (!loanRows.length) throw new Error("Unpaid active or defaulted loan not found in the selected group and cycle.");
    const loan = loanRows[0];
    if (expectedMemberId != null) {
      const parsedExpectedMemberId = requirePositiveInteger(expectedMemberId, "Borrower member ID");
      if (Number(loan.member_id) !== parsedExpectedMemberId) {
        throw new Error("The selected loan does not belong to the selected borrower.");
      }
    }
    let paymentSubmission = null;
    if (paymentSubmissionId != null) {
      const parsedPaymentSubmissionId = requirePositiveInteger(paymentSubmissionId, "Payment submission ID");
      const [paymentRows] = await connection.query(
        `SELECT * FROM member_payment_submissions WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE`,
        [parsedPaymentSubmissionId, parsedGroupId, parsedCycleId],
      );
      if (!paymentRows.length) throw new Error("The member payment submission was not found.");
      paymentSubmission = paymentRows[0];
      if (paymentSubmission.status !== "REQUESTED" || paymentSubmission.purpose !== "LOAN_REPAYMENT") throw new Error("Only a pending loan repayment submission can be confirmed.");
      if (Number(paymentSubmission.member_id) !== Number(loan.member_id) || Number(paymentSubmission.loan_id) !== parsedLoanId) throw new Error("The payment submission does not match this borrower and loan.");
      if (Number(paymentSubmission.intended_recipient_user_id) !== parsedCreatedBy) throw new Error("Only the designated receiving committee member can confirm this payment.");
      if (Math.abs(Number(paymentSubmission.amount) - payment) > 0.009) throw new Error("The received amount does not match the submitted payment amount.");
      if (Number(paymentSubmission.member_id) === parsedCreatedBy) throw new Error("You cannot confirm your own loan repayment.");
    }
    let balance = roundMoney(loan.balance_remaining);
    let totalDue = roundMoney(loan.total_amount_due);
    let totalInterestDue = roundMoney(loan.total_interest_due);
    let periodsCharged = Number(loan.interest_periods_charged || 0);
    const interestMethod = String(loan.interest_method || "LEGACY_FIXED").toUpperCase();
    const usesTrackedSplit = ["FLAT_ONCE", "FLAT_PER_PERIOD"].includes(interestMethod);
    const [priorRepaymentRows] = await connection.query(
      `SELECT COALESCE(SUM(COALESCE(principal_amount, 0)), 0) AS principal_paid,
          COALESCE(SUM(COALESCE(interest_amount, 0)), 0) AS interest_paid
       FROM transactions WHERE group_id = ? AND cycle_id = ? AND loan_id = ?
         AND type = 'LOAN_REPAYMENT' AND status = 'POSTED'`,
      [parsedGroupId, parsedCycleId, parsedLoanId],
    );
    const [repaymentHistory] = await connection.query(
      `SELECT principal_amount, created_at FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND loan_id = ?
         AND type = 'LOAN_REPAYMENT' AND status = 'POSTED'
       ORDER BY created_at ASC, id ASC`,
      [parsedGroupId, parsedCycleId, parsedLoanId],
    );
    const principalPaidPreviously = roundMoney(priorRepaymentRows[0]?.principal_paid || 0);
    const interestPaidPreviously = roundMoney(priorRepaymentRows[0]?.interest_paid || 0);

    let principalRemainingBeforePayment;
    let interestRemainingBeforePayment;
    if (usesTrackedSplit) {
      principalRemainingBeforePayment = Math.max(0, roundMoney(Number(loan.principal_amount) - principalPaidPreviously));
      interestRemainingBeforePayment = Math.max(0, roundMoney(totalInterestDue - interestPaidPreviously));
      balance = roundMoney(principalRemainingBeforePayment + interestRemainingBeforePayment);
      totalDue = roundMoney(Number(loan.principal_amount) + totalInterestDue);
    } else {
      // Historical loans without an auditable split use the stored outstanding
      // balance as authoritative; do not invent principal paid from missing data.
      interestRemainingBeforePayment = Math.min(Math.max(0, totalInterestDue), Math.max(0, roundMoney(totalDue - balance)));
      principalRemainingBeforePayment = Math.max(0, roundMoney(balance - interestRemainingBeforePayment));
    }

    if (interestMethod === "FLAT_PER_PERIOD") {
      const periodDays = requirePositiveInteger(loan.interest_period_days, "Loan interest period in days");
      const accrual = calculatePeriodicServiceChargeAccrual({
        principalAmount: Number(loan.principal_amount),
        interestRate: Number(loan.interest_rate),
        periodDays,
        disbursedAt: loan.disbursed_at,
        now: Date.now(),
        alreadyChargedPeriods: periodsCharged,
        repayments: repaymentHistory,
      });
      const targetPeriods = accrual.targetPeriods;
      const unchargedPeriods = Math.max(0, targetPeriods - periodsCharged);
      if (unchargedPeriods > 0) {
        const newInterest = accrual.addedCharge;
        totalInterestDue = roundMoney(totalInterestDue + newInterest);
        periodsCharged = targetPeriods;
        interestRemainingBeforePayment = Math.max(0, roundMoney(totalInterestDue - interestPaidPreviously));
        principalRemainingBeforePayment = Math.max(0, roundMoney(Number(loan.principal_amount) - principalPaidPreviously));
        balance = roundMoney(principalRemainingBeforePayment + interestRemainingBeforePayment);
        totalDue = roundMoney(Number(loan.principal_amount) + totalInterestDue);
      }
    }
    if (payment > balance + 0.009) {
      throw new Error(`Repayment exceeds this loan's current total outstanding balance of ${balance.toLocaleString()} RWF.`);
    }

    // Split the cash actually received interest-first, then principal. This uses
    // the two remaining components and never rejects a valid payment because a
    // derived split accidentally exceeded the principal amount.
    if (!usesTrackedSplit) {
      interestRemainingBeforePayment = Math.min(interestRemainingBeforePayment, balance);
      principalRemainingBeforePayment = Math.max(0, roundMoney(balance - interestRemainingBeforePayment));
    }
    const allocation = allocateRepayment({
      payment,
      principalRemaining: principalRemainingBeforePayment,
      interestRemaining: interestRemainingBeforePayment,
    });
    const interestPaid = allocation.interestPaid;
    const principalPaid = allocation.principalPaid;
    const newBalance = allocation.balanceRemaining;
    const newStatus = newBalance < 0.01 ? "REPAID" : (String(loan.status) === "DEFAULTED" ? "DEFAULTED" : "ACTIVE");

    await connection.query(
      `UPDATE loans SET balance_remaining = ?, status = ?, total_interest_due = ?, total_amount_due = ?, interest_periods_charged = ? WHERE id = ?`,
      [newBalance, newStatus, totalInterestDue, totalDue, periodsCharged, parsedLoanId],
    );
    const [transactionResult] = await connection.query(
      `INSERT INTO transactions
        (group_id, cycle_id, meeting_id, member_id, loan_id, type, amount, principal_amount, interest_amount, shares_count)
       VALUES (?, ?, ?, ?, ?, 'LOAN_REPAYMENT', ?, ?, ?, 0)`,
      [parsedGroupId, parsedCycleId, parsedMeetingId, loan.member_id, parsedLoanId, payment, principalPaid, interestPaid],
    );

    if (principalPaid > 0) {
      await insertLedgerEntry(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
        memberId: loan.member_id, loanId: parsedLoanId, fundType: "LOAN_FUND",
        entryType: "LOAN_PRINCIPAL_REPAYMENT", direction: "IN", amount: principalPaid,
        profitEffect: 0, notes: `Principal portion of repayment for loan #${parsedLoanId}.`,
        sourceType: "TRANSACTION", sourceId: transactionResult.insertId,
        sourceComponent: "PRINCIPAL", createdBy: parsedCreatedBy,
      });
    }
    if (interestPaid > 0) {
      await insertLedgerEntry(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
        memberId: loan.member_id, loanId: parsedLoanId, fundType: "LOAN_FUND",
        entryType: "LOAN_INTEREST_REPAYMENT", direction: "IN", amount: interestPaid,
        profitEffect: interestPaid, notes: `Interest/service-charge portion of repayment for loan #${parsedLoanId}.`,
        sourceType: "TRANSACTION", sourceId: transactionResult.insertId,
        sourceComponent: "INTEREST", createdBy: parsedCreatedBy,
      });
      await connection.query(
        `UPDATE cycles SET total_interest_collected = COALESCE(total_interest_collected, 0) + ?
         WHERE id = ? AND group_id = ?`,
        [interestPaid, parsedCycleId, parsedGroupId],
      );
    }
    const receipt = await createReceipt(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      memberId: Number(loan.member_id), sourceType: "TRANSACTION", sourceId: transactionResult.insertId,
      sourceComponent: "TOTAL", activityType: "LOAN_REPAYMENT", amount: payment,
      summary: `Repayment for loan #${parsedLoanId}`,
      details: { transactionId: transactionResult.insertId, loanId: parsedLoanId, principalPaid, interestPaid,
        interestAccruedOnThisPayment: roundMoney(totalInterestDue - Number(loan.total_interest_due || 0)),
        balanceRemaining: newBalance, totalInterestDue, status: newStatus }, issuedBy: parsedCreatedBy,
    });
    if (paymentSubmission) {
      const [paymentUpdate] = await connection.query(
        `UPDATE member_payment_submissions SET status = 'APPROVED', verified_by = ?, verified_at = CURRENT_TIMESTAMP,
         transaction_id = ?, receipt_id = ?, decision_notes = 'Receipt confirmed and posted as a loan repayment.'
         WHERE id = ? AND status = 'REQUESTED'`,
        [parsedCreatedBy, transactionResult.insertId, receipt.id, paymentSubmission.id],
      );
      if (Number(paymentUpdate.affectedRows) !== 1) throw new Error("The payment submission changed while repayment was being recorded.");
      await writeAuditEvent(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId, actorUserId: parsedCreatedBy,
        action: "MEMBER_PAYMENT_CONFIRMED", entityType: "MEMBER_PAYMENT", entityId: paymentSubmission.id,
        beforeData: { status: "REQUESTED" }, afterData: { status: "APPROVED", amount: payment, transactionId: Number(transactionResult.insertId), receiptNumber: receipt.receiptNumber }, ...auditMeta,
      });
    }
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      actorUserId: parsedCreatedBy, action: "LOAN_REPAID", entityType: "LOAN_REPAYMENT", entityId: transactionResult.insertId,
      beforeData: { balanceRemaining: balance, status: loan.status },
      afterData: { loanId: parsedLoanId, amount: payment, principalPaid, interestPaid, totalInterestDue,
        interestAccruedOnThisPayment: roundMoney(totalInterestDue - Number(loan.total_interest_due || 0)),
        balanceRemaining: newBalance, status: newStatus, receiptNumber: receipt.receiptNumber }, ...auditMeta,
    });

    await connection.commit();
    transactionStarted = false;
    return {
      loanId: parsedLoanId,
      repaymentAmount: payment,
      principalPaid,
      interestPaid,
      interestAccruedOnThisPayment: roundMoney(totalInterestDue - Number(loan.total_interest_due || 0)),
      totalInterestDue,
      balanceRemaining: newBalance,
      status: newStatus,
      meetingId: parsedMeetingId,
      transactionId: transactionResult.insertId,
      receipt,
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    const wrappedError = new Error(`Repayment failed: ${error.message}`, { cause: error });
    wrappedError.code = error.code;
    wrappedError.sqlMessage = error.sqlMessage;
    wrappedError.sqlState = error.sqlState;
    throw wrappedError;
  } finally {
    connection.release();
  }
}


/** Lists a member's outstanding loans in the group's currently active cycle. */
async function getOutstandingLoans(groupId, cycleId, memberId, queryRunner = db) {
  const parsedGroupId = requirePositiveInteger(groupId, "Group ID");
  const parsedCycleId = requirePositiveInteger(cycleId, "Cycle ID");
  const parsedMemberId = requirePositiveInteger(memberId, "Borrower member ID");

  const [cycleRows] = await queryRunner.query(
    `SELECT id, cycle_number FROM cycles
     WHERE id = ? AND group_id = ? AND status = 'ACTIVE' LIMIT 1`,
    [parsedCycleId, parsedGroupId],
  );
  if (!cycleRows.length) {
    const error = new Error("The selected cycle is not active for this group.");
    error.statusCode = 400;
    throw error;
  }

  const [memberRows] = await queryRunner.query(
    `SELECT id FROM users WHERE id = ? AND group_id = ? LIMIT 1`,
    [parsedMemberId, parsedGroupId],
  );
  if (!memberRows.length) {
    const error = new Error("The selected borrower does not belong to this group.");
    error.statusCode = 404;
    throw error;
  }

  const [rows] = await queryRunner.query(
    `SELECT l.id, l.cycle_id, l.principal_amount, l.interest_rate, l.interest_method, l.interest_period_days,
        l.interest_periods_charged, l.total_interest_due, l.total_amount_due, l.balance_remaining,
        l.due_date, l.status, l.disbursed_at,
        COALESCE(r.principal_paid, 0) AS principal_paid_to_date,
        COALESCE(r.interest_paid, 0) AS interest_paid_to_date
     FROM loans l
     LEFT JOIN (
       SELECT loan_id, SUM(COALESCE(principal_amount, 0)) AS principal_paid, SUM(COALESCE(interest_amount, 0)) AS interest_paid
       FROM transactions WHERE type = 'LOAN_REPAYMENT' AND status = 'POSTED' AND loan_id IS NOT NULL GROUP BY loan_id
     ) r ON r.loan_id = l.id
     WHERE l.group_id = ? AND l.cycle_id = ? AND l.member_id = ?
       AND l.status IN ('ACTIVE','DEFAULTED') AND l.balance_remaining > 0.009
     ORDER BY l.due_date ASC, l.disbursed_at ASC, l.id ASC`,
    [parsedGroupId, parsedCycleId, parsedMemberId],
  );

  const repaymentsByLoan = new Map();
  if (rows.length) {
    const ids = rows.map((loan) => Number(loan.id));
    const placeholders = ids.map(() => "?").join(",");
    const [repaymentHistory] = await queryRunner.query(
      `SELECT loan_id, principal_amount, created_at FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND loan_id IN (${placeholders})
         AND type = 'LOAN_REPAYMENT' AND status = 'POSTED'
       ORDER BY created_at ASC, id ASC`,
      [parsedGroupId, parsedCycleId, ...ids],
    );
    for (const repayment of repaymentHistory) {
      const id = Number(repayment.loan_id);
      if (!repaymentsByLoan.has(id)) repaymentsByLoan.set(id, []);
      repaymentsByLoan.get(id).push(repayment);
    }
  }

  return rows.map((loan) => {
    let projectedInterest = roundMoney(loan.total_interest_due);
    const method = String(loan.interest_method || "LEGACY_FIXED").toUpperCase();
    const principalPaidToDate = roundMoney(loan.principal_paid_to_date || 0);
    const interestPaidToDate = roundMoney(loan.interest_paid_to_date || 0);
    const principalBalanceBeforeProjection = Math.max(0, roundMoney(Number(loan.principal_amount) - principalPaidToDate));
    if (method === "FLAT_PER_PERIOD") {
      const periodDays = Number(loan.interest_period_days);
      const charged = Number(loan.interest_periods_charged || 0);
      if (Number.isSafeInteger(periodDays) && periodDays > 0) {
        const accrual = calculatePeriodicServiceChargeAccrual({
          principalAmount: Number(loan.principal_amount),
          interestRate: Number(loan.interest_rate),
          periodDays,
          disbursedAt: loan.disbursed_at,
          now: Date.now(),
          alreadyChargedPeriods: charged,
          repayments: repaymentsByLoan.get(Number(loan.id)) || [],
        });
        if (accrual.targetPeriods > charged) {
          projectedInterest = roundMoney(projectedInterest + accrual.addedCharge);
        }
      }
    }
    const splitAvailable = ["FLAT_ONCE", "FLAT_PER_PERIOD"].includes(method);
    const interestBalanceRemaining = splitAvailable ? Math.max(0, roundMoney(projectedInterest - interestPaidToDate)) : null;
    const principalBalanceRemaining = splitAvailable ? principalBalanceBeforeProjection : null;
    const projectedTotalDue = roundMoney((principalBalanceRemaining ?? Number(loan.principal_amount)) + (interestBalanceRemaining ?? Math.max(0, projectedInterest - interestPaidToDate)));
    const projectedBalance = splitAvailable ? projectedTotalDue : roundMoney(loan.balance_remaining);
    // Do not invent a principal/interest split for loans issued before repayment components were tracked.
    // For new loans, the UI reflects stored balances plus any completed-but-not-yet-posted interest periods.
    return {
      loanId: Number(loan.id), cycleId: Number(loan.cycle_id), cycleNumber: Number(cycleRows[0].cycle_number),
      principalAmount: roundMoney(loan.principal_amount), principalBalanceRemaining, interestBalanceRemaining,
      totalInterestDue: projectedInterest, totalAmountDue: projectedTotalDue, balanceRemaining: projectedBalance,
      interestMethod: method, interestPeriodDays: loan.interest_period_days == null ? null : Number(loan.interest_period_days),
      dueDate: loan.due_date, status: loan.status, disbursedAt: loan.disbursed_at,
    };
  });
}

module.exports = { issueLoan, repayLoan, getOutstandingLoans };
