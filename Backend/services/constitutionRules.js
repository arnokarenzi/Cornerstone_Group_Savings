const DEFAULT_CONSTITUTION = Object.freeze({
  shareValue: 1000,
  minSharesPerMeeting: 0,
  maxSharesPerMeeting: 30,
  loanRatioLimit: 2,
  monthlyInterestRate: 0.10, // legacy alias; decimal fraction applied per configured day period
  interestRate: 0.10,
  interestMethod: "FLAT_PER_PERIOD",
  interestPeriodDays: 28,
  // Kept as a separate setting: a charge period is not the same as the loan term.
  // These are independent initial defaults; the approved Constitution & Rules supplies live terms.
  maxLoanTermDays: 180,
  maxLoanDurationMonths: 6, // legacy alias for existing clients only
  shareOutFormula: "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES",
  shareOutPolicy: "After all loans and confirmed obligations are settled, the Loan Fund is physically counted and reconciled, and every payout blocker is cleared, the remaining counted Loan Fund cash is distributed in proportion to each member’s net unredeemed shares. A payout may be above or below that member’s net actual share contributions; the cycle’s surplus or loss is shared proportionally by net unredeemed shares. Paid mid-cycle redemptions use the face value captured when the request was submitted, reduce the member’s shares and net contributions, and are not included again in final share-out. No Social Fund is included.",
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
  cycleDurationMonths: 12,
  paymentWindowTimeZone: "Africa/Kigali",
  withdrawalPolicy: "An exceptional withdrawal requires a written request and a recorded committee decision and approval. Withdrawals redeem whole shares at the constitutional face value recorded when requested and remove those shares from future borrowing and share-out calculations. A member with outstanding loan principal or accrued service charges cannot receive a withdrawal payout; a restructuring by itself is not loan settlement or permission to offset debt against savings. A payout is allowed only from reconciled available Loan Fund cash. Every request, decision, payout and receipt is audited. No profit is paid as part of a mid-cycle withdrawal; surplus or loss is reflected in the cycle's final share-out. No Social Fund is included.",
  defaultPolicy: "A missed repayment must be recorded and the member notified promptly. The maximum initial contractual loan term is the value configured in the structured Constitution & Rules loan-term setting, measured from the disbursement date. The initial service charge at the configured rate is due at disbursement, even if the loan is repaid early; each further charge becomes due at the end of the configured service-charge period on the principal then remaining. Any balance unpaid after the contractual due date is in default from the next calendar day; no additional grace period applies. While overdue, the member is not eligible for a new loan unless the committee approves and records one restructuring, which may extend the due date by no more than the maximum loan term configured in the constitution. Restructuring does not forgive principal or accrued service charges. The committee must document contact attempts, any agreed payment plan, decisions and the reasons for any write-off or recovery action. No additional default penalty or automatic seizure of savings applies unless a separately approved constitutional provision and applicable law permit it.",
});

const INTEREST_METHODS = new Set(["FLAT_PER_PERIOD"]);
const GUSIBUZA_FEE_MODES = new Set(["PER_SHARE", "PER_MEETING"]);
const SOCIAL_FUND_MODES = new Set(["NONE", "FLEXIBLE", "FIXED"]);
const MEETING_FREQUENCIES = new Set(["WEEKLY", "FORTNIGHTLY", "MONTHLY", "CUSTOM"]);
const { isAutomaticAbsenceFineLabel } = require("./gusibuzaHelpers");

function parseSettings(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      throw new Error("Group settings contain invalid JSON.");
    }
  }
  return {};
}

function finiteNumber(value, label, { min = 0, minExclusive = false, max = Infinity, integer = false } = {}) {
  const number = Number(value);
  if (value == null || value === "" || !Number.isFinite(number) || (minExclusive ? number <= min : number < min) || number > max || (integer && !Number.isSafeInteger(number))) {
    const minimumText = minExclusive ? `greater than ${min}` : `at least ${min}`;
    const integerText = integer ? " whole number" : "";
    const maxText = Number.isFinite(max) ? ` and no more than ${max}` : "";
    throw new Error(`${label} must be a valid${integerText} ${minimumText}${maxText}.`);
  }
  return number;
}

