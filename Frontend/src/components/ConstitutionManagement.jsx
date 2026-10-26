import { useCallback, useEffect, useMemo, useState } from "react";
import API from "../services/api";

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const EMPTY_FORM = {
  shareValue: "1000",
  minSharesPerMeeting: "0",
  maxSharesPerMeeting: "30",
  loanRatioLimit: "2",
  // These are initial Constitution & Rules values for a new proposal only.
  // Once the current constitution loads, formFromTerms replaces them with stored terms.
  monthlyInterestPercent: "10",
  interestMethod: "FLAT_PER_PERIOD",
  interestPeriodDays: "28",
  maxLoanTermDays: "180",
  fineRulesText: "",
  allowOtherFines: true,
  meetingFrequency: "FORTNIGHTLY",
  meetingIntervalDays: "14",
  virtualMeetingWindowDays: "3",
  cycleDurationMonths: "12",
  withdrawalPolicy: "Savings are intended to remain in the cycle until cycle closing. An exceptional withdrawal requires a written request and a committee decision, followed by a recorded payout and receipt. A member with any outstanding loan principal or accrued service charge cannot receive a withdrawal payout. A loan extension by itself is not loan settlement and does not authorize an offset against savings. Withdrawals redeem whole shares at the face value recorded when requested, remove the redeemed shares from future borrowing and share-out calculations, and can be paid only after the Loan Fund cash is physically counted and reconciled. Every request, decision, payout, and receipt must be audited. No automatic forfeiture or deduction may be applied unless it is expressly authorized by the constitution and applicable law.",
  defaultPolicy: "A missed repayment must be recorded and the member notified promptly. The maximum initial contractual loan term is the value configured in the structured Constitution & Rules loan-term setting, measured from the disbursement date. The initial service charge at the configured rate is due at disbursement, even if the loan is repaid early; each further charge becomes due at the end of the configured service-charge period on the principal then remaining. Any balance unpaid after the contractual due date is in default from the next calendar day; no additional grace period applies. While overdue, the member is not eligible for a new loan unless the committee approves and records one restructuring, which may extend the due date by no more than the maximum loan term configured in the constitution. Restructuring does not forgive principal or accrued service charges. The committee must document contact attempts, any agreed payment plan, decisions and the reasons for any write-off or recovery action. No additional default penalty or automatic seizure of savings applies unless a separately approved constitutional provision and applicable law permit it.",
};


// The backend currently supports this single share-out calculation. Keep the
// wording explicit in the constitutional page and in every proposal preview.
const SHARE_OUT_FORMULA_ID = "PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES";
const SHARE_OUT_FORMULA_EXPLANATION = "After loans, assessed fines, confirmed obligations and payout blockers are resolved, the Loan Fund is physically counted and reconciled. Each member’s payout is calculated as: (that member’s net unredeemed shares ÷ total net unredeemed shares of all members) × the final reconciled distributable Loan Fund cash. Net unredeemed shares equal posted share purchases minus posted redemptions from completed, paid withdrawals. Any surplus or deficit against net share contributions is therefore shared in the same proportion. A paid mid-cycle withdrawal is not paid again at cycle closing. The application will not prepare a final distribution until all share-out blockers are resolved.";

function isLegacyStockDefaultPolicy(value) {
  // Detect only the previous bundled stock text, so it can be replaced with
  // configuration-driven language. Do not infer or alter a member-written policy.
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const hardCodedChargeClause = /(?:initial|first)\s+\d+(?:\.\d+)?%\s+(?:service charge|interest)/.test(text)
    && /(?:every|each|per)\s+\d+\s+days?/.test(text);
  const hardCodedTermClause = /maximum.{0,80}\b\d+\s+days?\b/.test(text)
    || /maximum term.{0,80}six months/.test(text);
  return hardCodedChargeClause && hardCodedTermClause;
}

function displayDefaultPolicy(value) {
  const normalized = String(value || "").trim();
  return !normalized || isLegacyStockDefaultPolicy(normalized) ? EMPTY_FORM.defaultPolicy : normalized;
}

