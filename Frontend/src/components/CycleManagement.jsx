import { useCallback, useEffect, useMemo, useState } from "react";
import API from "../services/api";

const money = (value) => `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} RWF`;
function Message({ message }) {
  if (!message?.text) return null;
  const style = message.type === "success"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : message.type === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-rose-200 bg-rose-50 text-rose-800";
  const icon = message.type === "success" ? "✓" : message.type === "warning" ? "!" : "✕";
  return <div role="status" className={`rounded-xl border p-3 text-sm ${style}`}><span className="mr-2 font-black">{icon}</span>{message.text}</div>;
}

export default function CycleManagement({ user, activeCycle, onCycleChanged }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const cycleId = Number(activeCycle?.id);
  const [lifecycle, setLifecycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [witnessMemberId, setWitnessMemberId] = useState("");
  const [finalLoanCash, setFinalLoanCash] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const loadLifecycle = useCallback(async ({ quiet = false } = {}) => {
    if (!groupId || !cycleId) { setLifecycle(null); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      const response = await API.get(`/groups/${groupId}/cycles/${cycleId}/lifecycle`);
      const data = response.data.lifecycle;
      setLifecycle(data);
      if (!witnessMemberId && data?.witnesses?.length) setWitnessMemberId(String(data.witnesses[0].id));
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || "Could not load cycle closure status." });
    } finally {
      setLoading(false);
    }
  }, [groupId, cycleId, witnessMemberId]);

  useEffect(() => { void Promise.resolve().then(() => loadLifecycle()); }, [loadLifecycle]);

  const payoutCounts = useMemo(() => {
    const payouts = lifecycle?.closure?.payouts || [];
    return {
      total: payouts.length,
      paid: payouts.filter((payout) => payout.status === "PAID").length,
      completed: payouts.filter((payout) => payout.status === "PAID" || payout.status === "NOT_PAYABLE").length,
      pending: payouts.filter((payout) => payout.status === "PENDING").length,
      paidAmount: payouts.filter((payout) => payout.status === "PAID").reduce((sum, payout) => sum + Number(payout.payoutAmount || 0), 0),
    };
  }, [lifecycle]);

  const prepare = async () => {
    const reasons = lifecycle?.blockingReasons || [];
    if (!lifecycle?.readyToPrepare || reasons.length) {
      setMessage({ type: "error", text: "Resolve all cycle-closing blockers before preparing the share-out." });
      return;
    }
    const ok = window.confirm(`Prepare the final share-out for Cycle ${lifecycle.cycle.cycle_number}? This freezes financial entries for this cycle and snapshots each member's payout. Once prepared, all payouts and final witnessed cash counts must be completed before another cycle can start.`);
    if (!ok) return;
    setBusy(true); setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/cycles/${cycleId}/closure/prepare`, { confirm: true });
      setMessage({ type: "success", text: response.data.message });
      await loadLifecycle({ quiet: true });
    } catch (error) {
      const blockers = error.response?.data?.blockingReasons;
      setMessage({ type: "error", text: [error.response?.data?.message || "Could not prepare share-out.", ...(Array.isArray(blockers) ? blockers : [])].join(" ") });
      await loadLifecycle({ quiet: true });
    } finally { setBusy(false); }
  };

  const cancelPreparation = async () => {
    const reason = cancelReason.trim();
    if (reason.length < 5) { setMessage({ type: "error", text: "Explain why share-out preparation is being cancelled (at least 5 characters)." }); return; }
    if (!window.confirm("Cancel this share-out preparation? This is allowed only before any member has been paid. The cycle will unlock and can be prepared again.")) return;
    setBusy(true); setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/cycles/${cycleId}/closure/cancel`, { reason });
      setMessage({ type: "success", text: response.data.message });
      setCancelReason("");
      await loadLifecycle({ quiet: true });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || "Share-out preparation could not be cancelled." });
      await loadLifecycle({ quiet: true });
    } finally { setBusy(false); }
  };

  const recordPayout = async (payout) => {
    const ok = window.confirm(`Confirm that you have physically handed ${money(payout.payoutAmount)} in cash to ${payout.fullName}? Only confirm after the full amount has been handed over.`);
    if (!ok) return;
    setBusy(true); setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/cycles/${cycleId}/closure/payouts/${payout.id}/record`, { confirmCashHandedOver: true });
      setMessage({ type: "success", text: response.data.message });
      await loadLifecycle({ quiet: true });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || "The payout was not recorded." });
      await loadLifecycle({ quiet: true });
    } finally { setBusy(false); }
  };

  const completeCycle = async (event) => {
    event.preventDefault();
    if (!confirmation) { setMessage({ type: "error", text: "Confirm that all payouts and physical cash counts are complete." }); return; }
    setBusy(true); setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/cycles/${cycleId}/closure/complete`, {
        finalLoanFundCash: finalLoanCash,
        witnessMemberId: Number(witnessMemberId),
        confirmAllPayoutsAndCounts: true,
      });
      setMessage({ type: "success", text: response.data.message });
      setLifecycle(null);
      setWitnessMemberId(""); setFinalLoanCash(""); setConfirmation(false);
      await onCycleChanged?.(response.data.nextCycle);
    } catch (error) {
      try {
        const activeResponse = await API.get(`/groups/${groupId}/cycles/active`);
        const current = activeResponse.data?.cycle;
        if (current?.id && Number(current.id) !== cycleId && current.status === "ACTIVE") {
          setMessage({ type: "success", text: "The server has already completed the previous cycle and started the next one. The new active cycle has been loaded." });
          await onCycleChanged?.(current);
          return;
        }
      } catch {
        // The original error below remains the primary message when refresh is unavailable.
      }
      setMessage({ type: "error", text: error.response?.data?.message || "Cycle closure failed. No new cycle was started. If the connection was interrupted, refresh the cycle status before retrying." });
      await loadLifecycle({ quiet: true });
    } finally { setBusy(false); }
  };

  if (loading) return <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">Loading cycle closure status…</div>;
  if (!lifecycle) return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><Message message={message} /><p className="mt-2">Cycle status is unavailable. Confirm the cycle-lifecycle database migration has been applied, then refresh.</p><button type="button" onClick={() => loadLifecycle()} className="mt-3 rounded-lg border border-rose-300 bg-white px-3 py-2 font-semibold">Retry</button></div>;

  const cycle = lifecycle.cycle;
  const closure = lifecycle.closure;
  const isDistributing = cycle.status === "CLOSING" && closure?.status === "DISTRIBUTING";
  const isActive = cycle.status === "ACTIVE" && !closure;
  const isComplete = cycle.status === "COMPLETED" || closure?.status === "COMPLETED";

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Cycle {cycle.cycle_number}: Closing & New Cycle</h2>
            <p className="mt-1 text-sm text-slate-600">Cycle dates: {String(cycle.start_date).slice(0, 10)} – {cycle.end_date ? String(cycle.end_date).slice(0, 10) : "Not closed"}</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${cycle.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800" : cycle.status === "CLOSING" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}>{cycle.status}</span>
        </div>
        <Message message={message} />
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          <p className="font-semibold">Recommended end-of-cycle order</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Allow any open three-day virtual savings window to close, and resolve all outstanding loans and fines.</li>
            <li>Reconcile the single Loan Fund. The share-out report must say it is ready.</li>
            <li>Prepare the frozen payout list and record each member's full payout.</li>
            <li>Count the remaining Loan Fund cash and record an active member as witness.</li>
            <li>Complete the old cycle and create the next 12-month cycle using the reconciled Loan Fund balance.</li>
          </ol>
        </div>
      </section>

      {isActive && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <h3 className="text-lg font-bold text-slate-900">1. Readiness for final share-out</h3>
          {lifecycle.blockingReasons?.length ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-bold">Resolve these items first</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">{lifecycle.blockingReasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul>
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">The Loan Fund is reconciled, loans and fines are settled, and no virtual savings window remains open.</div>
          )}
          {lifecycle.report && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Shares recorded</p><p className="mt-1 text-lg font-bold">{Number(lifecycle.report.totalShares || 0).toLocaleString()}</p></div>
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Loan Fund available</p><p className="mt-1 text-lg font-bold">{money(lifecycle.report.distributableCash)}</p></div>
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Final share value</p><p className="mt-1 text-lg font-bold">{money(lifecycle.report.finalShareValue)}</p></div>
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Member payout rows</p><p className="mt-1 text-lg font-bold">{lifecycle.report.payouts?.length || 0}</p></div>
          </div>}
          <p className="text-sm text-slate-600">Preparing locks this cycle against additional financial entries, saves a payout snapshot, and begins the cash distribution phase. Do this only after the group has approved the share-out.</p>
          <button type="button" disabled={busy || !lifecycle.readyToPrepare} onClick={prepare} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Preparing…" : "Prepare final share-out"}</button>
        </section>
      )}

      {isDistributing && (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">2. Record actual member payouts</h3><p className="mt-1 text-sm text-slate-600">The payout amounts below are frozen from the verified share-out. Record a payout only after handing the full amount to that member.</p></div><span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">{payoutCounts.completed}/{payoutCounts.total} complete</span></div>
            <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Member</th><th className="px-3 py-2 text-right">Shares</th><th className="px-3 py-2 text-right">Savings</th><th className="px-3 py-2 text-right">Profit</th><th className="px-3 py-2 text-right">Payout</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{(closure.payouts || []).map((payout) => <tr key={payout.id}><td className="px-3 py-2 font-medium">{payout.fullName}</td><td className="px-3 py-2 text-right">{payout.sharesCount}</td><td className="px-3 py-2 text-right">{money(payout.savingsAmount)}</td><td className="px-3 py-2 text-right">{money(payout.profitAmount)}</td><td className="px-3 py-2 text-right font-bold">{money(payout.payoutAmount)}</td><td className="px-3 py-2"><span className={`rounded-full px-2 py-1 text-xs font-bold ${payout.status === "PAID" || payout.status === "NOT_PAYABLE" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{payout.status === "NOT_PAYABLE" ? "NO PAYOUT DUE" : payout.status}</span></td><td className="px-3 py-2">{payout.status === "PENDING" ? <button type="button" disabled={busy} onClick={() => recordPayout(payout)} className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">Record payout</button> : payout.receiptId ? <span className="text-xs text-slate-500">Receipt saved</span> : "—"}</td></tr>)}</tbody></table></div>
            <p className="text-sm text-slate-600">Recorded cash disbursements are written to the Loan Fund ledger and generate a member receipt. The cycle stays locked until all payouts and final cash counts are complete.</p>
            {payoutCounts.paid === 0 && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 space-y-3">
                <p className="text-sm font-semibold text-rose-900">Mistakenly started share-out?</p>
                <p className="text-xs text-rose-800">You may cancel only before any payout has been recorded. The reason is saved in the audit log.</p>
                <label className="block space-y-1 text-sm font-medium text-rose-900">Reason for cancellation<textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} rows={2} maxLength={1000} className="w-full rounded-lg border border-rose-300 bg-white px-3 py-2 text-slate-900" placeholder="Explain why the share-out needs to be prepared again…" /></label>
                <button type="button" disabled={busy || cancelReason.trim().length < 5} onClick={cancelPreparation} className="rounded-lg border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-800 disabled:opacity-50">Cancel share-out preparation</button>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
            <h3 className="text-lg font-bold text-slate-900">3. Final witnessed cash count and start next cycle</h3>
            {payoutCounts.pending > 0 ? <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Record all {payoutCounts.pending} remaining payout(s) before completing the cycle.</p> : <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">All member payouts are recorded. Count the actual cash now remaining in the Loan Fund.</p>}
            <form className="grid gap-4 md:grid-cols-2" onSubmit={completeCycle}>
              <label className="space-y-1 text-sm font-semibold text-slate-700">Actual remaining Loan Fund cash (RWF)<input required type="number" min="0" step="0.01" value={finalLoanCash} onChange={(event) => setFinalLoanCash(event.target.value)} placeholder={`Book balance: ${money(lifecycle.currentBookBalances?.loanFund)}`} className="w-full rounded-lg border border-slate-300 px-3 py-2"/><span className="block text-xs font-normal text-slate-500">Enter the physically counted cash after all share-out payouts; normally zero. Do not use the placeholder without counting.</span></label>
              <label className="space-y-1 text-sm font-semibold text-slate-700">Active member witnessing final count<select required value={witnessMemberId} onChange={(event) => setWitnessMemberId(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"><option value="">Choose an active member</option>{(lifecycle.witnesses || []).map((witness) => <option key={witness.id} value={String(witness.id)}>{witness.fullName}</option>)}</select></label>
              <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">The next cycle starts on the database date and uses the configured 12-month duration. The Loan Fund should be zero after all share-out payouts.</div>
              <label className="md:col-span-2 flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" checked={confirmation} onChange={(event) => setConfirmation(event.target.checked)} className="mt-1"/><span>I confirm all member payouts have been recorded, the final Loan Fund cash has been counted, and the selected active member is recorded as witness.</span></label>
              <div className="md:col-span-2"><button type="submit" disabled={busy || payoutCounts.pending > 0 || !witnessMemberId || !confirmation} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Saving cycle closure…" : `Close Cycle ${cycle.cycle_number} & Start Cycle ${Number(cycle.cycle_number) + 1}`}</button></div>
            </form>
          </section>
        </>
      )}

      {isComplete && <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6"><h3 className="text-lg font-bold text-emerald-900">Cycle completed</h3><p className="mt-2 text-sm text-emerald-800">This cycle is already completed. Select the currently active cycle to begin its operations.</p></section>}
    </div>
  );
}
