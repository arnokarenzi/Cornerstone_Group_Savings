import { useCallback, useEffect, useState } from "react";
import API from "../services/api";

export default function MeetingOperations({ user, activeCycleId = null, onOpenPaymentReview }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const [windowStatus, setWindowStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || !activeCycleId) {
      setWindowStatus(null);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const response = await API.get(`/groups/${groupId}/meetings/open`, { params: { cycleId: activeCycleId } });
      setWindowStatus(response.data?.virtualWindow || null);
      if (!quiet) setMessage({ type: "", text: "" });
    } catch (error) {
      if (!quiet) setMessage({ type: "error", text: error.response?.data?.message || "Could not load the virtual savings window." });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [groupId, activeCycleId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => { void refresh({ quiet: true }); }, 60000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Virtual Savings Window</h2>
            <p className="mt-1 text-sm text-slate-600">Share contributions are submitted by members and posted only after the designated receiving committee member confirms actual receipt.</p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh window"}</button>
        </div>
        {message.text && <div role="status" className={`rounded-lg border p-3 text-sm ${message.type === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{message.text}</div>}
        {!windowStatus ? <p className="text-sm text-slate-500">Window schedule is not available. Confirm that an active savings cycle is selected.</p> : (
          <div className={`rounded-xl border p-4 ${windowStatus.isOpen ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
            <p className={`font-bold ${windowStatus.isOpen ? "text-emerald-900" : "text-amber-900"}`}>{windowStatus.isOpen ? `Savings window #${windowStatus.windowNumber} is OPEN` : "Savings window is CLOSED"}</p>
            <p className="mt-1 text-sm">{windowStatus.isOpen ? `Open from ${windowStatus.windowStartDate} through ${windowStatus.windowEndDate}.` : `The next window opens on ${windowStatus.nextOpenDate}.`}</p>
            <p className="mt-1 text-xs text-slate-600">Today in Rwanda: {windowStatus.today}. Schedule: {windowStatus.windowDays} days open in every {windowStatus.intervalDays}-day period.</p>
          </div>
        )}
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 space-y-2 text-sm text-blue-950">
          <h3 className="font-semibold">Payment receipt workflow</h3>
          <p>Do not enter member share contributions directly from this screen. A member should submit the payment under <strong>My Digital Passbook</strong>, choose the committee person who received the money, and wait for that recipient to confirm it. This avoids double-posting and preserves the verification trail.</p>
          <p>After confirmation, the backend posts the share transaction, Loan Fund ledger entry, receipt and audit event together. Loan repayments can be submitted on any day; they do not depend on this savings window.</p>
          {onOpenPaymentReview && <button type="button" onClick={onOpenPaymentReview} className="rounded-lg bg-blue-800 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-900">Open Payments &amp; Loan Applications</button>}
        </div>
      </section>
    </div>
  );
}