function formFromTerms(terms = {}) {
  return {
    shareValue: String(terms.shareValue ?? 1000),
    minSharesPerMeeting: String(terms.minSharesPerMeeting ?? 0),
    maxSharesPerMeeting: terms.maxSharesPerMeeting == null ? "30" : String(terms.maxSharesPerMeeting),
    loanRatioLimit: String(terms.loanRatioLimit ?? 2),
    monthlyInterestPercent: (terms.interestRate ?? terms.monthlyInterestRate) == null ? "" : String(Number(terms.interestRate ?? terms.monthlyInterestRate) * 100),
    interestMethod: terms.interestMethod || "FLAT_PER_PERIOD",
    interestPeriodDays: terms.interestPeriodDays == null ? "" : String(terms.interestPeriodDays),
    maxLoanTermDays: terms.maxLoanTermDays != null ? String(terms.maxLoanTermDays)
      : Number(terms.maxLoanDurationMonths) > 0 ? String(Number(terms.maxLoanDurationMonths) * 30) : "",
    fineRulesText: (Array.isArray(terms.fineRules) ? terms.fineRules : []).map((rule) => `${rule.label ?? rule.name}=${rule.amount}`).join("\n"),
    allowOtherFines: terms.allowOtherFines !== false,
    meetingFrequency: terms.meetingFrequency || "FORTNIGHTLY",
    meetingIntervalDays: String(terms.meetingIntervalDays ?? 14),
    virtualMeetingWindowDays: String(terms.virtualMeetingWindowDays ?? 3),
    cycleDurationMonths: String(terms.cycleDurationMonths ?? 12),
    withdrawalPolicy: terms.withdrawalPolicy || EMPTY_FORM.withdrawalPolicy,
    defaultPolicy: displayDefaultPolicy(terms.defaultPolicy),
  };
}

function parseFineRules(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    const separator = line.lastIndexOf("=");
    if (separator < 1) throw new Error(`Fine rule line ${index + 1} must use the format: Reason=Amount (for example, Late arrival=500).`);
    const label = line.slice(0, separator).trim();
    const amountText = line.slice(separator + 1).trim().replaceAll(",", "");
    const amount = Number(amountText);
    if (!label || !Number.isFinite(amount) || amount <= 0) throw new Error(`Fine rule line ${index + 1} needs a reason and positive amount.`);
    return { label, amount };
  });
}

