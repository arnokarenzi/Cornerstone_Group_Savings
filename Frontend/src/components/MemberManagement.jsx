import { useState, useEffect, useCallback } from "react";
import API from "../services/api";

const roleNames = { ADMIN: "Administrator", CHAIRPERSON: "Chairperson", SECRETARY: "Secretary", TREASURER: "Treasurer", MEMBER: "Member" };

function StatusBadge({ status }) {
  const normalized = String(status || "PENDING").toUpperCase();
  const classes = normalized === "APPROVED" ? "bg-emerald-50 text-emerald-700 border-emerald-100"
    : normalized === "REJECTED" || normalized === "SUSPENDED" ? "bg-rose-50 text-rose-700 border-rose-100"
      : "bg-amber-50 text-amber-800 border-amber-100";
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${classes}`}>{normalized}</span>;
}

export default function MemberManagement({ user }) {
  const [membersList, setMembersList] = useState([]);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [loading, setLoading] = useState(false);
  const [busyUserId, setBusyUserId] = useState(null);
  const groupId = Number(user?.groupId ?? user?.group_id);
  const hasValidGroupId = Number.isSafeInteger(groupId) && groupId > 0;

  const fetchMembers = useCallback(async () => {
    if (!hasValidGroupId) return;
    setLoading(true);
    try {
      const res = await API.get("/auth/registrations");
      if (res.data.success) setMembersList(res.data.members || []);
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || "Failed to load member registrations." });
    } finally {
      setLoading(false);
    }
  }, [hasValidGroupId]);

  useEffect(() => { void Promise.resolve().then(() => fetchMembers()); }, [fetchMembers]);

  const decide = async (member, decision) => {
    const actionLabels = { APPROVE: "approve", REJECT: "reject", SUSPEND: "suspend", REACTIVATE: "reactivate" };
    const actionText = actionLabels[decision] || "update";
    let reason = "";
    if (["REJECT", "SUSPEND"].includes(decision)) {
      reason = window.prompt(`Optional reason to ${actionText} ${member.full_name}:`, "") || "";
    }
    if (!window.confirm(`${actionText.charAt(0).toUpperCase()}${actionText.slice(1)} ${member.full_name}'s account?`)) return;

    setBusyUserId(member.id);
    setMessage({ type: "", text: "" });
    try {
      const response = await API.patch(`/auth/registrations/${member.id}/decision`, { decision, reason });
      setMessage({ type: "success", text: response.data.message || `Account ${actionText}d.` });
      await fetchMembers();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || `Could not ${actionText} this account.` });
    } finally {
      setBusyUserId(null);
    }
  };

  const pendingCount = membersList.filter((member) => String(member.approval_status).toUpperCase() === "PENDING").length;
  const verifiedCount = membersList.filter((member) => Boolean(member.email_verified_at)).length;

  return (
    <div className="bg-white p-6 rounded-2xl shadow-2xs border border-slate-200 space-y-6">
      <div className="border-b border-slate-100 pb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Member Registrations &amp; Approvals</h2>
          <p className="text-xs leading-5 text-slate-500 mt-1">Members register themselves with an email and password. Any authorized committee member may approve a verified application.</p>
        </div>
        <button type="button" onClick={() => void fetchMembers()} disabled={loading} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{loading ? "Refreshing..." : "Refresh list"}</button>
      </div>

      {message.text && <div role="status" className={`p-3 text-sm rounded-xl ${message.type === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{message.text}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs text-slate-500">Total accounts</p><p className="mt-1 text-2xl font-bold text-slate-900">{membersList.length}</p></div>
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4"><p className="text-xs text-amber-800">Awaiting committee decision</p><p className="mt-1 text-2xl font-bold text-amber-900">{pendingCount}</p></div>
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs text-slate-500">Email verified</p><p className="mt-1 text-2xl font-bold text-slate-900">{verifiedCount}</p></div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[850px] text-left text-sm text-slate-600">
          <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-3 py-3">Member</th>
              <th className="px-3 py-3">Email verification</th>
              <th className="px-3 py-3">Account status</th>
              <th className="px-3 py-3">Requested</th>
              <th className="px-3 py-3">Committee action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {membersList.map((member) => {
              const isPending = String(member.approval_status).toUpperCase() === "PENDING";
              const emailVerified = Boolean(member.email_verified_at);
              return (
                <tr key={member.id}>
                  <td className="px-3 py-3 align-top">
                    <p className="font-semibold text-slate-900">{member.full_name}</p>
                    <p className="text-xs text-slate-500">{member.email || "No email"}</p>
                    <p className="text-xs text-slate-400">{member.phone_number || "No phone provided"}</p>
                    <p className="mt-1 text-xs text-slate-500">{roleNames[member.role] || member.role}</p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${emailVerified ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{emailVerified ? "Verified" : "Not verified"}</span>
                  </td>
                  <td className="px-3 py-3 align-top"><StatusBadge status={member.approval_status} /></td>
                  <td className="px-3 py-3 align-top text-xs">{member.created_at ? new Date(member.created_at).toLocaleDateString() : "—"}</td>
                  <td className="px-3 py-3 align-top">
                    {isPending ? <div className="flex flex-col gap-2 items-start">
                      <button type="button" disabled={!emailVerified || busyUserId === member.id} onClick={() => void decide(member, "APPROVE")} title={!emailVerified ? "The member must verify their email first" : "Approve account"} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40">{busyUserId === member.id ? "Saving..." : "Approve member"}</button>
                      <button type="button" disabled={busyUserId === member.id} onClick={() => void decide(member, "REJECT")} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-40">Reject application</button>
                      {!emailVerified && <p className="max-w-[180px] text-xs text-amber-800">Waiting for the member to verify their email before approval.</p>}
                    </div> : String(member.approval_status).toUpperCase() === "APPROVED" ? <button type="button" disabled={Number(member.id) === Number(user?.id) || busyUserId === member.id} onClick={() => void decide(member, "SUSPEND")} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40">Suspend access</button> : String(member.approval_status).toUpperCase() === "SUSPENDED" ? <button type="button" disabled={!emailVerified || busyUserId === member.id} onClick={() => void decide(member, "REACTIVATE")} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-40">Reactivate access</button> : <span className="text-xs text-slate-400">No action available</span>}
                  </td>
                </tr>
              );
            })}
            {!membersList.length && !loading && <tr><td colSpan="5" className="px-3 py-10 text-center text-sm text-slate-500">No member accounts were found.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-5 text-slate-500">Approval, rejection, suspension and reactivation decisions are audited with the committee member’s ID, role, timestamp and optional reason. Suspensions invalidate active sessions; the member must sign in again after reactivation. You cannot suspend your own signed-in account.</p>
    </div>
  );
}