function normalizeConstitution(input = {}, base = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Constitution terms must be an object.");
  const values = { ...DEFAULT_CONSTITUTION, ...base, ...input };
  const terms = {};

  terms.shareValue = finiteNumber(values.shareValue, "Share value", { min: 0, minExclusive: true, max: 100000000 });
  terms.minSharesPerMeeting = finiteNumber(values.minSharesPerMeeting, "Minimum shares per member per meeting", { min: 0, max: 10000, integer: true });
  if (values.maxSharesPerMeeting == null || values.maxSharesPerMeeting === "") {
    terms.maxSharesPerMeeting = null;
  } else {
    terms.maxSharesPerMeeting = finiteNumber(values.maxSharesPerMeeting, "Maximum shares per member per meeting", { min: 0, max: 10000, integer: true });
    if (terms.maxSharesPerMeeting < terms.minSharesPerMeeting) {
      throw new Error("Maximum shares per meeting cannot be less than the minimum shares per meeting.");
    }
  }
  terms.loanRatioLimit = finiteNumber(values.loanRatioLimit, "Loan-to-savings limit", { min: 0, minExclusive: true, max: 100 });
  const legacyRate = values.monthlyInterestRate ?? DEFAULT_CONSTITUTION.monthlyInterestRate;
  terms.interestRate = finiteNumber(values.interestRate ?? legacyRate, "Interest/service-charge rate", { min: 0, max: 1 });
  terms.monthlyInterestRate = terms.interestRate; // keep existing modules compatible while the UI/API transition to days
  const rawInterestMethod = String(values.interestMethod || "FLAT_PER_PERIOD").toUpperCase();
  // The currently supported method is a repeating service charge. Its rate and
  // period length come from the approved numeric Constitution & Rules settings.
  // A one-time method cannot represent this policy and is normalized here.
  terms.interestMethod = ["FLAT_PER_MONTH", "FLAT_ONCE"].includes(rawInterestMethod)
    ? "FLAT_PER_PERIOD" : rawInterestMethod;
  if (!INTEREST_METHODS.has(terms.interestMethod)) throw new Error("CORNESTONE loans must use the repeating service-charge method currently supported by the application.");
  const periodDays = finiteNumber(values.interestPeriodDays ?? DEFAULT_CONSTITUTION.interestPeriodDays, "Service-charge period in days", { min: 1, max: 3660, integer: true });
  const maxLoanTermDays = finiteNumber(values.maxLoanTermDays ?? DEFAULT_CONSTITUTION.maxLoanTermDays, "Maximum loan term in days", { min: 1, max: 3660, integer: true });
  terms.interestPeriodDays = periodDays;
  terms.maxLoanTermDays = maxLoanTermDays;
  terms.maxLoanDurationMonths = Math.max(1, Math.ceil(maxLoanTermDays / 30)); // legacy alias only
  terms.shareOutFormula = "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES";
  terms.shareOutPolicy = DEFAULT_CONSTITUTION.shareOutPolicy;

  // Late-share / gusibuza fees are not part of the online contribution model.
  // Contributions are only accepted in the scheduled window, with no after-window bypass.
  terms.gusibuzaEnabled = false;
  terms.gusibuzaFeeMode = "PER_SHARE";
  terms.gusibuzaFeeAmount = 0;

  // CORNESTONE does not operate a Social Fund. Ignore legacy client values so
  // an old browser payload cannot reactivate Social Fund collection.
  terms.socialFundMode = "NONE";
  terms.socialFundContributionAmount = 0;

  if (!Array.isArray(values.fineRules)) throw new Error("Fine rules must be a list.");
  if (values.fineRules.length > 30) throw new Error("A maximum of 30 fine rules may be configured.");
  const fineNames = new Set();
  terms.fineRules = values.fineRules.map((rule, index) => {
    const label = String(rule?.label ?? rule?.name ?? "").trim().slice(0, 100);
    if (!label) throw new Error(`Fine rule ${index + 1} needs a name.`);
    const normalizedName = label.toLocaleLowerCase();
    if (fineNames.has(normalizedName)) throw new Error(`The fine rule "${label}" is duplicated.`);
    fineNames.add(normalizedName);
    return { label, amount: finiteNumber(rule?.amount, `Fine amount for "${label}"`, { min: 0, minExclusive: true, max: 100000000 }) };
  });
  if (typeof values.allowOtherFines !== "boolean") throw new Error("Allow-other-fines setting must be true or false.");
  terms.allowOtherFines = values.allowOtherFines;

  terms.meetingFrequency = String(values.meetingFrequency || "WEEKLY").toUpperCase();
  if (!MEETING_FREQUENCIES.has(terms.meetingFrequency)) throw new Error("Choose a valid meeting frequency.");
  const standardIntervals = { WEEKLY: 7, FORTNIGHTLY: 14, MONTHLY: 30 };
  terms.meetingIntervalDays = terms.meetingFrequency === "CUSTOM"
    ? finiteNumber(values.meetingIntervalDays, "Custom virtual payment interval", { min: 1, max: 366, integer: true })
    : standardIntervals[terms.meetingFrequency];
  terms.virtualMeetingWindowDays = finiteNumber(values.virtualMeetingWindowDays ?? DEFAULT_CONSTITUTION.virtualMeetingWindowDays, "Virtual payment window duration", { min: 1, max: terms.meetingIntervalDays, integer: true });
  terms.cycleDurationMonths = finiteNumber(values.cycleDurationMonths, "Savings cycle duration", { min: 1, max: 36, integer: true });
  terms.paymentWindowTimeZone = "Africa/Kigali"; // All CORNESTONE contribution windows use Rwanda local time.

  const withdrawalPolicy = String(values.withdrawalPolicy ?? "").trim();
  const defaultPolicy = String(values.defaultPolicy ?? "").trim();
  if (withdrawalPolicy.length < 10) throw new Error("Withdrawal policy must contain at least 10 characters.");
  if (defaultPolicy.length < 10) throw new Error("Loan-default policy must contain at least 10 characters.");
  if (withdrawalPolicy.length > 3000 || defaultPolicy.length > 3000) throw new Error("Policy text cannot exceed 3,000 characters.");
  terms.withdrawalPolicy = withdrawalPolicy;
  terms.defaultPolicy = defaultPolicy;

  return terms;
}