function termsFromForm(form) {
  return {
    shareValue: Number(form.shareValue),
    minSharesPerMeeting: Number(form.minSharesPerMeeting),
    maxSharesPerMeeting: form.maxSharesPerMeeting.trim() === "" ? null : Number(form.maxSharesPerMeeting),
    loanRatioLimit: Number(form.loanRatioLimit),
    monthlyInterestRate: Number(form.monthlyInterestPercent) / 100,
    interestRate: Number(form.monthlyInterestPercent) / 100,
    interestMethod: "FLAT_PER_PERIOD",
    interestPeriodDays: Number(form.interestPeriodDays),
    maxLoanTermDays: Number(form.maxLoanTermDays),
    fineRules: parseFineRules(form.fineRulesText),
    allowOtherFines: Boolean(form.allowOtherFines),
    meetingFrequency: form.meetingFrequency,
    meetingIntervalDays: Number(form.meetingIntervalDays),
    virtualMeetingWindowDays: Number(form.virtualMeetingWindowDays),
    cycleDurationMonths: Number(form.cycleDurationMonths),
    withdrawalPolicy: form.withdrawalPolicy,
    defaultPolicy: form.defaultPolicy,
    shareOutFormula: SHARE_OUT_FORMULA_ID,
  };
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString()} RWF` : "—";
}

function Field({ label, help, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-semibold text-slate-700">{label}</span>
      {children}
      {help && <span className="block text-xs text-slate-500">{help}</span>}
    </label>
  );
}

const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500";

export default function ConstitutionManagement({ user }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const isLeadership = LEADERSHIP_ROLES.includes(String(user?.role || "").toUpperCase());
  const [snapshot, setSnapshot] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [voting, setVoting] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  const fetchConstitution = useCallback(async ({ quiet = false } = {}) => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      setMessage({ type: "error", text: "Your account does not contain a valid group ID. Sign out and sign in again." });
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const response = await API.get(`/groups/${groupId}/constitution`);
      const data = response.data.constitution;
      setSnapshot(data);
      if (!data?.pending) {
        setForm(formFromTerms(data?.current?.terms || {}));
      }
      if (!quiet) setMessage({ type: "", text: "" });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || "Could not load group constitution. Confirm the Phase 3 database migration has been applied." });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void Promise.resolve().then(() => fetchConstitution()); }, [fetchConstitution]);

  const current = snapshot?.current;
  const terms = current?.terms || {};
  const pending = snapshot?.pending;
  const currentFineRules = useMemo(() => Array.isArray(terms.fineRules) ? terms.fineRules : [], [terms.fineRules]);
  const currentRate = Number(terms.interestRate ?? terms.monthlyInterestRate);
  const currentRateLabel = Number.isFinite(currentRate) ? `${(currentRate * 100).toLocaleString()}%` : "not configured";
  const currentChargePeriodLabel = Number.isSafeInteger(Number(terms.interestPeriodDays)) && Number(terms.interestPeriodDays) > 0
    ? `${terms.interestPeriodDays} days` : "not configured";
  const currentLoanTermLabel = Number.isSafeInteger(Number(terms.maxLoanTermDays ?? (Number(terms.maxLoanDurationMonths) * 30)))
    && Number(terms.maxLoanTermDays ?? (Number(terms.maxLoanDurationMonths) * 30)) > 0
    ? `${terms.maxLoanTermDays ?? (Number(terms.maxLoanDurationMonths) * 30)} days` : "not configured";

  const updateForm = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  const handleFrequencyChange = (value) => {
    const intervals = { WEEKLY: "7", FORTNIGHTLY: "14", MONTHLY: "30" };
    setForm((previous) => ({ ...previous, meetingFrequency: value, meetingIntervalDays: intervals[value] || previous.meetingIntervalDays }));
  };

  const handleProposal = async (event) => {
    event.preventDefault();
    if (!snapshot?.current) {
      setMessage({ type: "error", text: "The current Constitution & Rules could not be loaded. Refresh the constitution before submitting a proposal." });
      return;
    }
    setSaving(true);
    setMessage({ type: "", text: "" });
    try {
      const proposedTerms = termsFromForm(form);
      const response = await API.post(`/groups/${groupId}/constitution/proposals`, { terms: proposedTerms, reason });
      setReason("");
      setMessage({ type: "success", text: response.data.message || "Proposal submitted for member voting." });
      await fetchConstitution({ quiet: true });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || error.message || "Could not submit constitution proposal." });
    } finally {
      setSaving(false);
    }
  };

  const handleInitialRatification = async () => {
    if (!isLeadership || !snapshot?.legacyWarning || !current || pending) return;
    const confirmed = window.confirm(
      "This will submit the currently displayed CORNESTONE rules and the proportional net-unredeemed-share share-out formula for a member vote. No rule becomes formally ratified until the required member majority approves it. Continue?",
    );
    if (!confirmed) return;
    setSaving(true);
    setMessage({ type: "", text: "" });
    try {
      const exactCurrentForm = formFromTerms(current.terms || {});
      const response = await API.post(`/groups/${groupId}/constitution/proposals`, {
        terms: termsFromForm(exactCurrentForm),
        reason: "Formal initial ratification of CORNESTONE Co.LTD. Constitution and the proportional net-unredeemed-share share-out formula, including proportional treatment of any surplus or deficit, before the first cycle closes.",
      });
      setMessage({ type: "success", text: response.data?.message || "The initial constitution and share-out formula are now submitted for member voting." });
      await fetchConstitution({ quiet: true });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || error.message || "Could not submit the initial ratification proposal." });
    } finally {
      setSaving(false);
    }
  };

  const handleVote = async (vote) => {
    if (!pending) return;
    setVoting(true);
    setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/constitution/proposals/${pending.id}/votes`, { vote });
      setMessage({ type: "success", text: response.data.message || "Vote recorded." });
      await fetchConstitution({ quiet: true });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || "Could not record your vote." });
    } finally {
      setVoting(false);
    }
  };

  if (loading) return <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading group constitution…</div>;
  if (!snapshot?.current) return (
    <div className="rounded-xl border border-rose-200 bg-white p-6 space-y-3">
      <p role="alert" className="text-sm text-rose-800">{message.text || "The current Constitution & Rules are unavailable. No rule values can be shown safely until they load."}</p>
      <button type="button" onClick={() => void fetchConstitution()} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Reload Constitution &amp; Rules</button>
    </div>
  );

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">CORNESTONE Constitution &amp; Rules</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">These rules govern CORNESTONE Co.LTD. Authorized leadership may propose changes, and a proposal becomes active only after approval by a majority of active, approved, email-verified members.</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${current?.approvalMethod === "MEMBER_VOTE" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
            {current?.approvalMethod === "MEMBER_VOTE" ? `Member-approved v${current?.versionNumber}` : `Interim legacy rules v${current?.versionNumber}`}
          </span>
        </div>

        {snapshot?.legacyWarning && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <strong>Review needed:</strong> the displayed rules were imported from the settings your group already used. They have not been ratified through a member vote in this feature. Review them with the group and submit a proposal for formal approval. Existing loans and historical transactions are not changed by ratifying rules.
          </div>
        )}

        {message.text && <div className={`rounded-lg border p-3 text-sm ${message.type === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{message.text}</div>}

        {snapshot?.legacyWarning && isLeadership && !pending && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-3">
            <h3 className="font-bold text-amber-950">Formal initial ratification required</h3>
            <p className="text-sm leading-6 text-amber-900">The rules shown below are interim imported settings. A member vote is required before cycle share-out can begin. The proposal will include the rule to distribute reconciled remaining Loan Fund cash proportionally by net unredeemed shares, with any surplus or deficit allocated in the same proportion.</p>
            <button type="button" onClick={() => void handleInitialRatification()} disabled={saving} className="rounded-lg bg-amber-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-900 disabled:opacity-50">{saving ? "Submitting proposal…" : "Submit current rules for member vote"}</button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Share price</p><p className="mt-1 font-bold text-slate-900">{money(terms.shareValue)}</p><p className="mt-1 text-xs text-slate-500">Minimum {terms.minSharesPerMeeting ?? 0} shares required per window; maximum {terms.maxSharesPerMeeting == null ? "no configured cap" : `${terms.maxSharesPerMeeting} share(s)`} per member per {terms.virtualMeetingWindowDays ?? 3}-day window.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Borrowing limit</p><p className="mt-1 font-bold text-slate-900">{terms.loanRatioLimit ?? "not configured"}× eligible savings, less outstanding principal</p><p className="mt-1 text-xs text-slate-500">Maximum initial term: {currentLoanTermLabel}.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Interest/service charge</p><p className="mt-1 font-bold text-slate-900">{currentRateLabel} per {currentChargePeriodLabel} on remaining principal</p><p className="mt-1 text-xs text-slate-500">The initial charge is due when the loan is disbursed, even if repaid early. Each further {currentRateLabel} charge is due at the next configured {currentChargePeriodLabel} boundary on the principal then remaining. Existing loans retain their recorded terms.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Virtual savings window</p><p className="mt-1 font-bold text-slate-900">{terms.virtualMeetingWindowDays ?? "not configured"} days every {terms.meetingIntervalDays ?? "not configured"} days</p><p className="mt-1 text-xs text-slate-500">Rwanda time. Loan repayments remain open outside the savings window.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Savings cycle</p><p className="mt-1 font-bold text-slate-900">{terms.cycleDurationMonths ?? "not configured"} months</p><p className="mt-1 text-xs text-slate-500">Cycle closing follows the approved reconciliation and share-out checks.</p></div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:col-span-2 lg:col-span-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-emerald-950">Share-out formula and distribution rule</p><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${current?.approvalMethod === "MEMBER_VOTE" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{current?.approvalMethod === "MEMBER_VOTE" ? `Included in member-approved Constitution v${current?.versionNumber}` : "Interim rule — member vote required"}</span></div><p className="mt-2 text-sm font-semibold text-slate-900">Member payout = (member’s net unredeemed shares ÷ total net unredeemed shares of all members) × final reconciled distributable Loan Fund cash.</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{terms.shareOutPolicy || SHARE_OUT_FORMULA_EXPLANATION}</p><p className="mt-2 text-xs leading-5 text-slate-600">Calculation method: {terms.shareOutFormula || SHARE_OUT_FORMULA_ID}. This is the calculation currently implemented by the application. A different formula must not be adopted until the alternative calculation is implemented, tested, and formally approved by member vote.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fine policy</p>{currentFineRules.length ? <ul className="mt-1 space-y-1 text-sm text-slate-800">{currentFineRules.map((rule, index) => <li key={`${rule.label}-${index}`}>{rule.label}: {money(rule.amount)}{["absence without excuse", "absent without excuse"].includes(String(rule.label || rule.name || "").toLocaleLowerCase()) ? " (automatic assessment disabled for virtual windows)" : ""}</li>)}</ul> : <p className="mt-1 text-sm text-slate-700">No named fine amounts configured.</p>}<p className="mt-1 text-xs text-slate-500">{terms.allowOtherFines === false ? "Only listed fine types are accepted." : "Other fines may be recorded with a reason."}</p></div>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 p-4"><h3 className="font-semibold text-slate-800">Member withdrawal policy</h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{terms.withdrawalPolicy || "Not documented."}</p></div>
          <div className="rounded-xl border border-slate-200 p-4"><h3 className="font-semibold text-slate-800">Loan default policy</h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{displayDefaultPolicy(terms.defaultPolicy)}</p></div>
        </div>
      </section>

      {pending && (
        <section className="rounded-2xl border border-blue-200 bg-white p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-bold text-slate-900">Constitution proposal v{pending.versionNumber}</h2><p className="mt-1 text-sm text-slate-600">Reason: {pending.proposalReason}</p></div>
            <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-800">Awaiting member vote</span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-emerald-50 p-3"><p className="text-xl font-bold text-emerald-800">{pending.approvals}</p><p className="text-xs text-emerald-800">Approve</p></div>
            <div className="rounded-lg bg-rose-50 p-3"><p className="text-xl font-bold text-rose-800">{pending.rejections}</p><p className="text-xs text-rose-800">Reject</p></div>
            <div className="rounded-lg bg-slate-50 p-3"><p className="text-xl font-bold text-slate-900">{pending.votesRequired}</p><p className="text-xs text-slate-600">Votes needed</p></div>
          </div>
          <p className="text-sm text-slate-600">An approval or rejection requires a majority of the eligible electorate ({pending.activeMembers} active, approved, email-verified member(s)). Until then, the current rules remain in force. Each eligible member can vote once.</p>
          <div className="rounded-xl bg-slate-50 p-4 space-y-3">
            <h3 className="font-semibold text-slate-800">Full proposed rules</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
              <p><strong>Share price:</strong> {money(pending.terms.shareValue)}</p>
              <p><strong>Shares/member/meeting:</strong> minimum {pending.terms.minSharesPerMeeting}; maximum {pending.terms.maxSharesPerMeeting == null ? "no cap" : pending.terms.maxSharesPerMeeting}</p>
              <p><strong>Loan cap:</strong> {pending.terms.loanRatioLimit}× savings</p>
              <p><strong>Interest/service charge:</strong> {(Number(pending.terms.interestRate ?? pending.terms.monthlyInterestRate) * 100).toLocaleString()}% per {pending.terms.interestPeriodDays ?? "the configured period"} days on outstanding principal; an initial charge is due at disbursement and each further charge is due at the configured period boundary.</p>
              <p><strong>Maximum initial loan term:</strong> {pending.terms.maxLoanTermDays ?? (Number(pending.terms.maxLoanDurationMonths) > 0 ? Number(pending.terms.maxLoanDurationMonths) * 30 : "not configured")} days</p>
              <p><strong>Virtual savings window:</strong> {pending.terms.virtualMeetingWindowDays ?? "not configured"} days every {pending.terms.meetingIntervalDays ?? "not configured"} days</p>
              <p><strong>Cycle duration:</strong> {pending.terms.cycleDurationMonths} months</p>
              <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3"><p className="font-semibold text-emerald-950">Share-out formula included in this proposal</p><p className="mt-1 text-sm leading-6 text-slate-700">{pending.terms.shareOutPolicy || SHARE_OUT_FORMULA_EXPLANATION}</p><p className="mt-1 text-xs text-slate-600">Formula: (member’s net unredeemed shares ÷ total net unredeemed shares) × final reconciled distributable Loan Fund cash. This rule is part of the proposed constitutional terms being voted on.</p></div>
              <p><strong>Unlisted fines:</strong> {pending.terms.allowOtherFines ? "allowed with a reason" : "not allowed"}</p>
            </div>
            <div><strong className="text-sm">Fine schedule</strong>{Array.isArray(pending.terms.fineRules) && pending.terms.fineRules.length ? <ul className="mt-1 list-disc pl-5 text-sm text-slate-700">{pending.terms.fineRules.map((rule, index) => <li key={`${rule.label}-${index}`}>{rule.label}: {money(rule.amount)}</li>)}</ul> : <p className="mt-1 text-sm text-slate-600">No named fine amounts are configured.</p>}</div>
            <div><strong className="text-sm">Withdrawal policy</strong><p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{pending.terms.withdrawalPolicy}</p></div>
            <div><strong className="text-sm">Loan default policy</strong><p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{displayDefaultPolicy(pending.terms.defaultPolicy)}</p></div>
          </div>
          {pending.userVote ? <p className="rounded-lg bg-slate-100 p-3 text-sm font-medium text-slate-700">Your vote has been recorded: {pending.userVote}. It cannot be changed.</p> : <div className="flex flex-wrap gap-3"><button type="button" onClick={() => void handleVote("APPROVE")} disabled={voting} className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{voting ? "Submitting…" : "Approve constitution"}</button><button type="button" onClick={() => void handleVote("REJECT")} disabled={voting} className="rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50">Reject proposal</button></div>}
        </section>
      )}

      {isLeadership && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="mb-5"><h2 className="text-lg font-bold text-slate-900">Propose Constitution Rules</h2><p className="mt-1 text-sm text-slate-600">Propose updates to the company constitution. A proposal does not immediately change operating rules; active members must vote first. Active financial rules are limited to the online savings and lending model.</p></div>
          {pending ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">There is already a pending proposal. Resolve it through member voting before creating another.</div> : (
            <form onSubmit={handleProposal} className="space-y-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Price per share (RWF)"><input className={inputClass} type="number" min="1" step="0.01" required value={form.shareValue} onChange={(e) => updateForm("shareValue", e.target.value)} /></Field>
                <Field label="Minimum shares per member per virtual window"><input className={inputClass} type="number" min="0" step="1" required value={form.minSharesPerMeeting} onChange={(e) => updateForm("minSharesPerMeeting", e.target.value)} /></Field>
                <Field label="Maximum shares per member per virtual window" help="This limit applies to each configured virtual payment window."><input className={inputClass} type="number" min="0" step="1" value={form.maxSharesPerMeeting} onChange={(e) => updateForm("maxSharesPerMeeting", e.target.value)} /></Field>
                <Field label="Loan limit (multiple of eligible savings)"><input className={inputClass} type="number" min="0.1" max="100" step="0.1" required value={form.loanRatioLimit} onChange={(e) => updateForm("loanRatioLimit", e.target.value)} /></Field>
                <Field label="Service charge per period (%)" help="Enter the percentage as a number (for example, 7.5 for 7.5%), not as a decimal fraction. The charge is applied every configured period to the remaining principal."><input className={inputClass} type="number" min="0" max="100" step="0.01" required value={form.monthlyInterestPercent} onChange={(e) => updateForm("monthlyInterestPercent", e.target.value)} /></Field>
                <Field label="Service-charge period (days)" help={`This configured period controls when each further charge is due. It is separate from the current maximum loan term of ${form.maxLoanTermDays || "—"} days.`}><input className={inputClass} type="number" min="1" max="3660" step="1" required value={form.interestPeriodDays} onChange={(e) => updateForm("interestPeriodDays", e.target.value)} /></Field>
                <Field label="Maximum loan term (days)" help={`This is the maximum initial contractual loan term. It is independent of the configured ${form.interestPeriodDays || "—"}-day service-charge period.`}><input className={inputClass} type="number" min="1" max="3660" step="1" required value={form.maxLoanTermDays} onChange={(e) => updateForm("maxLoanTermDays", e.target.value)} /></Field>
                <Field label="Virtual payment frequency"><select className={inputClass} value={form.meetingFrequency} onChange={(e) => handleFrequencyChange(e.target.value)}><option value="WEEKLY">Every 7 days</option><option value="FORTNIGHTLY">Every 14 days</option><option value="MONTHLY">Every 30 days</option><option value="CUSTOM">Custom interval</option></select></Field>
                <Field label="Payment-window interval (days)" help="Automatically set for standard intervals; editable for custom. The window follows the start date of the active cycle."><input className={inputClass} type="number" min="1" max="366" step="1" required disabled={form.meetingFrequency !== "CUSTOM"} value={form.meetingIntervalDays} onChange={(e) => updateForm("meetingIntervalDays", e.target.value)} /></Field>
                <Field label="Window open for (days)" help="The window must be no longer than the configured payment interval."><input className={inputClass} type="number" min="1" max={form.meetingIntervalDays || 366} step="1" required value={form.virtualMeetingWindowDays} onChange={(e) => updateForm("virtualMeetingWindowDays", e.target.value)} /></Field>
                <Field label="Savings cycle duration (months)"><input className={inputClass} type="number" min="1" max="36" step="1" required value={form.cycleDurationMonths} onChange={(e) => updateForm("cycleDurationMonths", e.target.value)} /></Field>
                
              </div>
              <Field label="Fine rules" help="One per line in the format Reason=Amount, e.g. Late arrival=500. Known fines must be paid at the configured amount."><textarea className={`${inputClass} min-h-24`} value={form.fineRulesText} onChange={(e) => updateForm("fineRulesText", e.target.value)} placeholder={'Absence without excuse=1000\nLate arrival=500'} /></Field>
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700"><input className="mt-1" type="checkbox" checked={form.allowOtherFines} onChange={(e) => updateForm("allowOtherFines", e.target.checked)} /><span><strong>Allow other fines not listed above.</strong><span className="mt-1 block text-xs text-slate-500">If unticked, only named fine types in this constitution may be recorded.</span></span></label>
              <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4" aria-label="Share-out formula included in constitutional proposal">
                <h3 className="font-bold text-emerald-950">Share-out formula included in this constitution proposal</h3>
                <p className="mt-2 text-sm font-semibold text-slate-900">Member payout = (member’s net unredeemed shares ÷ total net unredeemed shares of all members) × final reconciled distributable Loan Fund cash.</p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{SHARE_OUT_FORMULA_EXPLANATION}</p>
                <p className="mt-2 text-xs leading-5 text-slate-600">This clause is included in the proposal and the member vote. The current application implements the formula shown above; choosing a different algorithm requires a code change and tests before it can be put to a vote.</p>
              </section>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Field label="Member withdrawal policy"><textarea className={`${inputClass} min-h-32`} maxLength={3000} required value={form.withdrawalPolicy} onChange={(e) => updateForm("withdrawalPolicy", e.target.value)} /></Field>
                <Field label="Loan default and late repayment policy"><textarea className={`${inputClass} min-h-32`} maxLength={3000} required value={form.defaultPolicy} onChange={(e) => updateForm("defaultPolicy", e.target.value)} /></Field>
              </div>
              <Field label="Reason for this proposal" help="Explain the decision agreed or requested by the group. At least 10 characters."><textarea className={`${inputClass} min-h-20`} maxLength={1000} required minLength={10} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Members agreed during the meeting on 18 October to change the share price…" /></Field>
              <button type="submit" disabled={saving} className="rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? "Submitting proposal…" : "Submit for member approval"}</button>
            </form>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <h2 className="text-lg font-bold text-slate-900">Constitution version history</h2>
        <p className="mt-1 text-sm text-slate-600">Earlier versions are retained for transparency. Approval of new rules affects future transactions only; historical financial entries and already-issued loan terms are not recalculated.</p>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Version</th><th className="p-3">Status</th><th className="p-3">Approval</th><th className="p-3">Reason / source</th><th className="p-3">Created</th></tr></thead><tbody className="divide-y divide-slate-100">{(snapshot?.history || []).map((entry) => <tr key={entry.id}><td className="p-3 font-semibold">v{entry.versionNumber}</td><td className="p-3">{entry.status}</td><td className="p-3">{entry.approvalMethod === "LEGACY_IMPORTED" ? "Legacy import" : "Member vote"}</td><td className="p-3 text-slate-600">{entry.proposalReason || "—"}</td><td className="p-3 text-slate-500">{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : "—"}</td></tr>)}</tbody></table></div>
        <button type="button" onClick={() => void fetchConstitution()} className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Refresh constitution</button>
      </section>
    </div>
  );
}
