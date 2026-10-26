import { useCallback, useEffect, useMemo, useState } from "react";
import API from "../services/api";

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const money = (value) => `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} RWF`;
const dateOnly = (value) => value ? new Date(value).toLocaleDateString() : "—";

// Called from the date input's focus handler, not during render.
function localDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function Status({ value }) {
  const status = String(value || "REQUESTED").toUpperCase();
  const style = status === "PAID" || status === "APPROVED" ? "bg-emerald-50 text-emerald-700"
    : status === "REJECTED" || status === "CANCELLED" ? "bg-rose-50 text-rose-700"
      : "bg-amber-50 text-amber-800";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${style}`}>{status}</span>;
}

export default function FinancialRequests({ user, activeCycleId }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const memberId = Number(user?.id);
  const isLeader = LEADERSHIP_ROLES.includes(String(user?.role || "").toUpperCase());
  const [withdrawals, setWithdrawals] = useState([]);
  const [restructurings, setRestructurings] = useState([]);
  const [savings, setSavings] = useState(null);
  const [loans, setLoans] = useState([]);
  const [amount, setAmount] = useState("");
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [selectedLoanId, setSelectedLoanId] = useState("");
  const [requestedDueDate, setRequestedDueDate] = useState("");
  const [minimumDueDate, setMinimumDueDate] = useState("");
  const [restructuringReason, setRestructuringReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState({ type: "", text: "" });
  const [maxLoanTermDays, setMaxLoanTermDays] = useState(null);

  const loadData = useCallback(async () => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || !activeCycleId) {
      setWithdrawals([]); setRestructurings([]); setSavings(null); setLoans([]);
      return;
    }
    setLoading(true);
    try {
      const [withdrawalResponse, restructuringResponse, passbookResponse] = await Promise.all([
        API.get(`/groups/${groupId}/withdrawal-requests`, { params: { cycleId: activeCycleId } }),
        API.get(`/groups/${groupId}/loan-restructurings`, { params: { cycleId: activeCycleId } }),
        API.get(`/groups/${groupId}/members/${memberId}/passbook`, { params: { cycleId: activeCycleId } }),
      ]);
      setWithdrawals(withdrawalResponse.data?.requests || []);
      setSavings(withdrawalResponse.data?.savings || null);
      setRestructurings(restructuringResponse.data?.requests || []);
      setLoans((passbookResponse.data?.passbook?.loans || []).filter((loan) => Number(loan.cycleId) === Number(activeCycleId)
        && Number(loan.balanceRemaining) > 0.009 && !["REPAID", "CANCELLED"].includes(String(loan.status).toUpperCase())));
    } catch (error) {
      setNotice({ type: "error", text: error.response?.data?.message || "Could not load the withdrawal and restructuring requests." });
    } finally { setLoading(false); }
  }, [groupId, activeCycleId, memberId]);

  useEffect(() => { void Promise.resolve().then(() => loadData()); }, [loadData]);

  useEffect(() => {
    let active = true;
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return () => { active = false; };
    API.get(`/groups/${groupId}/constitution`)
      .then((response) => {
        if (!active) return;
        const terms = response.data?.constitution?.current?.terms;
        const configuredDays = Number(terms?.maxLoanTermDays ?? (Number(terms?.maxLoanDurationMonths) > 0 ? Number(terms.maxLoanDurationMonths) * 30 : NaN));
        if (Number.isSafeInteger(configuredDays) && configuredDays > 0) setMaxLoanTermDays(configuredDays);
      })
      .catch(() => { if (active) setMaxLoanTermDays(null); });
    return () => { active = false; };
  }, [groupId]);


  const availableAmount = Number(savings?.availableFaceValue || 0);
  const shareValue = Number(savings?.shareValue || 1000);
  const eligibleLoans = useMemo(() => loans.filter((loan) => Number(loan.balanceRemaining) > 0.009), [loans]);

  const submitWithdrawal = async (event) => {
    event.preventDefault();
    setBusyKey("withdrawal-create"); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/withdrawal-requests`, {
        cycleId: Number(activeCycleId), amount: Number(amount), reason: withdrawalReason.trim(),
      });
      setNotice({ type: "success", text: response.data?.message || "Withdrawal request submitted." });
      setAmount(""); setWithdrawalReason(""); await loadData();
    } catch (error) {
      setNotice({ type: "error", text: error.response?.data?.message || "Could not submit the withdrawal request." });
    } finally { setBusyKey(""); }
  };

  const submitRestructuring = async (event) => {
    event.preventDefault();
    if (!selectedLoanId) return;
    setBusyKey("restructure-create"); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/loans/${selectedLoanId}/restructurings`, {
        cycleId: Number(activeCycleId), requestedDueDate, reason: restructuringReason.trim(),
      });
      setNotice({ type: "success", text: response.data?.message || "Restructuring request submitted." });
      setSelectedLoanId(""); setRequestedDueDate(""); setRestructuringReason(""); await loadData();
    } catch (error) {
      setNotice({ type: "error", text: error.response?.data?.message || "Could not submit the restructuring request." });
    } finally { setBusyKey(""); }
  };

  const decideWithdrawal = async (request, decision) => {
    let notes = "";
    if (decision === "REJECT") {
      notes = window.prompt("Enter the reason for rejecting this withdrawal (at least 5 characters):", "") || "";
      if (notes.trim().length < 5) return;
    } else if (!window.confirm(`Approve the withdrawal request for ${money(request.requestedAmount)} from ${request.memberName || "this member"}?`)) return;
    setBusyKey(`withdrawal-${request.id}`); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/withdrawal-requests/${request.id}/decision`, { cycleId: Number(activeCycleId), decision, notes });
      setNotice({ type: "success", text: response.data?.message || `Withdrawal request ${decision.toLowerCase()}d.` }); await loadData();
    } catch (error) { setNotice({ type: "error", text: error.response?.data?.message || "Could not review the withdrawal request." }); }
    finally { setBusyKey(""); }
  };

  const payWithdrawal = async (request) => {
    if (!window.confirm(`Confirm that ${money(request.requestedAmount)} has physically been paid to ${request.memberName || "the member"}? A fresh balanced cash reconciliation is required.`)) return;
    setBusyKey(`withdrawal-pay-${request.id}`); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/withdrawal-requests/${request.id}/pay`, { cycleId: Number(activeCycleId), confirmCashHandedOver: true });
      const receiptNumber = response.data?.payout?.receipt?.receiptNumber;
      setNotice({ type: "success", text: `${response.data?.message || "Withdrawal paid."}${receiptNumber ? ` Receipt: ${receiptNumber}.` : ""} Reconcile the Loan Fund again before another cash-out.` }); await loadData();
    } catch (error) { setNotice({ type: "error", text: error.response?.data?.message || "Could not record the withdrawal payout." }); }
    finally { setBusyKey(""); }
  };

  const decideRestructuring = async (request, decision) => {
    let notes = "";
    if (decision === "REJECT") {
      notes = window.prompt("Enter the reason for rejecting this restructuring (at least 5 characters):", "") || "";
      if (notes.trim().length < 5) return;
    } else if (!window.confirm(`Approve extending loan #${request.loanId} due date to ${dateOnly(request.requestedDueDate)}? This does not forgive principal or service charges.`)) return;
    setBusyKey(`restructure-${request.id}`); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/loan-restructurings/${request.id}/decision`, { cycleId: Number(activeCycleId), decision, notes });
      setNotice({ type: "success", text: response.data?.message || `Restructuring request ${decision.toLowerCase()}d.` }); await loadData();
    } catch (error) { setNotice({ type: "error", text: error.response?.data?.message || "Could not review the restructuring request." }); }
    finally { setBusyKey(""); }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
          <div><h2 className="text-xl font-bold text-slate-900">Withdrawals &amp; Loan Restructuring</h2><p className="mt-1 text-sm text-slate-600">Every decision is recorded. The service never automatically takes savings to settle a loan.</p></div>
          <button type="button" onClick={() => void loadData()} disabled={loading} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
        {notice.text && <div role="status" className={`rounded-lg p-3 text-sm ${notice.type === "error" ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-800"}`}>{notice.text}</div>}
        {!activeCycleId && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">No active cycle is selected.</p>}
        {savings && <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700"><strong>Your available unredeemed savings:</strong> {money(availableAmount)} ({Number(savings.availableShares || 0)} whole share(s), at {money(shareValue)} each). Requests and approved but unpaid redemptions reserve shares so they cannot be requested twice.</div>}
        <div className="grid gap-5 xl:grid-cols-2">
          <form onSubmit={submitWithdrawal} className="rounded-xl border border-slate-200 p-4 space-y-3">
            <h3 className="font-bold text-slate-900">Request a savings withdrawal</h3>
            <p className="text-xs leading-5 text-slate-500">Withdrawals redeem whole shares at the share price on the request date. A member with an outstanding loan cannot receive a withdrawal. Payment is subject to committee approval, available reconciled cash and a receipt.</p>
            <label className="block text-sm font-medium text-slate-700">Amount (RWF)<input type="number" min={shareValue} max={availableAmount} step={shareValue} value={amount} required disabled={!activeCycleId || busyKey !== ""} onChange={(event) => setAmount(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label className="block text-sm font-medium text-slate-700">Reason<textarea minLength={10} maxLength={1000} required value={withdrawalReason} onChange={(event) => setWithdrawalReason(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" rows={3} placeholder="Explain why you are requesting the withdrawal." /></label>
            <button disabled={!activeCycleId || busyKey !== "" || (availableAmount <= 0)} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busyKey === "withdrawal-create" ? "Submitting…" : "Submit withdrawal request"}</button>
          </form>
          <form onSubmit={submitRestructuring} className="rounded-xl border border-slate-200 p-4 space-y-3">
            <h3 className="font-bold text-slate-900">Request a loan restructuring</h3>
            <p className="text-xs leading-5 text-slate-500">A committee-approved request changes the due date only. It cannot forgive principal or service charges. The maximum permitted extension is {maxLoanTermDays == null ? "the configured maximum loan term" : `${maxLoanTermDays} days`}, as set in Constitution & Rules.</p>
            <label className="block text-sm font-medium text-slate-700">Unpaid loan<select required value={selectedLoanId} onChange={(event) => setSelectedLoanId(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">Select a loan</option>{eligibleLoans.map((loan) => <option key={loan.id} value={loan.id}>Loan #{loan.id} · balance {money(loan.balanceRemaining)} · due {dateOnly(loan.dueDate)}</option>)}</select></label>
            <label className="block text-sm font-medium text-slate-700">Requested new due date<input type="date" required value={requestedDueDate} onChange={(event) => setRequestedDueDate(event.target.value)} min={minimumDueDate || undefined} onFocus={() => setMinimumDueDate(localDateInputValue())} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label className="block text-sm font-medium text-slate-700">Reason<textarea minLength={10} maxLength={1000} required value={restructuringReason} onChange={(event) => setRestructuringReason(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" rows={3} placeholder="Explain the reason for requesting an extension." /></label>
            <button disabled={!activeCycleId || !selectedLoanId || busyKey !== ""} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busyKey === "restructure-create" ? "Submitting…" : "Submit restructuring request"}</button>
            {!eligibleLoans.length && <p className="text-xs text-slate-500">No unpaid loans are available in this cycle.</p>}
          </form>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-4">
        <h3 className="text-lg font-bold text-slate-900">Withdrawal requests</h3>
        {withdrawals.length === 0 ? <p className="text-sm text-slate-500">No withdrawal requests in this cycle.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Member</th><th className="p-3">Amount</th><th className="p-3">Shares</th><th className="p-3">Reason</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">{withdrawals.map((request) => <tr key={request.id} className="align-top"><td className="p-3 font-medium">{request.memberName || `Member #${request.memberId}`}<div className="text-xs text-slate-500">Requested {dateOnly(request.createdAt)}</div></td><td className="p-3 whitespace-nowrap">{money(request.requestedAmount)}</td><td className="p-3">{request.sharesToRedeem}</td><td className="p-3 max-w-xs whitespace-pre-wrap">{request.reason}</td><td className="p-3"><Status value={request.status}/>{request.decisionNotes && <p className="mt-1 max-w-xs text-xs text-slate-500">{request.decisionNotes}</p>}{request.receiptId && <p className="mt-1 text-xs text-slate-500">Receipt #{request.receiptId}</p>}</td><td className="p-3"><div className="flex flex-wrap gap-2">{isLeader && request.status === "REQUESTED" && Number(request.memberId) !== Number(user?.id) && Number(request.requestedBy) !== Number(user?.id) && <><button type="button" disabled={busyKey !== ""} onClick={() => void decideWithdrawal(request, "APPROVE")} className="rounded bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Approve</button><button type="button" disabled={busyKey !== ""} onClick={() => void decideWithdrawal(request, "REJECT")} className="rounded bg-rose-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Reject</button></>}{isLeader && request.status === "APPROVED" && Number(request.memberId) !== Number(user?.id) && Number(request.reviewedBy) !== Number(user?.id) && <button type="button" disabled={busyKey !== ""} onClick={() => void payWithdrawal(request)} className="rounded bg-blue-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Record payout &amp; receipt</button>}</div></td></tr>)}</tbody></table></div>}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-4">
        <h3 className="text-lg font-bold text-slate-900">Loan restructuring requests</h3>
        {restructurings.length === 0 ? <p className="text-sm text-slate-500">No restructuring requests in this cycle.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Member / Loan</th><th className="p-3">Due date</th><th className="p-3">Requested due date</th><th className="p-3">Reason</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">{restructurings.map((request) => <tr key={request.id} className="align-top"><td className="p-3 font-medium">{request.memberName || `Member #${request.memberId}`}<div className="text-xs text-slate-500">Loan #{request.loanId} · balance {money(request.balanceRemaining)}</div></td><td className="p-3">{dateOnly(request.originalDueDate)}</td><td className="p-3">{dateOnly(request.requestedDueDate)}</td><td className="p-3 max-w-xs whitespace-pre-wrap">{request.reason}</td><td className="p-3"><Status value={request.status}/>{request.decisionNotes && <p className="mt-1 text-xs text-slate-500">{request.decisionNotes}</p>}</td><td className="p-3">{isLeader && request.status === "REQUESTED" && Number(request.memberId) !== Number(user?.id) && Number(request.requestedBy) !== Number(user?.id) && <div className="flex flex-wrap gap-2"><button type="button" disabled={busyKey !== ""} onClick={() => void decideRestructuring(request, "APPROVE")} className="rounded bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Approve</button><button type="button" disabled={busyKey !== ""} onClick={() => void decideRestructuring(request, "REJECT")} className="rounded bg-rose-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Reject</button></div>}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}
