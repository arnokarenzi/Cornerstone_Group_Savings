import { useCallback, useEffect, useMemo, useState } from "react";
import API from "../services/api";

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const money = (value) => `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} RWF`;
const dateTime = (value) => value ? new Date(value).toLocaleString() : "—";
const statusClass = (status) => {
  const key = String(status || "REQUESTED").toUpperCase();
  if (["APPROVED", "DISBURSED"].includes(key)) return "bg-emerald-50 text-emerald-700";
  if (["REJECTED", "CANCELLED"].includes(key)) return "bg-rose-50 text-rose-700";
  return "bg-amber-50 text-amber-800";
};

function Status({ value }) {
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(value)}`}>{String(value || "REQUESTED").toUpperCase()}</span>;
}

export default function MemberFinance({ user, activeCycleId, mode = "member", onFinancialChange }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const userId = Number(user?.id);
  const isLeadership = LEADERSHIP_ROLES.includes(String(user?.role || "").toUpperCase());
  const isReviewMode = mode === "leadership" && isLeadership;
  const [recipients, setRecipients] = useState([]);
  const [payments, setPayments] = useState([]);
  const [applications, setApplications] = useState([]);
  const [outstandingFines, setOutstandingFines] = useState([]);
  const [eligibility, setEligibility] = useState(null);
  const [virtualWindow, setVirtualWindow] = useState(null);
  const [purpose, setPurpose] = useState("SHARE_PURCHASE");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH_TO_COMMITTEE");
  const [transferReference, setTransferReference] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [repaymentLoanId, setRepaymentLoanId] = useState("");
  const [repaymentFineId, setRepaymentFineId] = useState("");
  const [loanAmount, setLoanAmount] = useState("");
  const [loanTermDays, setLoanTermDays] = useState("");
  const [loanReason, setLoanReason] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState({ type: "", text: "" });
  const eligibleLoans = useMemo(() => (eligibility?.outstandingLoans || []).filter((loan) => Number(loan.balanceRemaining) > 0.009), [eligibility]);
  const selectedRepaymentLoan = eligibleLoans.find((loan) => Number(loan.id ?? loan.loanId) === Number(repaymentLoanId));
  const selectedRepaymentFine = outstandingFines.find((fine) => Number(fine.fineId) === Number(repaymentFineId));
  const shareValue = Number(eligibility?.shareValue || 1000);
  const maxSharesPerWindow = Number(eligibility?.maxSharesPerWindow ?? 30);
  const maxLoanTermDays = Number(eligibility?.maxLoanTermDays || 0);
  const interestRate = Number(eligibility?.interestRate ?? eligibility?.settings?.interestRate ?? eligibility?.settings?.monthlyInterestRate ?? 0);
  const interestRatePercent = interestRate * 100;
  const interestPeriodDays = Number(eligibility?.interestPeriodDays ?? eligibility?.settings?.interestPeriodDays ?? 0);
  const loanTermChoices = useMemo(() => {
    if (!Number.isSafeInteger(maxLoanTermDays) || maxLoanTermDays <= 0) return [];
    const choices = [];
    for (let days = 30; days < maxLoanTermDays; days += 30) choices.push(days);
    choices.push(maxLoanTermDays);
    return [...new Set(choices)];
  }, [maxLoanTermDays]);
  const selectedLoanTermDays = Math.min(Number(loanTermDays || maxLoanTermDays), maxLoanTermDays);

  const loadData = useCallback(async () => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || !activeCycleId) return;
    setLoading(true);
    try {
      const requests = [
        API.get(`/groups/${groupId}/member-payments`, { params: { cycleId: activeCycleId } }),
        API.get(`/groups/${groupId}/loan-applications`, { params: { cycleId: activeCycleId } }),
      ];
      if (!isReviewMode) {
        requests.push(API.get(`/groups/${groupId}/payment-recipients`));
        requests.push(API.get(`/groups/${groupId}/loan-eligibility`, { params: { cycleId: activeCycleId } }));
        requests.push(API.get(`/groups/${groupId}/meetings/open`, { params: { cycleId: activeCycleId } }));
        requests.push(API.get(`/groups/${groupId}/member-fines`, { params: { cycleId: activeCycleId } }));
      }
      const results = await Promise.all(requests);
      setPayments(results[0].data?.requests || []);
      setApplications(results[1].data?.applications || []);
      if (!isReviewMode) {
        const recipientList = (results[2].data?.recipients || []).filter((item) => Number(item.id) !== userId);
        setRecipients(recipientList);
        setRecipientId((current) => recipientList.some((item) => String(item.id) === String(current)) ? current : (recipientList[0] ? String(recipientList[0].id) : ""));
        setEligibility(results[3].data?.eligibility || null);
        setVirtualWindow(results[4].data?.virtualWindow || null);
        const fines = results[5].data?.fines || [];
        setOutstandingFines(fines);
        setRepaymentFineId((current) => fines.some((fine) => String(fine.fineId) === String(current)) ? current : (fines[0] ? String(fines[0].fineId) : ""));
      }
    } catch (error) {
      setNotice({ type: "error", text: error.response?.data?.message || "Could not load the payment and loan application records." });
    } finally { setLoading(false); }
  }, [groupId, activeCycleId, isReviewMode, userId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadData(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  const submitPayment = async (event) => {
    event.preventDefault();
    if (!activeCycleId || !recipientId) return;
    if (purpose === "LOAN_REPAYMENT" && !repaymentLoanId) {
      setNotice({ type: "error", text: "Select the loan this payment is intended to repay." });
      return;
    }
    if (purpose === "FINE_PAYMENT" && !repaymentFineId) {
      setNotice({ type: "error", text: "Select the outstanding fine this payment is intended to settle." });
      return;
    }
    setBusyKey("payment-submit"); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/member-payments`, {
        cycleId: Number(activeCycleId), purpose, amount: Number(paymentAmount),
        loanId: purpose === "LOAN_REPAYMENT" ? Number(repaymentLoanId) : null,
        fineAssessmentId: purpose === "FINE_PAYMENT" ? Number(repaymentFineId) : null,
        paymentMethod, transferReference: transferReference.trim(), notes: paymentNotes.trim(),
        intendedRecipientUserId: Number(recipientId),
      });
      setNotice({ type: "success", text: response.data?.message || "Payment submitted for confirmation." });
      setPaymentAmount(""); setTransferReference(""); setPaymentNotes(""); setRepaymentLoanId(""); setRepaymentFineId("");
      await loadData();
      if (onFinancialChange) onFinancialChange();
    } catch (error) { setNotice({ type: "error", text: error.response?.data?.message || "Could not submit payment." }); }
    finally { setBusyKey(""); }
  };

  const submitLoanApplication = async (event) => {
    event.preventDefault();
    setBusyKey("loan-submit"); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/loan-applications`, {
        cycleId: Number(activeCycleId), requestedPrincipal: Number(loanAmount), requestedTermDays: selectedLoanTermDays, reason: loanReason.trim(),
      });
      setNotice({ type: "success", text: response.data?.message || "Loan application submitted." });
      setLoanAmount(""); setLoanReason(""); await loadData();
    } catch (error) { setNotice({ type: "error", text: error.response?.data?.message || "Could not submit loan application." }); }
    finally { setBusyKey(""); }
  };

  const decidePayment = async (request, decision) => {
    let notes = "";
    if (decision === "REJECT") {
      notes = window.prompt("Explain why this payment was not confirmed (at least five characters):", "") || "";
      if (notes.trim().length < 5) return;
    } else if (!window.confirm(`Confirm that you physically received ${money(request.amount)} from ${request.memberName}? This will post the financial transaction and issue a receipt.`)) return;
    setBusyKey(`payment-${request.id}`); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/member-payments/${request.id}/decision`, { decision, notes });
      setNotice({ type: "success", text: response.data?.message || `Payment ${decision.toLowerCase()}ed.` });
      await loadData(); if (onFinancialChange) onFinancialChange();
    } catch (error) { setNotice({ type: "error", text: error.response?.data?.message || "Could not review this payment." }); }
    finally { setBusyKey(""); }
  };

  const decideLoan = async (application, decision) => {
    let notes = "";
    if (decision === "REJECT") {
      notes = window.prompt("Explain why this loan application was rejected (at least five characters):", "") || "";
      if (notes.trim().length < 5) return;
    } else if (!window.confirm(`Approve ${application.memberName}'s request for ${money(application.requestedPrincipal)} over ${application.requestedTermDays} days? Approval does not transfer money.`)) return;
    setBusyKey(`loan-decision-${application.id}`); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/loan-applications/${application.id}/decision`, { decision, notes });
      setNotice({ type: "success", text: response.data?.message || `Loan application ${decision.toLowerCase()}d.` });
      await loadData();
    } catch (error) { setNotice({ type: "error", text: error.response?.data?.message || "Could not review this loan application." }); }
    finally { setBusyKey(""); }
  };

  const disburseLoan = async (application) => {
    if (!window.confirm(`Confirm that ${money(application.requestedPrincipal)} will now be handed to ${application.memberName}? The system will create the loan and receipt. Ensure the Loan Fund has a current balanced cash reconciliation.`)) return;
    setBusyKey(`loan-disburse-${application.id}`); setNotice({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/loan-applications/${application.id}/disburse`, {});
      const receipt = response.data?.loan?.receipt?.receiptNumber;
      setNotice({ type: "success", text: `${response.data?.message || "Loan disbursed."}${receipt ? ` Receipt ${receipt}.` : ""}` });
      await loadData(); if (onFinancialChange) onFinancialChange();
    } catch (error) { setNotice({ type: "error", text: error.response?.data?.message || "Could not disburse the approved loan." }); }
    finally { setBusyKey(""); }
  };

  if (!activeCycleId) return <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">No active savings cycle is available for member payments or loan applications.</div>;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">{isReviewMode ? "Payment & Loan Application Review" : "Payments & Loan Applications"}</h2>
            <p className="mt-1 text-sm text-slate-600">Manual payment recording only. The app does not integrate with Mobile Money or bank payment gateways.</p>
          </div>
          <button type="button" onClick={() => void loadData()} disabled={loading} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
        {notice.text && <div role="status" className={`rounded-xl p-3 text-sm ${notice.type === "error" ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-800"}`}>{notice.text}</div>}

        {!isReviewMode && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">Eligible savings</p><p className="mt-1 text-lg font-bold">{money(eligibility?.eligibleSavings)}</p></div>
              <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">Outstanding principal</p><p className="mt-1 text-lg font-bold">{money(eligibility?.outstandingPrincipal)}</p></div>
              <div className="rounded-xl bg-emerald-50 p-4"><p className="text-xs font-semibold text-emerald-700">Available borrowing</p><p className="mt-1 text-lg font-bold text-emerald-900">{money(eligibility?.availableBorrowing)}</p></div>
            </div>
            {eligibility?.defaultedLoan && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">New loan applications are blocked because loan #{eligibility.defaultedLoan.id} is in default. Default start: {eligibility.defaultedLoan.defaultStarts}.</p>}
            {Number(eligibility?.openWithdrawalRequests || 0) > 0 && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Loan applications are paused while you have a pending or approved withdrawal. Resolve that withdrawal first so your savings and borrowing limit cannot change during loan review.</p>}
            <div className="grid gap-5 xl:grid-cols-2">
              <form onSubmit={submitPayment} className="space-y-3 rounded-xl border border-slate-200 p-4">
                <h3 className="font-bold text-slate-900">Record a payment sent to committee</h3>
                <p className="text-xs leading-5 text-slate-500">Your submission is pending until the designated receiving committee member confirms actual receipt. It does not change your balance before confirmation.</p>
                <label className="block text-sm font-medium">Payment purpose<select value={purpose} onChange={(event) => { setPurpose(event.target.value); setPaymentAmount(""); setRepaymentLoanId(""); setRepaymentFineId(""); }} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"><option value="SHARE_PURCHASE">Savings / share contribution</option><option value="LOAN_REPAYMENT">Loan repayment</option><option value="FINE_PAYMENT">Fine payment</option></select></label>
                {purpose === "SHARE_PURCHASE" && <p className={`rounded-lg p-3 text-xs ${virtualWindow?.isOpen ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{virtualWindow?.isOpen ? `The savings window is open through ${virtualWindow.windowEndDate}. Shares cost ${money(shareValue)} each, up to ${maxSharesPerWindow} shares per window.` : `The savings window is closed. ${virtualWindow?.nextOpenDate ? `Next opening: ${virtualWindow.nextOpenDate}.` : "Refresh for the next window."} Loan repayments and fine payments remain available on any day.`}</p>}
                {purpose === "LOAN_REPAYMENT" && <label className="block text-sm font-medium">Loan to repay<select required value={repaymentLoanId} onChange={(event) => setRepaymentLoanId(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">Select an outstanding loan</option>{eligibleLoans.map((loan) => <option key={loan.id} value={loan.id}>Loan #{loan.id} · balance {money(loan.balanceRemaining)} · due {loan.dueDate}</option>)}</select></label>}
                {purpose === "FINE_PAYMENT" && <label className="block text-sm font-medium">Fine to pay<select required value={repaymentFineId} onChange={(event) => setRepaymentFineId(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">Select an outstanding fine</option>{outstandingFines.filter((fine) => Number(fine.availableForRequest) > 0.009).map((fine) => <option key={fine.fineId} value={fine.fineId}>Fine #{fine.fineId} · {fine.fineLabel} · available {money(fine.availableForRequest)}</option>)}</select>{selectedRepaymentFine?.reason && <span className="mt-1 block text-xs text-slate-500">{selectedRepaymentFine.reason}</span>}{!outstandingFines.some((fine) => Number(fine.availableForRequest) > 0.009) && <span className="mt-1 block text-xs text-amber-700">No outstanding fine balance is available to submit in this cycle.</span>}</label>}
                <label className="block text-sm font-medium">Amount (RWF)<input type="number" min={purpose === "SHARE_PURCHASE" ? shareValue : "0.01"} max={purpose === "SHARE_PURCHASE" ? maxSharesPerWindow * shareValue : purpose === "LOAN_REPAYMENT" ? selectedRepaymentLoan?.balanceRemaining : selectedRepaymentFine?.availableForRequest} step={purpose === "SHARE_PURCHASE" ? shareValue : "0.01"} required value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
                <label className="block text-sm font-medium">How did you pay?<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"><option value="CASH_TO_COMMITTEE">Cash handed to committee member</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER_MANUAL">Other manual payment</option></select></label>
                <label className="block text-sm font-medium">Transfer/reference number {paymentMethod === "BANK_TRANSFER" ? "(required)" : "(optional)"}<input required={paymentMethod === "BANK_TRANSFER"} maxLength={150} value={transferReference} onChange={(event) => setTransferReference(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
                <label className="block text-sm font-medium">Payment details<textarea required minLength={5} maxLength={1000} value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} rows={2} placeholder="Include any details the recipient can use to identify the payment." className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
                <label className="block text-sm font-medium">Committee member receiving the money<select required value={recipientId} onChange={(event) => setRecipientId(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">Select recipient</option>{recipients.map((recipient) => <option key={recipient.id} value={recipient.id}>{recipient.fullName} — {recipient.role}</option>)}</select></label>
                {recipients.length === 0 && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">No other eligible committee recipient is available. An administrator should appoint another active, approved, email-verified committee member. You cannot confirm your own payment.</p>}
                <button type="submit" disabled={busyKey !== "" || !recipientId || (purpose === "SHARE_PURCHASE" && !virtualWindow?.isOpen) || (purpose === "FINE_PAYMENT" && !selectedRepaymentFine)} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busyKey === "payment-submit" ? "Submitting…" : "Submit payment for confirmation"}</button>
              </form>

              <form onSubmit={submitLoanApplication} className="space-y-3 rounded-xl border border-slate-200 p-4">
                <h3 className="font-bold text-slate-900">Apply for a loan</h3>
                <p className="text-xs leading-5 text-slate-500">Available borrowing equals twice eligible net savings less outstanding principal and other pending applications. The committee rechecks the limit before approval and disbursement.</p>
                <label className="block text-sm font-medium">Requested amount (RWF)<input type="number" min="1" max={Number(eligibility?.availableBorrowing || 0)} step="0.01" required value={loanAmount} onChange={(event) => setLoanAmount(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
                <p className="text-xs text-slate-500">Maximum you can request now: {money(eligibility?.availableBorrowing)}.</p>
                <label className="block text-sm font-medium">Repayment term<select required value={String(selectedLoanTermDays || "")} onChange={(event) => setLoanTermDays(event.target.value)} disabled={!loanTermChoices.length} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"><option value="" disabled>Select a term</option>{loanTermChoices.map((days) => <option key={days} value={days}>{days} days{days === maxLoanTermDays ? " — constitutional maximum" : ""}</option>)}</select></label>
                <label className="block text-sm font-medium">Reason for borrowing<textarea required minLength={10} maxLength={1000} rows={3} value={loanReason} onChange={(event) => setLoanReason(event.target.value)} placeholder="Explain the purpose of this loan." className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
                <div className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">{eligibility ? `The current constitution charges ${interestRatePercent.toLocaleString()}% at disbursement, even if the loan is repaid early. Further ${interestRatePercent.toLocaleString()}% charges apply every ${interestPeriodDays} days on the principal remaining at each charge boundary. The maximum initial repayment term is ${maxLoanTermDays} days. An application is not a loan until approved and actually disbursed.` : "Loading the current constitutional service-charge rate, period, and maximum loan term…"}</div>
                <button type="submit" disabled={busyKey !== "" || !eligibility?.canApply || !selectedLoanTermDays || Number(loanAmount) <= 0 || Number(loanAmount) > Number(eligibility?.availableBorrowing || 0)} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busyKey === "loan-submit" ? "Submitting…" : "Submit loan application"}</button>
              </form>
            </div>
          </>
        )}
      </section>

      {isReviewMode ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <h3 className="text-lg font-bold">Payment confirmation queue</h3>
            {payments.filter((item) => item.status === "REQUESTED").length === 0 ? <p className="text-sm text-slate-500">No payment submissions are waiting for confirmation.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Member / date</th><th className="p-3">Purpose</th><th className="p-3">Amount</th><th className="p-3">Reference / details</th><th className="p-3">Assigned recipient</th><th className="p-3">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{payments.filter((item) => item.status === "REQUESTED").map((item) => <tr key={item.id}><td className="p-3">{item.memberName}<div className="text-xs text-slate-500">{dateTime(item.createdAt)}</div></td><td className="p-3">{item.purpose === "SHARE_PURCHASE" ? `${item.sharesCount} share(s)` : item.purpose === "LOAN_REPAYMENT" ? `Loan repayment #${item.loanId}` : `Fine payment #${item.fineAssessmentId}${item.fineLabel ? ` · ${item.fineLabel}` : ""}`}</td><td className="p-3 font-semibold">{money(item.amount)}</td><td className="p-3">{item.paymentMethod}{item.transferReference ? <div className="text-xs text-slate-500">Ref: {item.transferReference}</div> : null}<div className="max-w-64 whitespace-pre-wrap text-xs text-slate-500">{item.notes}</div></td><td className="p-3">{item.recipientName}</td><td className="p-3">{Number(item.intendedRecipientUserId) === userId && Number(item.memberId) !== userId ? <div className="flex flex-wrap gap-2"><button type="button" disabled={busyKey !== ""} onClick={() => void decidePayment(item, "APPROVE")} className="rounded bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Confirm receipt</button><button type="button" disabled={busyKey !== ""} onClick={() => void decidePayment(item, "REJECT")} className="rounded bg-rose-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Reject</button></div> : <span className="text-xs text-slate-500">Only the assigned recipient can confirm</span>}</td></tr>)}</tbody></table></div>}
          </section>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <h3 className="text-lg font-bold">Loan application queue</h3>
            <p className="text-xs text-slate-500">For separation of duties, the committee member who approves a loan cannot also confirm its handover/disbursement. A different authorized committee member must record the actual cash transfer.</p>
            {applications.filter((item) => ["REQUESTED", "APPROVED"].includes(item.status)).length === 0 ? <p className="text-sm text-slate-500">No loan applications need action.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Applicant</th><th className="p-3">Requested amount</th><th className="p-3">Term</th><th className="p-3">Reason / status</th><th className="p-3">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{applications.filter((item) => ["REQUESTED", "APPROVED"].includes(item.status)).map((item) => <tr key={item.id}><td className="p-3">{item.memberName}<div className="text-xs text-slate-500">Application #{item.id}</div></td><td className="p-3 font-semibold">{money(item.requestedPrincipal)}</td><td className="p-3">{item.requestedTermDays} days</td><td className="p-3"><div>{item.reason}</div><div className="mt-1"><Status value={item.status}/></div>{item.decisionNotes && <p className="mt-1 text-xs text-slate-500">{item.decisionNotes}</p>}</td><td className="p-3">{Number(item.memberId) === userId ? <span className="text-xs text-slate-500">Cannot decide your own application</span> : item.status === "REQUESTED" ? <div className="flex flex-wrap gap-2"><button type="button" disabled={busyKey !== ""} onClick={() => void decideLoan(item, "APPROVE")} className="rounded bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Approve</button><button type="button" disabled={busyKey !== ""} onClick={() => void decideLoan(item, "REJECT")} className="rounded bg-rose-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Reject</button></div> : Number(item.reviewedBy) === userId ? <span className="text-xs text-slate-500">A different committee member must confirm handover</span> : <button type="button" disabled={busyKey !== ""} onClick={() => void disburseLoan(item)} className="rounded bg-blue-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Confirm handover &amp; disburse</button>}</td></tr>)}</tbody></table></div>}
          </section>
        </>
      ) : (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
          <h3 className="text-lg font-bold">Your submitted payment and loan requests</h3>
          <div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Submitted</th><th className="p-3">Type</th><th className="p-3">Amount</th><th className="p-3">Assigned recipient</th><th className="p-3">Status / receipt</th></tr></thead><tbody className="divide-y divide-slate-100">{payments.map((item) => <tr key={`p-${item.id}`}><td className="p-3">{dateTime(item.createdAt)}</td><td className="p-3">{item.purpose === "SHARE_PURCHASE" ? `Share contribution (${item.sharesCount} shares)` : item.purpose === "LOAN_REPAYMENT" ? `Loan repayment #${item.loanId}` : `Fine payment #${item.fineAssessmentId}${item.fineLabel ? ` · ${item.fineLabel}` : ""}`}</td><td className="p-3 font-semibold">{money(item.amount)}</td><td className="p-3">{item.recipientName}</td><td className="p-3"><Status value={item.status}/>{item.receiptNumber && <div className="mt-1 text-xs text-emerald-700">Receipt {item.receiptNumber}</div>}{item.decisionNotes && <div className="mt-1 max-w-xs text-xs text-slate-500">{item.decisionNotes}</div>}</td></tr>)}{applications.map((item) => <tr key={`a-${item.id}`}><td className="p-3">{dateTime(item.createdAt)}</td><td className="p-3">Loan application #{item.id} · {item.requestedTermDays} days</td><td className="p-3 font-semibold">{money(item.requestedPrincipal)}</td><td className="p-3">Committee review</td><td className="p-3"><Status value={item.status}/>{item.loanId && <div className="mt-1 text-xs text-emerald-700">Loan #{item.loanId}</div>}{item.decisionNotes && <div className="mt-1 max-w-xs text-xs text-slate-500">{item.decisionNotes}</div>}</td></tr>)}</tbody></table>{payments.length === 0 && applications.length === 0 && <p className="p-5 text-center text-sm text-slate-500">You have not submitted a payment or loan application in this cycle.</p>}</div>
        </section>
      )}
    </div>
  );
}
