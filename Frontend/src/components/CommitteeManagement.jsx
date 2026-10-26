import { useCallback, useEffect, useState } from "react";
import API from "../services/api";

const ROLES = ["MEMBER", "TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const label = (role) => ({ MEMBER: "Member", TREASURER: "Treasurer", SECRETARY: "Secretary", CHAIRPERSON: "Chairperson", ADMIN: "Administrator" }[role] || role);

export default function CommitteeManagement({ user }) {
  const [members, setMembers] = useState([]);
  const [choices, setChoices] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  const loadMembers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await API.get("/auth/committee");
      const rows = response.data?.members || [];
      setMembers(rows);
      setChoices(Object.fromEntries(rows.map((member) => [member.id, member.role])));
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || "Could not load approved committee-eligible members." });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadMembers(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadMembers]);

  const changeRole = async (member) => {
    const nextRole = choices[member.id];
    if (!nextRole || nextRole === member.role) return;
    if (!window.confirm(`Change ${member.full_name}'s role from ${label(member.role)} to ${label(nextRole)}? Their current sessions will be invalidated and they must sign in again.`)) return;
    setBusyId(member.id); setMessage({ type: "", text: "" });
    try {
      const response = await API.patch(`/auth/committee/${member.id}/role`, { role: nextRole });
      setMessage({ type: "success", text: response.data?.message || "Committee role updated." });
      await loadMembers();
    } catch (error) {
      setChoices((current) => ({ ...current, [member.id]: member.role }));
      setMessage({ type: "error", text: error.response?.data?.message || "Could not change this member's role." });
    } finally { setBusyId(null); }
  };

  if (String(user?.role || "").toUpperCase() !== "ADMIN") {
    return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Only an administrator can appoint committee roles.</div>;
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-xl font-bold text-slate-900">Committee &amp; Roles</h2><p className="mt-1 text-sm text-slate-600">Only approved, active, email-verified members appear here. Role changes are audited and invalidate the target account's existing sessions.</p></div>
        <button type="button" onClick={() => void loadMembers()} disabled={loading} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-50">{loading ? "Refreshing…" : "Refresh members"}</button>
      </div>
      {message.text && <div role="status" className={`rounded-xl p-3 text-sm ${message.type === "error" ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-800"}`}>{message.text}</div>}
      <div className="rounded-lg bg-amber-50 p-3 text-sm leading-5 text-amber-900">Appoint a person only after the member is approved and you have followed the company's leadership appointment procedure. You cannot change your own role, and CORNESTONE must keep at least one active administrator.</div>
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Member</th><th className="p-3">Email</th><th className="p-3">Current role</th><th className="p-3">New role</th><th className="p-3">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{members.map((member) => <tr key={member.id}><td className="p-3 font-medium">{member.full_name}{Number(member.id) === Number(user?.id) && <div className="text-xs text-slate-500">Signed-in account</div>}</td><td className="p-3">{member.email}</td><td className="p-3">{label(member.role)}</td><td className="p-3"><select value={choices[member.id] || member.role} disabled={Number(member.id) === Number(user?.id) || busyId != null} onChange={(event) => setChoices((current) => ({ ...current, [member.id]: event.target.value }))} className="rounded-lg border border-slate-300 bg-white px-3 py-2">{ROLES.map((role) => <option key={role} value={role}>{label(role)}</option>)}</select></td><td className="p-3"><button type="button" disabled={Number(member.id) === Number(user?.id) || busyId != null || choices[member.id] === member.role} onClick={() => void changeRole(member)} className="rounded-lg bg-emerald-800 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{busyId === member.id ? "Saving…" : "Save role"}</button></td></tr>)}</tbody></table>{!loading && members.length === 0 && <p className="p-5 text-center text-sm text-slate-500">No eligible member accounts were found.</p>}</div>
    </div>
  );
}
