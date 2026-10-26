import { useEffect, useState } from "react";
import API from "../services/api";
import MeetingOperations from "./MeetingOperations";
import LoanOperations from "./LoanOperations";
import ShareOutPreview from "./ShareOutPreview";
import CashbookOperations from "./CashbookOperations";
import MemberManagement from "./MemberManagement";
import MeetingRecords from "./MeetingRecords";
import ReceiptsAndAudit from "./ReceiptsAndAudit";
import ConstitutionManagement from "./ConstitutionManagement";
import MemberPassbook from "./MemberPassbook";
import CycleManagement from "./CycleManagement";
import FinancialRequests from "./FinancialRequests";
import MemberFinance from "./MemberFinance";
import CommitteeManagement from "./CommitteeManagement";

export default function Dashboard({ user, onLogout }) {
  const [groupDashboard, setGroupDashboard] = useState(null);
  const [memberDashboard, setMemberDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [activeLeadershipTool, setActiveLeadershipTool] = useState("operations");
  const [activeCycle, setActiveCycle] = useState(null);
  const groupId = Number(user?.groupId ?? user?.group_id);
  const activeCycleId = activeCycle?.id ?? null;
  const isLeadership = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"].includes(String(user?.role || "").toUpperCase());

  const handleCycleChanged = async (nextCycle) => {
    if (!nextCycle?.id) return;
    setActiveCycle(nextCycle);
    try {
      const [groupRes, memberRes] = await Promise.all([
        API.get(`/groups/${groupId}/cycles/${nextCycle.id}/dashboard`),
        API.get(`/groups/${groupId}/cycles/${nextCycle.id}/members/${user.id}/dashboard`),
      ]);
      if (groupRes.data.success) setGroupDashboard(groupRes.data.dashboard);
      if (memberRes.data.success) setMemberDashboard(memberRes.data.dashboard);
    } catch {
      // The cycle component reports the successfully created cycle; metrics can refresh on next visit.
    }
  };

  useEffect(() => {
    let isMounted = true;

    const fetchDashboardData = async () => {
      setLoading(true);
      setError("");

      if (!Number.isSafeInteger(groupId) || groupId <= 0) {
        setError("Your login is missing a valid company association. Please sign out and sign in again.");
        setLoading(false);
        return;
      }

      try {
        // A cycle ID is global; find the active cycle that belongs to this group
        // instead of assuming every group uses cycle ID 1.
        const cycleRes = await API.get(`/groups/${groupId}/cycles/active`);
        if (!cycleRes.data.success || !cycleRes.data.cycle?.id) {
          throw new Error("No active savings cycle is configured for CORNESTONE Co.LTD.");
        }
        const cycle = cycleRes.data.cycle;
        if (isMounted) setActiveCycle(cycle);

        const [groupRes, memberRes] = await Promise.all([
          API.get(`/groups/${groupId}/cycles/${cycle.id}/dashboard`),
          API.get(`/groups/${groupId}/cycles/${cycle.id}/members/${user.id}/dashboard`),
        ]);

        if (!isMounted) return;
        if (groupRes.data.success) setGroupDashboard(groupRes.data.dashboard);
        if (memberRes.data.success) setMemberDashboard(memberRes.data.dashboard);
      } catch (err) {
        if (!isMounted) return;
        setError(
          err.response?.data?.message || err.message || "Failed to fetch dashboard data.",
        );
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    void fetchDashboardData();
    return () => {
      isMounted = false;
    };
  }, [groupId, user?.id]);

  // Refresh financial figures in place. Do not reload the page, because MeetingOperations
  // must stay mounted while staff record transactions for multiple members in one meeting.
  const refreshDashboardMetrics = async () => {
    if (!groupId || !activeCycleId || !user?.id) return;
    try {
      const [groupRes, memberRes] = await Promise.all([
        API.get(`/groups/${groupId}/cycles/${activeCycleId}/dashboard`),
        API.get(`/groups/${groupId}/cycles/${activeCycleId}/members/${user.id}/dashboard`),
      ]);
      if (groupRes.data.success) setGroupDashboard(groupRes.data.dashboard);
      if (memberRes.data.success) setMemberDashboard(memberRes.data.dashboard);
    } catch {
      // Keep the active meeting open if a dashboard summary refresh fails.
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#F4F5F7]">
        <div className="text-sm font-semibold text-emerald-600 animate-pulse">
          Loading CORNESTONE...
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#F4F5F7] font-sans antialiased text-slate-800">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-[#EBECEF] border-r border-slate-200/80 p-6 flex flex-col justify-between shrink-0">
        <div className="space-y-8">
          {/* Logo Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-emerald-600 text-white rounded-xl flex items-center justify-center font-bold text-lg shadow-sm">
              C
            </div>
            <div className="min-w-0">
              <span className="block text-sm font-extrabold tracking-tight text-slate-900">CORNESTONE</span>
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Co.LTD.</span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1.5">
            <p className="px-3 text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
              Menu
            </p>
            <button
              onClick={() => setActiveTab("overview")}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                activeTab === "overview"
                  ? "bg-slate-300/60 text-slate-900 font-semibold shadow-2xs"
                  : "text-slate-600 hover:bg-slate-200/50"
              }`}
            >
              Overview
            </button>

            <button
              onClick={() => setActiveTab("passbook")}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                activeTab === "passbook"
                  ? "bg-slate-300/60 text-slate-900 font-semibold shadow-2xs"
                  : "text-slate-600 hover:bg-slate-200/50"
              }`}
            >
              My Digital Passbook
            </button>

            {/* Share-out is read-only and visible to every approved company member. */}
            <button
              onClick={() => setActiveTab("share-out")}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                activeTab === "share-out"
                  ? "bg-slate-300/60 text-slate-900 font-semibold shadow-2xs"
                  : "text-slate-600 hover:bg-slate-200/50"
              }`}
            >
              Share-Out Preview
            </button>

            <button
              onClick={() => setActiveTab("constitution")}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                activeTab === "constitution"
                  ? "bg-slate-300/60 text-slate-900 font-semibold shadow-2xs"
                  : "text-slate-600 hover:bg-slate-200/50"
              }`}
            >
              Constitution &amp; Rules
            </button>

            {["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"].includes(
              user.role,
            ) && (
              <button
                onClick={() => setActiveTab("management")}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                  activeTab === "management"
                    ? "bg-slate-300/60 text-slate-900 font-semibold shadow-2xs"
                    : "text-slate-600 hover:bg-slate-200/50"
                }`}
              >
                Leadership Terminal
              </button>
            )}
            {isLeadership && (
              <button
                onClick={() => setActiveTab("cycle-management")}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                  activeTab === "cycle-management"
                    ? "bg-slate-300/60 text-slate-900 font-semibold shadow-2xs"
                    : "text-slate-600 hover:bg-slate-200/50"
                }`}
              >
                Cycle Closing &amp; New Cycle
              </button>
            )}
          </nav>
        </div>

        {/* User Info & Logout Footer */}
        <div className="pt-6 border-t border-slate-300/60 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-slate-900">
                {user.fullName}
              </p>
              <p className="text-[11px] text-emerald-700 font-medium">
                {user.role}
              </p>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="w-full py-2 text-xs font-semibold text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-lg transition"
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Top Header Bar */}
        <header className="bg-white/80 backdrop-blur-md border-b border-slate-200/80 px-8 py-4 flex justify-between items-center sticky top-0 z-10">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              {activeTab === "overview"
                ? "Overview"
                : activeTab === "passbook"
                  ? "My Digital Passbook"
                  : activeTab === "share-out"
                    ? "Share-Out Preview"
                    : activeTab === "constitution"
                      ? "Constitution & Rules"
                      : activeTab === "cycle-management"
                        ? "Cycle Closing & New Cycle"
                        : "Leadership Terminal"}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              CORNESTONE Co.LTD. · Cycle {activeCycle?.cycle_number ?? "Unavailable"} · Financial Summary
            </p>
          </div>
        </header>

        {activeCycle?.status === "CLOSING" && (
          <div className="mx-8 mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            <strong>Cycle {activeCycle.cycle_number} is in share-out closing.</strong> New financial entries are locked. Open <button type="button" onClick={() => setActiveTab("cycle-management")} className="font-bold underline underline-offset-2">Cycle Closing &amp; New Cycle</button> to record member payouts and finish the witnessed final cash count.
          </div>
        )}

        {/* Content Container */}
        <main className="p-8 max-w-7xl space-y-8">
          {error && (
            <div className="p-4 text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-2xl">
              {error}
            </div>
          )}

          {activeTab === "overview" ? (
            <>
              {/* Macro Financial Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                <div className="bg-white p-5 rounded-2xl shadow-2xs border border-slate-200/70">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Total Savings
                  </span>
                  <p className="text-2xl font-bold text-emerald-600 mt-2">
                    {Number(
                      groupDashboard?.totalGroupSavings || 0,
                    ).toLocaleString()}{" "}
                    <span className="text-xs font-semibold text-slate-400">
                      RWF
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Total Shares: {groupDashboard?.totalGroupShares || 0}
                  </p>
                </div>

                <div className="bg-white p-5 rounded-2xl shadow-2xs border border-slate-200/70">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Active Loans Outstanding
                  </span>
                  <p className="text-2xl font-bold text-amber-600 mt-2">
                    {Number(
                      groupDashboard?.totalOutstandingBalance || 0,
                    ).toLocaleString()}{" "}
                    <span className="text-xs font-semibold text-slate-400">
                      RWF
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Active Count: {groupDashboard?.activeLoansCount || 0}
                  </p>
                </div>

                <div className="bg-white p-5 rounded-2xl shadow-2xs border border-slate-200/70">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Fines Collected
                  </span>
                  <p className="text-2xl font-bold text-purple-600 mt-2">
                    {Number(groupDashboard?.totalFines || 0).toLocaleString()}{" "}
                    <span className="text-xs font-semibold text-slate-400">
                      RWF
                    </span>
                  </p>
                </div>
              </div>

              {/* Personal Balance & Loans Section */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Personal Savings */}
                <div className="bg-white p-6 rounded-2xl shadow-2xs border border-slate-200/70 space-y-4">
                  <h3 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-3">
                    My Savings
                  </h3>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-slate-500">Total Shares:</span>
                    <span className="font-bold text-slate-900">
                      {memberDashboard?.totalShares || 0}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-sm pt-2 border-t border-slate-50">
                    <span className="text-slate-500">Estimated Value:</span>
                    <span className="font-bold text-emerald-600 text-base">
                      {Number(
                        memberDashboard?.totalSavings || 0,
                      ).toLocaleString()}{" "}
                      RWF
                    </span>
                  </div>
                </div>

                {/* My Active Loans Table */}
                <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-2xs border border-slate-200/70">
                  <h3 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-3">
                    My Active Loans
                  </h3>
                  {memberDashboard?.activeLoans?.length > 0 ? (
                    <div className="overflow-x-auto mt-4">
                      <table className="w-full text-left text-sm text-slate-600">
                        <thead className="bg-slate-50 text-xs text-slate-400 uppercase">
                          <tr>
                            <th className="px-3 py-2">Principal</th>
                            <th className="px-3 py-2">Total Due</th>
                            <th className="px-3 py-2">Remaining</th>
                            <th className="px-3 py-2">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {memberDashboard.activeLoans.map((loan) => (
                            <tr key={loan.id}>
                              <td className="px-3 py-2.5 font-semibold text-slate-900">
                                {Number(loan.principal_amount).toLocaleString()}{" "}
                                RWF
                              </td>
                              <td className="px-3 py-2.5">
                                {Number(loan.total_amount_due).toLocaleString()}{" "}
                                RWF
                              </td>
                              <td className="px-3 py-2.5 text-amber-600 font-bold">
                                {Number(
                                  loan.balance_remaining,
                                ).toLocaleString()}{" "}
                                RWF
                              </td>
                              <td className="px-3 py-2.5">
                                <span className="px-2.5 py-0.5 text-xs font-semibold text-amber-700 bg-amber-50 rounded-full border border-amber-200">
                                  {loan.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 mt-4 italic">
                      No active loans found.
                    </p>
                  )}
                </div>
              </div>

              {/* Transactions Table */}
              <div className="bg-white p-6 rounded-2xl shadow-2xs border border-slate-200/70">
                <h3 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-3">
                  Recent Transactions
                </h3>
                {memberDashboard?.recentTransactions?.length > 0 ? (
                  <div className="overflow-x-auto mt-4">
                    <table className="w-full text-left text-sm text-slate-600">
                      <thead className="bg-slate-50 text-xs text-slate-400 uppercase">
                        <tr>
                          <th className="px-4 py-2.5">Type</th>
                          <th className="px-4 py-2.5">Amount</th>
                          <th className="px-4 py-2.5">Shares</th>
                          <th className="px-4 py-2.5">Reason</th>
                          <th className="px-4 py-2.5">Status</th>
                          <th className="px-4 py-2.5">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {memberDashboard.recentTransactions.map((tx) => (
                          <tr key={tx.id} className="hover:bg-slate-50/60">
                            <td className="px-4 py-3 font-semibold text-slate-900">
                              {tx.type}
                            </td>
                            <td className="px-4 py-3 font-bold text-emerald-600">
                              {Number(tx.amount).toLocaleString()} RWF
                            </td>
                            <td className="px-4 py-3">
                              {tx.shares_count || "-"}
                            </td>
                            <td className="px-4 py-3 text-slate-500">
                              {tx.fine_reason || "-"}
                            </td>
                            <td className="px-4 py-3 text-xs">
                              {tx.status === "REVERSED" ? <span className="rounded-full bg-rose-100 px-2 py-1 font-bold text-rose-700">REVERSED</span> : <span className="text-emerald-700">Posted</span>}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-400">
                              {new Date(tx.created_at).toLocaleDateString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 mt-4 italic">
                    No recent transactions recorded.
                  </p>
                )}
              </div>
            </>
          ) : activeTab === "passbook" ? (
            <div className="space-y-8">
              <MemberPassbook user={user} />
              {activeCycleId ? (
                <>
                  <MemberFinance user={user} activeCycleId={activeCycleId} mode="member" onFinancialChange={refreshDashboardMetrics} />
                  <FinancialRequests user={user} activeCycleId={activeCycleId} />
                </>
              ) : null}
            </div>
          ) : activeTab === "share-out" ? (
            <div className="space-y-8">
              {activeCycleId ? (
                <ShareOutPreview user={user} activeCycleId={activeCycleId} />
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  CORNESTONE has no active savings cycle yet, so the share-out preview cannot be calculated.
                </div>
              )}
            </div>
          ) : activeTab === "constitution" ? (
            <ConstitutionManagement user={user} />
          ) : activeTab === "cycle-management" && isLeadership ? (
            <CycleManagement user={user} activeCycle={activeCycle} onCycleChanged={handleCycleChanged} />
          ) : (
            /* Leadership Terminal: member administration, operations and internal tools */
            <div className="space-y-6">
              <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-4">
                {[
                  ["operations", "Member & Loan Operations"],
                  ["finance-applications", "Payments & Loan Applications"],
                  ["cashbook", "Cashbook & Reconciliation"],
                  ["records", "Records, Receipts & Audit"],
                  ["financial-requests", "Withdrawals & Restructuring"],
                  ...(String(user?.role || "").toUpperCase() === "ADMIN" ? [["committee-roles", "Committee & Roles"]] : []),
                ].map(([tool, label]) => (
                  <button key={tool} type="button" onClick={() => setActiveLeadershipTool(tool)}
                    className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${activeLeadershipTool === tool ? "bg-emerald-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                    {label}
                  </button>
                ))}
              </div>
              {activeLeadershipTool === "finance-applications" ? (
                activeCycleId ? <MemberFinance user={user} activeCycleId={activeCycleId} mode="leadership" onFinancialChange={refreshDashboardMetrics} /> : (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">No active cycle is available for payment confirmations or loan applications.</div>
                )
              ) : activeLeadershipTool === "committee-roles" ? (
                <CommitteeManagement user={user} />
              ) : activeLeadershipTool === "cashbook" ? (
                <CashbookOperations user={user} activeCycleId={activeCycleId} />
              ) : activeLeadershipTool === "records" ? (
                <div className="space-y-8">
                  <MeetingRecords user={user} activeCycleId={activeCycleId} />
                  <ReceiptsAndAudit user={user} activeCycleId={activeCycleId} />
                </div>
              ) : activeLeadershipTool === "financial-requests" ? (
                activeCycleId ? <FinancialRequests user={user} activeCycleId={activeCycleId} /> : (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">No active cycle is available for withdrawal or restructuring requests.</div>
                )
              ) : (
                <div className="space-y-8">
                  <MemberManagement user={user} />
                  {activeCycleId ? (
                    <>
                      <MeetingOperations
                        user={user}
                        activeCycleId={activeCycleId}
                        onOpenPaymentReview={() => { setActiveTab("management"); setActiveLeadershipTool("finance-applications"); }}
                      />
                      <LoanOperations
                        user={user}
                        activeCycleId={activeCycleId}
                        onOpenCashbook={() => { setActiveTab("management"); setActiveLeadershipTool("cashbook"); }}
                        onOpenPaymentReview={() => { setActiveTab("management"); setActiveLeadershipTool("finance-applications"); }}
                      />
                    </>
                  ) : (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                      This company has no active financial cycle yet. Complete initial setup before recording meetings or loans.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
