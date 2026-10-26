import { useCallback, useEffect, useState } from "react";
import API from "../services/api";

const MONEY = (value) => `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} RWF`;
const FUND_LABELS = { LOAN_FUND: "Loan Fund" };

export default function CashbookOperations({ user, activeCycleId }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const [report, setReport] = useState(null);
  const [openMeetings, setOpenMeetings] = useState([]);
  const [presentWitnessMembers, setPresentWitnessMembers] = useState([]);
  const [witnessListMessage, setWitnessListMessage] = useState("Loading active company members…");
  const [witnessRefreshToken, setWitnessRefreshToken] = useState(0);
  const [witnessMemberId, setWitnessMemberId] = useState("");
  const [meetingId, setMeetingId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState({ type: "", text: "" });

  const [openingFund, setOpeningFund] = useState("LOAN_FUND");
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingNotes, setOpeningNotes] = useState("");
  const [expenseFund, setExpenseFund] = useState("LOAN_FUND");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [adjustmentFund, setAdjustmentFund] = useState("LOAN_FUND");
  const [adjustmentDirection, setAdjustmentDirection] = useState("IN");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentDescription, setAdjustmentDescription] = useState("");
  const [adjustmentTreatment, setAdjustmentTreatment] = useState("BALANCE_CORRECTION");
  const [reconcileFund, setReconcileFund] = useState("LOAN_FUND");
  const [countedCash, setCountedCash] = useState("");
  const [reconcileNotes, setReconcileNotes] = useState("");
  const [reverseEntryId, setReverseEntryId] = useState("");
  const [reverseReason, setReverseReason] = useState("");

  const loadReport = useCallback(async () => {
    if (!groupId || !activeCycleId) return;
    setLoading(true);
    setError("");
    try {
      const response = await API.get(`/groups/${groupId}/cycles/${activeCycleId}/cashbook`);
      if (response.data.success) setReport(response.data.report);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load the cashbook. Apply the database migration and refresh.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [groupId, activeCycleId]);

  const loadMeetings = useCallback(async () => {
    if (!groupId || !activeCycleId) return;
    try {
      const response = await API.get(`/groups/${groupId}/meetings/open`, { params: { cycleId: activeCycleId } });
      const meetings = response.data.success ? response.data.meetings || [] : [];
      setOpenMeetings(meetings);
      setMeetingId((current) => meetings.some((meeting) => String(meeting.id) === String(current))
        ? String(current)
        : meetings.length ? String(meetings[0].id) : "");
    } catch {
      setOpenMeetings([]);
      setMeetingId("");
    }
  }, [groupId, activeCycleId]);

  useEffect(() => {
    void Promise.resolve().then(() => Promise.all([loadReport(), loadMeetings()]));
  }, [loadReport, loadMeetings]);

  // Virtual payment windows do not have physical attendance. An active company
  // member may witness a recorded cash count, whether or not a window is open.
  useEffect(() => {
    let isMounted = true;
    if (!groupId) return () => { isMounted = false; };
    API.get(`/groups/${groupId}/members`)
      .then((response) => {
        if (!isMounted) return;
        const active = (response.data?.members || []).filter((member) => member.is_active == null || Number(member.is_active) !== 0)
          .map((member) => ({ id: Number(member.id), memberId: Number(member.id), fullName: member.full_name || member.fullName, phoneNumber: member.phone_number || "" }));
        setPresentWitnessMembers(active);
        setWitnessMemberId((current) => active.some((member) => String(member.memberId) === String(current)) ? current : (active[0] ? String(active[0].memberId) : ""));
        setWitnessListMessage(active.length ? "Select an active member to witness the cash count." : "No active members are available to witness the count.");
      })
      .catch((err) => {
        if (!isMounted) return;
        setPresentWitnessMembers([]); setWitnessMemberId("");
        setWitnessListMessage(err.response?.data?.message || "Could not load active company members.");
      });
    return () => { isMounted = false; };
  }, [groupId, witnessRefreshToken]);

  const sendAction = async (path, body, successMessage, reset) => {
    setNotice({ type: "", text: "" });
    setError("");
    try {
      const response = await API.post(`/groups/${groupId}/cycles/${activeCycleId}/cashbook/${path}`, body);
      setNotice({ type: "success", text: `${response.data.message || successMessage}${response.data.receipt?.receiptNumber ? ` Receipt: ${response.data.receipt.receiptNumber}. Open Meeting Records & Receipts to print it.` : ""}` });
      if (reset) reset();
      await loadReport();
    } catch (err) {
      setNotice({ type: "error", text: err.response?.data?.message || `Failed to ${path.replaceAll("-", " ")}.` });
    }
  };

  const submitOpening = (event) => {
    event.preventDefault();
    void sendAction("opening-balance", {
      fundType: openingFund,
      amount: Number(openingAmount),
      notes: openingNotes,
    }, "Opening balance recorded.", () => { setOpeningAmount(""); setOpeningNotes(""); });
  };

  const submitExpense = (event) => {
    event.preventDefault();
    void sendAction("expenses", {
      fundType: expenseFund,
      amount: Number(expenseAmount),
      description: expenseDescription,
      meetingId: meetingId ? Number(meetingId) : undefined,
    }, "Expense recorded.", () => { setExpenseAmount(""); setExpenseDescription(""); });
  };

  const submitAdjustment = (event) => {
    event.preventDefault();
    void sendAction("adjustments", {
      fundType: adjustmentFund,
      direction: adjustmentDirection,
      amount: Number(adjustmentAmount),
      description: adjustmentDescription,
      accountingTreatment: adjustmentTreatment,
      meetingId: meetingId ? Number(meetingId) : undefined,
    }, "Adjustment recorded.", () => { setAdjustmentAmount(""); setAdjustmentDescription(""); });
  };

  const submitReconciliation = (event) => {
    event.preventDefault();
    if (!witnessMemberId || !presentWitnessMembers.some((member) => String(member.memberId) === String(witnessMemberId))) {
      setNotice({ type: "error", text: "Select an active company member to witness the cash count." });
      return;
    }
    void sendAction("reconcile", {
      fundType: reconcileFund,
      countedCash: Number(countedCash),
      notes: reconcileNotes,
      witnessMemberId: Number(witnessMemberId),
      meetingId: meetingId ? Number(meetingId) : undefined,
    }, "Cash count recorded.", () => { setCountedCash(""); setReconcileNotes(""); });
  };

  const submitReversal = (event) => {
    event.preventDefault();
    void sendAction("reversals", {
      meetingId: meetingId ? Number(meetingId) : undefined, ledgerEntryId: Number(reverseEntryId), reason: reverseReason,
    }, "Entry reversed. Record the correct replacement separately, then reconcile again.", () => {
      setReverseEntryId(""); setReverseReason("");
    });
  };

  const fundCard = (fundType) => {
    const fund = report?.funds?.[fundType];
    if (!fund) return null;
    const isLoan = fundType === "LOAN_FUND";
    const reconciliation = fund.latestReconciliation;
    return (
      <div key={fundType} className="rounded-xl border border-slate-200 p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-900">{FUND_LABELS[fundType]}</h3>
            <p className="text-xs text-slate-500">Independent cash balance</p>
          </div>
          <span className={`text-xs font-semibold rounded-full px-2 py-1 ${fund.reconciliationReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
            {fund.reconciliationReady ? "Reconciled" : "Needs reconciliation"}
          </span>
        </div>
        <p className={`text-2xl font-extrabold ${Number(fund.bookBalance) < 0 ? "text-red-700" : "text-slate-900"}`}>{MONEY(fund.bookBalance)}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <span className="text-slate-500">Opening balance</span><span className="text-right font-medium">{MONEY(fund.openingBalance)}</span>
          {isLoan ? <>
            <span className="text-slate-500">Share savings collected</span><span className="text-right font-medium">{MONEY(fund.sharesCollected)}</span>
            <span className="text-slate-500">Fines collected</span><span className="text-right font-medium">{MONEY(fund.finesCollected)}</span>
            <span className="text-slate-500">Principal repayments</span><span className="text-right font-medium">{MONEY(fund.principalRepaid)}</span>
            <span className="text-slate-500">Interest collected</span><span className="text-right font-medium">{MONEY(fund.interestCollected)}</span>
            <span className="text-slate-500">Loans disbursed</span><span className="text-right font-medium">−{MONEY(fund.loansDisbursed)}</span>
          </> : <>
            <span className="text-slate-500">Contributions</span><span className="text-right font-medium">{MONEY(fund.socialContributions)}</span>
          </>}
          <span className="text-slate-500">Expenses</span><span className="text-right font-medium">−{MONEY(fund.expenses)}</span>
        </div>
        {reconciliation ? (
          <div className="mt-3 pt-3 border-t text-sm space-y-1">
            <div className="flex justify-between gap-2"><span className="text-slate-500">Latest physical count</span><span className="font-semibold">{MONEY(reconciliation.countedCash)}</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-500">Variance at count</span><span className={`font-semibold ${Math.abs(reconciliation.variance) < 0.01 ? "text-emerald-700" : "text-red-700"}`}>{MONEY(reconciliation.variance)}</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-500">Witness</span><span className="text-right font-medium">{reconciliation.witnessMemberName || "Not recorded (historical count)"}</span></div>
            {!fund.reconciliationCurrent && <p className="text-xs text-amber-700">Ledger entries were added after this cash count. Reconcile again.</p>}
          </div>
        ) : <p className="text-xs text-amber-700">No physical cash count has been recorded yet.</p>}
      </div>
    );
  };

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-6">
      <div className="flex items-start justify-between gap-4 border-b pb-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Cashbook &amp; Cash Reconciliation</h2>
          <p className="text-sm text-slate-500 mt-1">Record and reconcile CORNESTONE's single Loan Fund. Entries can be recorded outside scheduled savings windows.</p>
        </div>
        <button type="button" onClick={() => { void loadReport(); void loadMeetings(); setWitnessRefreshToken((value) => value + 1); }} disabled={loading} className="px-3 py-2 rounded-lg text-sm font-semibold bg-slate-100 hover:bg-slate-200 disabled:opacity-50">
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {notice.text && <div className={`rounded-lg p-3 text-sm ${notice.type === "error" ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}`}>{notice.text}</div>}
      {error && <div className="rounded-lg p-3 text-sm bg-red-100 text-red-800">{error}</div>}
      {!error && report && report.funds.LOAN_FUND.legacyRepaymentCount > 0 && (
        <div className="rounded-lg p-3 text-sm border border-amber-200 bg-amber-50 text-amber-900">
          {report.funds.LOAN_FUND.legacyRepaymentCount} historic repayment transaction(s) were imported without a principal/interest split because the old records did not store that information. Their full amounts are included in cash, but not in recorded interest totals. Review the old receipt/loan records before final distribution.
        </div>
      )}

      {report && <div className="grid grid-cols-1 gap-4">{fundCard("LOAN_FUND")}</div>}
      {report && report.outstandingLoans.count > 0 && (
        <div className="rounded-lg p-3 text-sm border border-red-200 bg-red-50 text-red-800">
          There are {report.outstandingLoans.count} loan(s) with a balance of {MONEY(report.outstandingLoans.balance)}. Share-out must not be marked final while these balances remain unresolved.
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
        <label className="block text-sm font-medium text-slate-700">Optional virtual-window reference</label>
        <div className="flex gap-2">
          <select value={meetingId} onChange={(event) => setMeetingId(event.target.value)} className="flex-1 bg-white px-3 py-2 rounded-lg border border-slate-300">
            <option value="">No meeting selected</option>
            {openMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>Meeting #{meeting.meeting_number} (ID: {meeting.id})</option>)}
          </select>
          <button type="button" onClick={loadMeetings} className="px-3 py-2 rounded-lg border bg-white text-sm font-semibold">Refresh</button>
        </div>
        <p className="text-xs text-slate-600">Cashbook entries and counts do not require an open savings window. The selected reference is optional audit context only.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <form onSubmit={submitOpening} className="rounded-xl border p-4 space-y-3">
          <h3 className="font-bold text-slate-900">Record Opening Cash</h3>
          <p className="text-xs text-slate-500">Use once per fund, at the beginning of a cycle before any entries are recorded. Existing cycles with transactions cannot be given a second opening balance.</p>
          <select value={openingFund} onChange={(e) => setOpeningFund(e.target.value)} className="w-full rounded-lg border px-3 py-2"><option value="LOAN_FUND">Loan Fund</option></select>
          <input type="number" required min="0.01" step="0.01" value={openingAmount} onChange={(e) => setOpeningAmount(e.target.value)} placeholder="Opening cash amount (RWF)" className="w-full rounded-lg border px-3 py-2" />
          <input value={openingNotes} onChange={(e) => setOpeningNotes(e.target.value)} maxLength={500} placeholder="Source / handover note" className="w-full rounded-lg border px-3 py-2" />
          <button className="w-full rounded-lg py-2 font-semibold text-white bg-blue-600 hover:bg-blue-700">Save Opening Balance</button>
        </form>

        <form onSubmit={submitExpense} className="rounded-xl border p-4 space-y-3">
          <h3 className="font-bold text-slate-900">Record Loan Fund Expense</h3>
          <select value={expenseFund} onChange={(e) => setExpenseFund(e.target.value)} className="w-full rounded-lg border px-3 py-2"><option value="LOAN_FUND">Loan Fund Expense</option></select>
          <input type="number" required min="0.01" step="0.01" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="Amount (RWF)" className="w-full rounded-lg border px-3 py-2" />
          <input required minLength={3} maxLength={500} value={expenseDescription} onChange={(e) => setExpenseDescription(e.target.value)} placeholder="Reason / receipt reference" className="w-full rounded-lg border px-3 py-2" />
          <button className="w-full rounded-lg py-2 font-semibold text-white bg-emerald-600 hover:bg-emerald-700">Record Expense</button>
        </form>

        <form onSubmit={submitAdjustment} className="rounded-xl border p-4 space-y-3">
          <h3 className="font-bold text-slate-900">Document Cash Adjustment</h3>
          <p className="text-xs text-slate-600">Use this to record a newly discovered, authorized cash difference or opening/carried-forward cash after investigating it. It creates a new IN/OUT entry; it does not undo an existing transaction. Never use it just to hide a wrongly recorded entry.</p>
          <select value={adjustmentFund} onChange={(e) => setAdjustmentFund(e.target.value)} className="w-full rounded-lg border px-3 py-2"><option value="LOAN_FUND">Loan Fund</option></select>
          <div className="grid grid-cols-2 gap-2"><select value={adjustmentDirection} onChange={(e) => setAdjustmentDirection(e.target.value)} className="rounded-lg border px-3 py-2"><option value="IN">Cash increase</option><option value="OUT">Cash decrease</option></select><input type="number" required min="0.01" step="0.01" value={adjustmentAmount} onChange={(e) => setAdjustmentAmount(e.target.value)} placeholder="Amount (RWF)" className="rounded-lg border px-3 py-2" /></div>
          <select value={adjustmentTreatment} onChange={(e) => setAdjustmentTreatment(e.target.value)} className="w-full rounded-lg border px-3 py-2">
            <option value="BALANCE_CORRECTION">Correction / carried-forward cash (does not change profit)</option>
            <option value="OTHER_INCOME_OR_LOSS">Unexplained gain/loss (changes loan-fund result)</option>
          </select>
          <input required minLength={3} maxLength={500} value={adjustmentDescription} onChange={(e) => setAdjustmentDescription(e.target.value)} placeholder="Explain the correction / approval" className="w-full rounded-lg border px-3 py-2" />
          <button className="w-full rounded-lg py-2 font-semibold text-white bg-slate-700 hover:bg-slate-800">Save Adjustment</button>
        </form>

        <form onSubmit={submitReconciliation} className="rounded-xl border p-4 space-y-3">
          <h3 className="font-bold text-slate-900">Count and Reconcile Physical Cash</h3>
          <p className="text-xs text-slate-500">Count the actual Loan Fund cash. A witness is an active company member; no physical meeting or attendance register is required.</p>
          <select value={reconcileFund} onChange={(e) => setReconcileFund(e.target.value)} className="w-full rounded-lg border px-3 py-2"><option value="LOAN_FUND">Loan Fund</option></select>
          <input type="number" required min="0" step="0.01" value={countedCash} onChange={(e) => setCountedCash(e.target.value)} placeholder="Physical cash counted (RWF)" className="w-full rounded-lg border px-3 py-2" />
          <div><label className="block text-sm font-medium text-slate-700">Cash-count witness</label><select required value={witnessMemberId} onChange={(e) => setWitnessMemberId(e.target.value)} disabled={presentWitnessMembers.length === 0} className="w-full rounded-lg border bg-white px-3 py-2 disabled:bg-slate-100"><option value="">Select an active member to witness the cash count</option>{presentWitnessMembers.map((member) => <option key={member.memberId} value={member.memberId}>{member.fullName} ({member.phoneNumber})</option>)}</select><p className="mt-1 text-xs text-slate-600">{witnessListMessage}</p></div>
          <input maxLength={500} value={reconcileNotes} onChange={(e) => setReconcileNotes(e.target.value)} placeholder="Optional notes about the count" className="w-full rounded-lg border px-3 py-2" />
          <button disabled={!witnessMemberId || presentWitnessMembers.length === 0 || loading} className="w-full rounded-lg py-2 font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50">Save Cash Count</button>
        </form>
      </div>

      <form onSubmit={submitReversal} className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
        <div>
          <h3 className="font-bold text-amber-950">Correct a Financial Entry (Reversal)</h3>
          <p className="mt-1 text-xs text-amber-900">Use this when a specific posted entry is wrong. The system appends an equal-and-opposite reversal linked to that entry, preserving the audit trail; then record the correct replacement through the normal form and count the cash again. Unlike a cash adjustment, a reversal explicitly cancels the effect of an identifiable existing entry. Loan disbursements and loan repayments require a loan-specific review and are not reversed here.</p>
        </div>
        <select required value={reverseEntryId} onChange={(e) => setReverseEntryId(e.target.value)} disabled={!meetingId || !(report?.eligibleReversals || []).some((entry) => entry.correctionEligible)} className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2">
          <option value="">Choose entry to reverse</option>
          {(report?.eligibleReversals || []).filter((entry) => entry.correctionEligible).map((entry) => {
            const transactionType = String(entry.sourceTransactionType || "").toUpperCase();
            const activity = transactionType === "SHARE_PURCHASE"
              ? `Share purchase${entry.sourceTransactionSharesCount ? ` (${entry.sourceTransactionSharesCount} share(s))` : ""}`
              : transactionType === "SOCIAL_FUND" ? "Unsupported legacy transaction"
              : transactionType === "FINE_PAYMENT" ? `Fine payment${entry.sourceTransactionFineReason ? `: ${entry.sourceTransactionFineReason}` : ""}`
              : entry.entryType.replaceAll("_", " ");
            const person = entry.memberName ? `Member: ${entry.memberName}` : "Group cashbook entry";
            const note = entry.notes ? ` · ${entry.notes}` : "";
            return <option key={entry.id} value={entry.id}>#{entry.id} · {person} · {activity} · {entry.direction} {MONEY(entry.amount)} · {new Date(entry.createdAt).toLocaleDateString()}{note}</option>;
          })}
        </select>
        {reverseEntryId && (() => {
          const selected = (report?.eligibleReversals || []).find((entry) => String(entry.id) === String(reverseEntryId));
          if (!selected) return null;
          return <div className="rounded-lg border border-amber-200 bg-white p-3 text-sm space-y-1">
            <p className="font-bold text-amber-950">Selected entry details</p>
            <p><strong>Member:</strong> {selected.memberName || "Group-level cashbook entry"}</p>
            <p><strong>Activity:</strong> {selected.sourceTransactionType === "SHARE_PURCHASE" ? `Share purchase (${selected.sourceTransactionSharesCount || 0} share(s))` : selected.sourceTransactionType === "SOCIAL_FUND" ? "Unsupported legacy transaction" : selected.sourceTransactionType === "FINE_PAYMENT" ? `Fine payment${selected.sourceTransactionFineReason ? ` — ${selected.sourceTransactionFineReason}` : ""}` : selected.entryType.replaceAll("_", " ")}</p>
            <p><strong>Amount and direction:</strong> {selected.direction} {MONEY(selected.amount)}</p>
            <p><strong>Recorded:</strong> {new Date(selected.createdAt).toLocaleString()} by {selected.createdByName || "Unknown user"}</p>
            <p><strong>Original note:</strong> {selected.notes || "No note was stored."}</p>
          </div>;
        })()}
        <textarea required minLength={5} maxLength={1000} value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} placeholder="Why is this entry incorrect? Include the approved correction / meeting note." className="w-full min-h-20 rounded-lg border border-amber-300 bg-white px-3 py-2" />
        <button disabled={!meetingId || !reverseEntryId || reverseReason.trim().length < 5 || loading} className="rounded-lg px-4 py-2 font-semibold text-white bg-amber-700 hover:bg-amber-800 disabled:opacity-50">Reverse Selected Entry</button>
        {report && !(report.eligibleReversals || []).some((entry) => entry.correctionEligible) && <p className="text-xs text-amber-900">There are no unreversed eligible entries in this cycle. Entries linked to loan disbursements or repayments must be corrected through a loan-specific procedure.</p>}
      </form>

      {report && <div className="space-y-3">
        <h3 className="font-bold text-slate-900">Recent Cashbook Entries</h3>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-3">Date</th><th className="px-3 py-3">Fund / Entry</th><th className="px-3 py-3">In / Out</th><th className="px-3 py-3">Amount</th><th className="px-3 py-3">Member / Status</th><th className="px-3 py-3">Recorded by</th><th className="px-3 py-3">Note</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{report.recentEntries.map((entry) => <tr key={entry.id}><td className="px-3 py-3 whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</td><td className="px-3 py-3"><div className="font-semibold">{FUND_LABELS[entry.fundType]}</div><div className="text-xs text-slate-500">{entry.entryType.replaceAll("_", " ")}</div></td><td className={`px-3 py-3 font-semibold ${entry.direction === "IN" ? "text-emerald-700" : "text-rose-700"}`}>{entry.direction}</td><td className="px-3 py-3 whitespace-nowrap">{MONEY(entry.amount)}</td><td className="px-3 py-3">{entry.memberName || "—"}{entry.sourceTransactionStatus === "REVERSED" && <div className="text-xs text-rose-700 font-semibold">Transaction reversed</div>}{entry.reversalOfEntryId && <div className="text-xs text-amber-800">Reversal of #{entry.reversalOfEntryId}</div>}</td><td className="px-3 py-3">{entry.createdByName}</td><td className="px-3 py-3 min-w-48">{entry.notes || "—"}</td></tr>)}</tbody>
          </table>
          {report.recentEntries.length === 0 && <p className="p-4 text-sm text-slate-500">No cashbook entries yet.</p>}
        </div>
      </div>}
    </div>
  );
}
