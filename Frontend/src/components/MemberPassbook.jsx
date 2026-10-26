import { useCallback, useEffect, useMemo, useState } from "react";
import API from "../services/api";

const money = (value) => Number(value || 0).toLocaleString(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const dateTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

const dateOnly = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
};

function escapeCsv(value) {
  let text = value == null ? "" : String(value);
  if (/^(?:[=+@]|[\t\r]|-(?!\d+(?:\.\d+)?$))/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function memberFacingAmount(event) {
  const reducesMemberBalance = ["SAVINGS", "FINE"].includes(event.category);
  const sign = reducesMemberBalance && event.direction === "OUT" ? -1 : 1;
  return sign * Number(event.amount || 0);
}

export default function MemberPassbook({ user }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const memberId = Number(user?.id);
  const [cycleFilter, setCycleFilter] = useState("ALL");
  const [passbook, setPassbook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadPassbook = useCallback(async () => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || !Number.isSafeInteger(memberId) || memberId <= 0) {
      setError("Your login is missing a valid group or member ID. Please sign out and sign back in.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const cycleQuery = cycleFilter === "ALL" ? "" : `?cycleId=${encodeURIComponent(cycleFilter)}`;
      const response = await API.get(`/groups/${groupId}/members/${memberId}/passbook${cycleQuery}`);
      if (!response.data?.success || !response.data?.passbook) throw new Error("The passbook service returned an unexpected response.");
      setPassbook(response.data.passbook);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Could not load your digital passbook.");
      setPassbook(null);
    } finally {
      setLoading(false);
    }
  }, [groupId, memberId, cycleFilter]);

  useEffect(() => { void Promise.resolve().then(() => loadPassbook()); }, [loadPassbook]);

  const events = useMemo(() => passbook?.events || [], [passbook]);
  const exportCsv = () => {
    const headings = [
      "Date", "Cycle", "Meeting", "Activity", "Reference", "Shares", "Amount (RWF)",
      "Principal Repaid (RWF)", "Interest/Service Charge Paid (RWF)", "Fine Reason", "Status",
      "Running Savings (RWF)", "Running Fines Paid (RWF)",
      "Running Loan Balance (RWF)", "Notes",
    ];
    const rows = events.map((event) => [
      dateTime(event.occurredAt), `Cycle ${event.cycleNumber}`, event.meetingNumber == null ? "" : `Meeting ${event.meetingNumber}`,
      event.activity, event.transactionId ?? event.loanId ?? event.id, event.sharesCount || "",
      memberFacingAmount(event).toFixed(2), event.principalAmount == null ? "" : Number(event.principalAmount).toFixed(2),
      event.interestAmount == null ? "" : Number(event.interestAmount).toFixed(2), event.fineReason || "", event.status,
      Number(event.runningSavingsBalance || 0).toFixed(2), Number(event.runningFinesPaid || 0).toFixed(2), Number(event.runningLoanBalance || 0).toFixed(2),
      event.historicalSplitUnavailable ? "Historical principal/interest split unavailable" : (event.notes || ""),
    ]);
    const csv = [headings, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const memberSlug = String(passbook?.member?.fullName || "member").trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "member";
    anchor.href = url;
    anchor.download = `cornestone-passbook-${memberSlug}-${cycleFilter === "ALL" ? "all-cycles" : `cycle-${cycleFilter}`}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (loading && !passbook) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">Loading your digital passbook…</div>;
  }

  return (
    <div className="space-y-6">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #cornestone-passbook-print, #cornestone-passbook-print * { visibility: visible !important; }
          #cornestone-passbook-print { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; padding: 0 !important; margin: 0 !important; }
          .passbook-no-print { display: none !important; }
          .passbook-card { box-shadow: none !important; break-inside: avoid; }
          .passbook-table { font-size: 9px !important; }
          .passbook-table th, .passbook-table td { padding: 4px !important; }
          body { background: white !important; }
        }
      `}</style>

      <div className="passbook-no-print flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">My Digital Passbook</h2>
          <p className="mt-1 text-sm text-slate-500">Your meeting-by-meeting savings, contributions, fines and loan activity.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-semibold text-slate-600">
            Statement period
            <select value={cycleFilter} onChange={(event) => setCycleFilter(event.target.value)} className="mt-1 block min-w-40 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800">
              <option value="ALL">All cycles</option>
              {(passbook?.cycles || []).map((cycle) => (
                <option key={cycle.id} value={String(cycle.id)}>Cycle {cycle.cycleNumber}{cycle.status === "ACTIVE" ? " (Active)" : ""}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void loadPassbook()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Refresh</button>
          <button type="button" onClick={exportCsv} disabled={!passbook || !events.length} className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">Download CSV</button>
          <button type="button" onClick={() => window.print()} disabled={!passbook} className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50">Print / Save PDF</button>
        </div>
      </div>

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}
      {loading && passbook && <p className="passbook-no-print text-sm text-slate-500">Refreshing statement…</p>}

      {passbook && (
        <div id="cornestone-passbook-print" className="space-y-5">
          <div className="passbook-card rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-emerald-700">CORNESTONE Co.LTD.</p>
                <h3 className="mt-1 text-2xl font-bold text-slate-900">Member Passbook</h3>
                <p className="mt-2 text-sm text-slate-700"><span className="font-semibold">Group:</span> {passbook.group.name}</p>
                <p className="text-sm text-slate-700"><span className="font-semibold">Member:</span> {passbook.member.fullName}</p>
                <p className="text-sm text-slate-700"><span className="font-semibold">Member ID:</span> {passbook.member.id} <span className="ml-3 font-semibold">Role:</span> {passbook.member.role}</p>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm sm:min-w-44">
                <p className="text-slate-500">Statement period</p>
                <p className="font-bold text-slate-900">{passbook.summary.displayedPeriod}</p>
                <p className="mt-1 text-xs text-slate-500">Printed: {new Date().toLocaleDateString()}</p>
                <p className="mt-1 text-xs text-slate-500">Currency: RWF</p>
              </div>
            </div>
            <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">Keep this statement and compare it with your receipts and transaction references. Raise any discrepancy with company leadership promptly.</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Net Savings / Shares" value={passbook.summary.savingsBalance} tone="emerald" />
            <SummaryCard label="Net Fines Paid" value={passbook.summary.finesPaid} tone="purple" />
            <SummaryCard label="Current Loan Balance" value={passbook.summary.currentLoanBalance} tone="amber" subtitle={`${passbook.summary.outstandingLoanCount} outstanding loan(s)`} />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <SummaryCard label="Loans Disbursed" value={passbook.summary.totalLoanDisbursed} tone="slate" />
            <SummaryCard label="Loan Repayments" value={passbook.summary.totalLoanRepayments} tone="slate" />
            <SummaryCard label="Interest / Service Charge Paid" value={passbook.summary.interestPaid} tone="slate" subtitle={passbook.summary.legacyRepayments > 0 ? `${money(passbook.summary.legacyRepayments)} RWF in historic repayments have no verified principal/interest split.` : "Excludes repayments whose historic split was not recorded."} />
          </div>

          {passbook.summary.legacyRepayments > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              Historic repayments totalling {money(passbook.summary.legacyRepayments)} RWF do not have a verified principal/interest breakdown. They are shown separately and have not been guessed or reclassified.
            </div>
          )}

          <div className="passbook-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">Meeting-by-meeting activity</h3>
                <p className="mt-1 text-xs text-slate-500">Running balances are shown after each entry. Loan balance reflects known loan disbursements and allocated repayments in the selected statement period.</p>
              </div>
              <span className="passbook-no-print rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{events.length} entries</span>
            </div>
            {events.length ? (
              <div className="overflow-x-auto">
                <table className="passbook-table w-full min-w-[980px] border-collapse text-left text-xs text-slate-700">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="border-b px-3 py-3">Date</th>
                      <th className="border-b px-3 py-3">Cycle / Meeting</th>
                      <th className="border-b px-3 py-3">Activity</th>
                      <th className="border-b px-3 py-3 text-right">Amount (RWF)</th>
                      <th className="border-b px-3 py-3 text-right">Shares</th>
                      <th className="border-b px-3 py-3 text-right">Principal</th>
                      <th className="border-b px-3 py-3 text-right">Interest</th>
                      <th className="border-b px-3 py-3 text-right">Running Savings</th>
                      <th className="border-b px-3 py-3 text-right">Fines Paid</th>
                      <th className="border-b px-3 py-3 text-right">Known Loan Balance</th>
                      <th className="border-b px-3 py-3">Status / Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => {
                      const displayedAmount = memberFacingAmount(event);
                      return (
                        <tr key={event.id} className="border-b border-slate-100 align-top last:border-0">
                          <td className="whitespace-nowrap px-3 py-3">{dateOnly(event.occurredAt)}</td>
                          <td className="whitespace-nowrap px-3 py-3">Cycle {event.cycleNumber}<br />Meeting {event.meetingNumber ?? "—"}</td>
                          <td className="max-w-56 px-3 py-3 font-semibold text-slate-800">{event.activity}{event.fineReason ? <span className="mt-1 block font-normal text-slate-500">{event.fineReason}</span> : null}{event.loanId ? <span className="mt-1 block font-normal text-slate-500">Loan #{event.loanId}</span> : null}</td>
                          <td className={`whitespace-nowrap px-3 py-3 text-right font-semibold ${displayedAmount < 0 ? "text-rose-700" : "text-slate-800"}`}>{displayedAmount < 0 ? "−" : ""}{money(Math.abs(displayedAmount))}</td>
                          <td className="px-3 py-3 text-right">{event.sharesCount || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right">{event.principalAmount == null ? "—" : money(event.principalAmount)}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right">{event.interestAmount == null ? "—" : money(event.interestAmount)}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right">{money(event.runningSavingsBalance)}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right">{money(event.runningFinesPaid)}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right">{money(event.runningLoanBalance)}</td>
                          <td className="max-w-56 px-3 py-3"><span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${event.status === "REVERSED" || event.status === "CORRECTION" ? "bg-rose-100 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{event.status}</span>{event.historicalSplitUnavailable ? <span className="mt-1 block text-amber-700">Principal/interest split unavailable</span> : null}{event.notes ? <span className="mt-1 block break-words text-slate-500">{event.notes}</span> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500">No passbook entries are recorded for this period yet.</p>
            )}
          </div>

          <div className="passbook-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-base font-bold text-slate-900">Loan schedule and balances</h3>
            {passbook.loans.length ? (
              <div className="mt-3 overflow-x-auto">
                <table className="passbook-table w-full min-w-[680px] text-left text-xs text-slate-700">
                  <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="px-3 py-2">Loan</th><th className="px-3 py-2">Cycle</th><th className="px-3 py-2 text-right">Principal</th><th className="px-3 py-2 text-right">Interest Due</th><th className="px-3 py-2 text-right">Total Due</th><th className="px-3 py-2 text-right">Balance Left</th><th className="px-3 py-2">Due Date</th><th className="px-3 py-2">Status</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{passbook.loans.map((loan) => <tr key={loan.id}><td className="px-3 py-2.5 font-semibold">#{loan.id}</td><td className="px-3 py-2.5">{passbook.cycles.find((cycle) => cycle.id === loan.cycleId)?.cycleNumber ?? "—"}</td><td className="px-3 py-2.5 text-right">{money(loan.principalAmount)}</td><td className="px-3 py-2.5 text-right">{money(loan.totalInterestDue)}</td><td className="px-3 py-2.5 text-right">{money(loan.totalAmountDue)}</td><td className="px-3 py-2.5 text-right font-bold">{money(loan.balanceRemaining)}</td><td className="px-3 py-2.5">{dateOnly(loan.dueDate)}</td><td className="px-3 py-2.5">{loan.status}</td></tr>)}</tbody>
                </table>
              </div>
            ) : <p className="mt-3 text-sm text-slate-500">No loan records found for this period.</p>}
          </div>
          <p className="text-center text-[10px] text-slate-400">Generated by CORNESTONE Co.LTD. • Verify entries against official receipts and meeting records.</p>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone = "slate", subtitle = "" }) {
  const tones = {
    emerald: "text-emerald-700 bg-emerald-50",
    blue: "text-blue-700 bg-blue-50",
    purple: "text-purple-700 bg-purple-50",
    amber: "text-amber-700 bg-amber-50",
    slate: "text-slate-700 bg-slate-50",
  };
  return (
    <div className="passbook-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-3 inline-flex rounded-lg px-2.5 py-1 text-xl font-bold ${tones[tone] || tones.slate}`}>{money(value)} <span className="ml-1 text-xs font-semibold">RWF</span></p>
      {subtitle ? <p className="mt-2 text-xs text-slate-500">{subtitle}</p> : null}
    </div>
  );
}
