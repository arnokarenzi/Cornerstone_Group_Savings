import { useCallback, useEffect, useState } from "react";
import API from "../services/api";

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const money = (value) => `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} RWF`;
const label = (value) => String(value || "").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function printReceipt(receipt) {
  const popup = window.open("", "_blank", "width=720,height=760");
  if (!popup) {
    window.alert("Your browser blocked the receipt window. Allow pop-ups for this site and try again.");
    return;
  }
  const details = Object.entries(receipt.details || {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  const detailRows = details.map(([key, value]) => `<tr><td>${escapeHtml(label(key))}</td><td>${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</td></tr>`).join("");
  popup.document.open();
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(receipt.receiptNumber)}</title><style>
    body{font-family:Arial,sans-serif;color:#172033;margin:32px}header{border-bottom:2px solid #059669;padding-bottom:14px;margin-bottom:18px}h1{font-size:25px;margin:0 0 5px}p{margin:5px 0;color:#475569}.receipt-no{font-weight:bold;font-size:18px;color:#047857}.amount{font-size:28px;font-weight:bold;margin:22px 0}.meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;background:#f8fafc;padding:12px;border-radius:8px}table{width:100%;border-collapse:collapse;margin-top:18px}td{padding:9px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}td:first-child{color:#64748b;width:38%}.foot{font-size:11px;color:#64748b;margin-top:28px;border-top:1px solid #e2e8f0;padding-top:12px}@media print{button{display:none}body{margin:12mm}}</style></head><body>
    <header><h1>${escapeHtml(receipt.groupName || "CORNESTONE Co.LTD.")}</h1><p>Financial transaction receipt</p><div class="receipt-no">${escapeHtml(receipt.receiptNumber)}</div></header>
    <div class="meta"><div><b>Member</b><br>${escapeHtml(receipt.memberName || "Group / fund transaction")}</div><div><b>Date issued</b><br>${escapeHtml(new Date(receipt.issuedAt).toLocaleString())}</div><div><b>Meeting</b><br>${receipt.meetingNumber ? `Meeting #${escapeHtml(receipt.meetingNumber)}` : "Not linked"}</div><div><b>Recorded by</b><br>${escapeHtml(receipt.issuedByName || "System")}</div></div>
    <div class="amount">${escapeHtml(money(receipt.amount))}</div><p><b>${escapeHtml(label(receipt.activityType))}</b> — ${escapeHtml(receipt.summary || "")}</p>
    <table>${detailRows}</table><div class="foot">Keep this receipt for your records. This is a system-generated receipt; compare it with the group cashbook and your member passbook. Currency: ${escapeHtml(receipt.currency || "RWF")}.</div><button onclick="window.print()">Print receipt</button><script>window.onload=()=>setTimeout(()=>window.print(),250);</script></body></html>`);
  popup.document.close();
}

export default function ReceiptsAndAudit({ user, activeCycleId }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const isLeader = LEADERSHIP_ROLES.includes(user?.role);
  const [receipts, setReceipts] = useState([]);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!groupId) return;
    setLoading(true); setError("");
    try {
      const requests = [API.get(`/groups/${groupId}/receipts`, { params: { ...(activeCycleId ? { cycleId: activeCycleId } : {}), limit: 100 } })];
      if (isLeader) requests.push(API.get(`/groups/${groupId}/audit-log`, { params: { ...(activeCycleId ? { cycleId: activeCycleId } : {}), limit: 100 } }));
      const responses = await Promise.all(requests);
      const nextReceipts = responses[0].data.success ? responses[0].data.receipts || [] : [];
      setReceipts(nextReceipts);
      setSelectedReceipt((current) => current && nextReceipts.some((item) => item.id === current.id)
        ? nextReceipts.find((item) => item.id === current.id) : nextReceipts[0] || null);
      setEvents(isLeader && responses[1]?.data.success ? responses[1].data.events || [] : []);
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Could not load receipts and audit history. Apply the Priority 2 database migration, then refresh.");
    } finally { setLoading(false); }
  }, [groupId, activeCycleId, isLeader]);

  useEffect(() => { void Promise.resolve().then(() => refresh()); }, [refresh]);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap justify-between items-start gap-3 border-b pb-4">
          <div><h2 className="text-xl font-bold text-slate-900">Financial Receipts</h2><p className="mt-1 text-sm text-slate-500">Receipts are generated in the same database transaction as the financial entry, so a saved movement and its receipt stay together.</p></div>
          <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
        {error && <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
        {!error && receipts.length === 0 ? <p className="text-sm text-slate-500">No new-system receipts exist for this cycle yet. Historical receipts are not reconstructed automatically; old transactions remain in the database.</p> : (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4">
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <div className="max-h-[430px] overflow-auto divide-y divide-slate-100">
                {receipts.map((receipt) => <button type="button" key={receipt.id} onClick={() => setSelectedReceipt(receipt)} className={`w-full p-3 text-left hover:bg-slate-50 ${selectedReceipt?.id === receipt.id ? "bg-emerald-50" : "bg-white"}`}>
                  <div className="flex justify-between gap-2"><span className="text-sm font-bold text-slate-900">{receipt.receiptNumber}</span><span className="text-sm font-bold whitespace-nowrap">{money(receipt.amount)}</span></div>
                  <div className="mt-1 text-xs text-slate-600">{label(receipt.activityType)}{receipt.memberName ? ` · ${receipt.memberName}` : ""}</div>
                  <div className="mt-1 text-xs text-slate-400">{new Date(receipt.issuedAt).toLocaleString()}</div>
                </button>)}
              </div>
            </div>
            {selectedReceipt && <div className="rounded-xl border border-slate-200 p-4 space-y-3 self-start">
              <div className="flex items-start justify-between gap-2"><div><p className="text-xs uppercase text-slate-500">Receipt number</p><h3 className="break-all font-extrabold text-emerald-800">{selectedReceipt.receiptNumber}</h3></div><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold">RWF</span></div>
              <p className="text-2xl font-extrabold text-slate-900">{money(selectedReceipt.amount)}</p>
              <p className="text-sm font-semibold">{selectedReceipt.summary}</p>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"><span className="text-slate-500">Member</span><span>{selectedReceipt.memberName || "Group / fund transaction"}</span><span className="text-slate-500">Phone</span><span>{selectedReceipt.memberPhone || "—"}</span><span className="text-slate-500">Meeting</span><span>{selectedReceipt.meetingNumber ? `#${selectedReceipt.meetingNumber}` : "Not linked"}</span><span className="text-slate-500">Issued by</span><span>{selectedReceipt.issuedByName}</span><span className="text-slate-500">Date</span><span>{new Date(selectedReceipt.issuedAt).toLocaleString()}</span></div>
              {Object.keys(selectedReceipt.details || {}).length > 0 && <details className="text-sm"><summary className="cursor-pointer font-semibold text-slate-700">Transaction details</summary><dl className="mt-2 space-y-2">{Object.entries(selectedReceipt.details).map(([key, value]) => <div key={key} className="grid grid-cols-[1fr_1.5fr] gap-2"><dt className="text-slate-500">{label(key)}</dt><dd className="break-words font-medium">{value == null || value === "" ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></details>}
              <button type="button" onClick={() => printReceipt(selectedReceipt)} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">Print / Save as PDF</button>
            </div>}
          </div>
        )}
        {!isLeader && <p className="text-xs text-slate-500">For privacy, member accounts can only view their own receipts. Leadership can review group receipts.</p>}
      </section>

      {isLeader && <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-4">
        <div className="border-b pb-4"><h2 className="text-xl font-bold text-slate-900">Immutable Audit Trail</h2><p className="mt-1 text-sm text-slate-500">Shows who performed important actions, what changed, and when. Financial entries are corrected by reversal and replacement rather than deletion.</p></div>
        {events.length === 0 ? <p className="text-sm text-slate-500">No audit events found for this cycle yet. New changes are recorded from this version onward.</p> : <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[800px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-3">Date</th><th className="px-3 py-3">Actor</th><th className="px-3 py-3">Action</th><th className="px-3 py-3">Record</th><th className="px-3 py-3">Reason / Details</th></tr></thead><tbody className="divide-y divide-slate-100">{events.map((event) => <tr key={event.id}><td className="px-3 py-3 whitespace-nowrap">{new Date(event.createdAt).toLocaleString()}</td><td className="px-3 py-3">{event.actorName}</td><td className="px-3 py-3 font-semibold">{label(event.action)}</td><td className="px-3 py-3">{label(event.entityType)}{event.entityId ? ` #${event.entityId}` : ""}</td><td className="px-3 py-3 min-w-64"><div>{event.reason || "—"}</div><details className="mt-1"><summary className="cursor-pointer text-xs text-blue-700">View changes</summary><pre className="mt-2 max-w-md overflow-auto rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap">{JSON.stringify({ before: event.beforeData, after: event.afterData }, null, 2)}</pre></details></td></tr>)}</tbody></table></div>}
      </section>}
    </div>
  );
}