function calculateInterestAmount(principalAmount, interestRate, periods, interestMethod) {
  const principal = Number(principalAmount);
  const rate = Number(interestRate);
  const periodCount = Number(periods);
  const rawMethod = String(interestMethod || "FLAT_PER_PERIOD").toUpperCase();
  const method = rawMethod === "FLAT_PER_MONTH" ? "FLAT_PER_PERIOD" : rawMethod;
  if (!Number.isFinite(principal) || principal < 0 || !Number.isFinite(rate) || rate < 0 || !Number.isSafeInteger(periodCount) || periodCount < 1 || !["FLAT_ONCE", "FLAT_PER_PERIOD"].includes(method)) {
    throw new Error("Cannot calculate interest from invalid loan terms.");
  }
  // FLAT_PER_PERIOD is normally called once per completed period with the outstanding principal.
  const amount = principal * rate * (method === "FLAT_ONCE" ? 1 : periodCount);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function roundMoneyForRules(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function validateMeetingContributions({
  terms: rawTerms = {},
  existingSharesThisMeeting = 0,
  sharePurchases = [],
  existingSocialFundAmount = 0,
  socialFundTransactions = [],
  fineTransactions = [],
  attendanceStatus = null,
  hasFineAssessment = false,
} = {}) {
  const terms = { ...DEFAULT_CONSTITUTION, ...rawTerms, socialFundMode: "NONE", socialFundContributionAmount: 0 };
  const minShares = Number(terms.minSharesPerMeeting ?? 0);
  const maxShares = terms.maxSharesPerMeeting == null || terms.maxSharesPerMeeting === "" ? null : Number(terms.maxSharesPerMeeting);
  const previousShares = Number(existingSharesThisMeeting || 0);
  if (socialFundTransactions.length > 0 || Number(existingSocialFundAmount || 0) > 0) {
    throw new Error("CORNESTONE does not collect Social Fund contributions. Record savings as share purchases only.");
  }
  if (!Number.isSafeInteger(minShares) || minShares < 0) throw new Error("The company's minimum-share rule is invalid. Review Constitution & Rules.");
  if (!Number.isFinite(previousShares) || previousShares < 0) throw new Error("Existing virtual-window share totals are invalid.");
  if (maxShares !== null && (!Number.isSafeInteger(maxShares) || maxShares < minShares || maxShares < 0)) throw new Error("The company's maximum-share rule is invalid. Review Constitution & Rules.");
  const requestedShares = sharePurchases.reduce((sum, item) => {
    const count = Number(item?.sharesCount);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Shares purchased must be a positive whole number.");
    return sum + count;
  }, 0);
  const hasContributionActivity = sharePurchases.length > 0;
  // This is an online contribution window, not a physical meeting. Attendance is
  // intentionally ignored; eligibility is controlled by the active window and limits.
  if (hasContributionActivity && previousShares + requestedShares < minShares) {
    throw new Error(`The constitution requires at least ${minShares} share(s) per virtual payment window. This member has ${previousShares + requestedShares}.`);
  }
  if (maxShares !== null && previousShares + requestedShares > maxShares) {
    throw new Error(`This member would exceed CORNESTONE's limit of ${maxShares} share(s) in this virtual payment window. Already recorded: ${previousShares}.`);
  }


  const fineRules = Array.isArray(terms.fineRules) ? terms.fineRules : [];
  const allowOtherFines = typeof terms.allowOtherFines === "boolean" ? terms.allowOtherFines : true;
  for (const fine of fineTransactions) {
    const reason = String(fine?.fineReason || "General fine").trim();
    if (isAutomaticAbsenceFineLabel(reason)) {
      throw new Error("Absence without excuse is assessed automatically when the meeting closes and cannot be entered manually.");
    }
    const amount = Number(fine?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Fine amount must be greater than zero.");
    const matchingRule = fineRules.find((rule) => String(rule?.label ?? rule?.name ?? "").trim().toLocaleLowerCase() === reason.toLocaleLowerCase());
    if (!matchingRule && !allowOtherFines) {
      const available = fineRules.map((rule) => String(rule?.label ?? rule?.name ?? "")).filter(Boolean).join(", ");
      throw new Error(`This fine is not listed in the group constitution. Use an approved fine rule${available ? `: ${available}` : "; no fines are currently defined"}.`);
    }
    if (matchingRule) {
      const configuredAmount = Number(matchingRule.amount);
      if (!Number.isFinite(configuredAmount) || Math.abs(amount - configuredAmount) > 0.009) {
        throw new Error(`The constitution sets the fine for "${reason}" at ${Number(matchingRule.amount).toLocaleString()} RWF. The amount entered does not match.`);
      }
    }
  }

  return {
    requestedShares,
    totalSharesThisMeeting: previousShares + requestedShares,
    requestedSocialFund: 0,
    totalSocialFundThisMeeting: 0,
  };
}

function validateMeetingAttendanceForClosure(attendanceRows = []) {
  if (!Array.isArray(attendanceRows) || attendanceRows.length === 0) {
    throw new Error("Record attendance for all active members before closing this meeting.");
  }
  const missing = [];
  const excusedWithoutReason = [];
  for (const row of attendanceRows) {
    const name = String(row.full_name || row.fullName || `Member #${row.member_id ?? row.memberId ?? "?"}`);
    const status = String(row.attendance_status || row.status || "NOT_RECORDED").toUpperCase();
    const notes = String(row.attendance_notes ?? row.notes ?? "").trim();
    if (!["PRESENT", "ABSENT", "EXCUSED"].includes(status)) missing.push(name);
    if (status === "EXCUSED" && !notes) excusedWithoutReason.push(name);
  }
  if (missing.length || excusedWithoutReason.length) {
    const problems = [];
    if (missing.length) problems.push(`mark each active member Present, Absent, or Excused: ${missing.join(", ")}`);
    if (excusedWithoutReason.length) problems.push(`record a reason for each excused member: ${excusedWithoutReason.join(", ")}`);
    throw new Error(`Cannot close this meeting. Please ${problems.join("; ")}.`);
  }
  return { valid: true, membersChecked: attendanceRows.length };
}

function validateFixedSocialFundMeetingClosure() {
  // Kept as a no-op compatibility export for routes from older installations.
  // CORNESTONE has no Social Fund and virtual windows never gate closure on attendance.
  return { enforced: false, presentMembers: 0 };
}


function resolveFineAssessment(rawSettings, input = {}) {
  const settings = parseSettings(rawSettings);
  const rules = Array.isArray(settings.fineRules) ? settings.fineRules : [];
  const allowOtherFines = settings.allowOtherFines !== false;
  const selection = String(input.ruleLabel || input.fineRule || "").trim();
  if (!selection) throw new Error("Select a fine rule before recording a fine.");

  if (selection.toUpperCase() === "OTHER") {
    if (!allowOtherFines) throw new Error("The group's constitution does not allow fines outside the approved list.");
    const reason = String(input.otherReason || input.reason || "").trim();
    if (reason.length < 3) throw new Error("Enter a reason of at least 3 characters for the other fine.");
    if (reason.length > 255) throw new Error("Fine reason cannot exceed 255 characters.");
    const amount = Number(input.otherAmount ?? input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) throw new Error("Enter a valid positive amount for the other fine.");
    return { fineLabel: "Other", reason, amount: roundMoneyForRules(amount) };
  }

  if (isAutomaticAbsenceFineLabel(selection)) {
    throw new Error("Absence without excuse is assessed automatically when the meeting closes and cannot be selected manually.");
  }
  const matchingRule = rules.find((rule) => String(rule?.label ?? rule?.name ?? "").trim().toLocaleLowerCase() === selection.toLocaleLowerCase());
  if (!matchingRule) throw new Error("The selected fine is not in the current approved constitution. Refresh the page and choose a defined rule.");
  const amount = Number(matchingRule.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`The configured amount for fine "${selection}" is invalid. Review the constitution.`);
  return {
    fineLabel: String(matchingRule.label ?? matchingRule.name).trim().slice(0, 100),
    reason: String(matchingRule.label ?? matchingRule.name).trim().slice(0, 255),
    amount: roundMoneyForRules(amount),
  };
}

function majorityThreshold(activeMembers) {
  const count = Number(activeMembers);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("The group must have at least one active member to vote.");
  return Math.floor(count / 2) + 1;
}

function evaluateVoteOutcome({ activeMembers, approvals, rejections, totalVotes }) {
  const threshold = majorityThreshold(activeMembers);
  if (approvals >= threshold) return "CURRENT";
  if (rejections >= threshold) return "REJECTED";
  if (totalVotes >= activeMembers) return "DEADLOCKED";
  return "PENDING";
}

function getInitialConstitutionFromSettings(rawSettings) {
  const settings = parseSettings(rawSettings);
  return normalizeConstitution({
    ...DEFAULT_CONSTITUTION,
    ...settings,
    // Old group settings may store the rate under the legacy property. It is already a decimal fraction.
    monthlyInterestRate: settings.monthlyInterestRate ?? DEFAULT_CONSTITUTION.monthlyInterestRate,
    interestRate: settings.interestRate ?? settings.monthlyInterestRate ?? DEFAULT_CONSTITUTION.monthlyInterestRate,
    interestMethod: settings.interestMethod === "FLAT_PER_MONTH" ? "FLAT_PER_PERIOD" : (settings.interestMethod || "FLAT_PER_PERIOD"),
    interestPeriodDays: settings.interestPeriodDays ?? DEFAULT_CONSTITUTION.interestPeriodDays,
    maxLoanTermDays: settings.maxLoanTermDays ?? DEFAULT_CONSTITUTION.maxLoanTermDays,
    virtualMeetingWindowDays: settings.virtualMeetingWindowDays ?? DEFAULT_CONSTITUTION.virtualMeetingWindowDays,
    gusibuzaEnabled: settings.gusibuzaEnabled === true,
    gusibuzaFeeMode: settings.gusibuzaFeeMode ?? "PER_SHARE",
    gusibuzaFeeAmount: settings.gusibuzaFeeAmount ?? 0,
    fineRules: Array.isArray(settings.fineRules) ? settings.fineRules : [],
    allowOtherFines: typeof settings.allowOtherFines === "boolean" ? settings.allowOtherFines : true,
    maxSharesPerMeeting: settings.maxSharesPerMeeting ?? DEFAULT_CONSTITUTION.maxSharesPerMeeting,
    socialFundMode: "NONE",
    socialFundContributionAmount: 0,
  });
}

module.exports = {
  DEFAULT_CONSTITUTION,
  parseSettings,
  normalizeConstitution,
  majorityThreshold,
  evaluateVoteOutcome,
  calculateInterestAmount,
  validateMeetingContributions,
  validateFixedSocialFundMeetingClosure,
  validateMeetingAttendanceForClosure,
  resolveFineAssessment,
  getInitialConstitutionFromSettings,
};
