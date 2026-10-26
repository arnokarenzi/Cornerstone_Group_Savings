import { useCallback, useEffect, useState } from "react";
import API from "../services/api";

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const ATTENDANCE_OPTIONS = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "Absent" },
  { value: "EXCUSED", label: "Excused" },
];

export default function MeetingRecords({ user, activeCycleId }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const canEdit = LEADERSHIP_ROLES.includes(user?.role);
  const [meetings, setMeetings] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState("");
  const [record, setRecord] = useState(null);
  const [agenda, setAgenda] = useState("");
  const [minutes, setMinutes] = useState("");
  const [decisions, setDecisions] = useState("");
  const [actionItems, setActionItems] = useState("");
  const [attendance, setAttendance] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState({ type: "", text: "" });

  const loadMeetings = useCallback(async () => {
    if (!groupId || !activeCycleId) { setMeetings([]); setSelectedMeetingId(""); return; }
    setLoading(true);
    try {
      const response = await API.get(`/groups/${groupId}/cycles/${activeCycleId}/meetings`);
      const rows = response.data.success ? response.data.meetings || [] : [];
      setMeetings(rows);
      setSelectedMeetingId((current) => rows.some((item) => String(item.id) === String(current))
        ? String(current) : rows.length ? String(rows[0].id) : "");
    } catch (error) {
      setNotice({ type: "error", text: error.response?.data?.message || "Could not load meeting records." });
      setMeetings([]);
    } finally { setLoading(false); }
  }, [groupId, activeCycleId]);

  useEffect(() => { void Promise.resolve().then(() => loadMeetings()); }, [loadMeetings]);

  useEffect(() => {
    let active = true;
    const loadRecord = async () => {
      if (!groupId || !activeCycleId || !selectedMeetingId) { setRecord(null); setAttendance([]); return; }
      setLoading(true);
      try {
        const response = await API.get(`/groups/${groupId}/meetings/${selectedMeetingId}/record`, { params: { cycleId: activeCycleId } });
        if (!active) return;
        const payload = response.data.record;
        setRecord(payload);
        setAgenda(payload.notes.agenda || "");
        setMinutes(payload.notes.minutes || "");
        setDecisions(payload.notes.decisions || "");
        setActionItems(payload.notes.actionItems || "");
        setAttendance((payload.attendance || []).map((member) => ({
          memberId: member.memberId, fullName: member.fullName, phoneNumber: member.phoneNumber,
          isActive: member.isActive, status: member.status === "NOT_RECORDED" ? "" : (member.status || ""), notes: member.notes || "",
        })));
      } catch (error) {
        if (active) setNotice({ type: "error", text: error.response?.data?.message || "Could not load the meeting record." });
      } finally { if (active) setLoading(false); }
    };
    void loadRecord();
    return () => { active = false; };
  }, [groupId, activeCycleId, selectedMeetingId]);

  const updateAttendance = (memberId, field, value) => {
    setAttendance((current) => current.map((row) => row.memberId === memberId ? { ...row, [field]: value } : row));
  };

  const saveRecord = async (event) => {
    event.preventDefault();
    if (!selectedMeetingId || record?.meeting?.status !== "OPEN") return;
    const unmarked = attendance.filter((row) => row.isActive && !["PRESENT", "ABSENT", "EXCUSED"].includes(String(row.status).toUpperCase()));
    if (unmarked.length) {
      setNotice({ type: "error", text: `Choose Present, Absent, or Excused for every active member. Not marked: ${unmarked.map((row) => row.fullName).join(", ")}.` });
      return;
    }
    const excusedWithoutReason = attendance.filter((row) => row.isActive && String(row.status).toUpperCase() === "EXCUSED" && !String(row.notes || "").trim());
    if (excusedWithoutReason.length) {
      setNotice({ type: "error", text: `Enter a reason for every excused member: ${excusedWithoutReason.map((row) => row.fullName).join(", ")}.` });
      return;
    }
    setSaving(true);
    setNotice({ type: "", text: "" });
    try {
      const response = await API.put(`/groups/${groupId}/meetings/${selectedMeetingId}/record`, {
        cycleId: Number(activeCycleId), agenda, minutes, decisions, actionItems,
        attendance: attendance.map(({ memberId, status, notes }) => ({ memberId, status, notes })),
      });
      if (!response.data.success) throw new Error(response.data.message || "Could not save meeting record.");
      setNotice({ type: "success", text: "Meeting notes and attendance saved. The changes were added to the audit trail." });
      await loadMeetings();
      const refreshed = await API.get(`/groups/${groupId}/meetings/${selectedMeetingId}/record`, { params: { cycleId: activeCycleId } });
      setRecord(refreshed.data.record);
    } catch (error) {
      setNotice({ type: "error", text: error.response?.data?.message || error.message || "Could not save meeting record." });
    } finally { setSaving(false); }
  };

  const openMeeting = record?.meeting?.status === "OPEN";
  const editable = Boolean(canEdit && openMeeting);
  const presentCount = attendance.filter((row) => row.status === "PRESENT").length;
  const activeMembers = attendance.filter((row) => row.isActive);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Meeting Records &amp; Attendance</h2>
          <p className="mt-1 text-sm text-slate-500">Keep the agenda, minutes, decisions, follow-up actions and roll-call record for every meeting.</p>
        </div>
        <button type="button" onClick={() => void loadMeetings()} disabled={loading} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50">{loading ? "Loading…" : "Refresh"}</button>
      </div>

      {notice.text && <div className={`rounded-lg p-3 text-sm ${notice.type === "error" ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-800"}`}>{notice.text}</div>}
      {!activeCycleId ? <p className="text-sm text-amber-800">No active cycle is selected.</p> : meetings.length === 0 ? <p className="text-sm text-slate-500">No meetings have been opened in this cycle yet.</p> : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Choose meeting</label>
              <select value={selectedMeetingId} onChange={(event) => setSelectedMeetingId(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5">
                {meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>Meeting #{meeting.meetingNumber} · {new Date(meeting.date).toLocaleDateString()} · {meeting.status}</option>)}
              </select>
            </div>
            {record?.meeting && <span className={`inline-flex h-fit rounded-full px-3 py-1.5 text-xs font-bold ${openMeeting ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>{record.meeting.status}</span>}
          </div>
          {record && <>
            <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm flex flex-wrap gap-x-5 gap-y-1">
              <span><strong>Meeting:</strong> #{record.meeting.meetingNumber}</span>
              <span><strong>Date:</strong> {new Date(record.meeting.date).toLocaleDateString()}</span>
              <span><strong>Present:</strong> {presentCount} / {activeMembers.length} active members</span>
              {record.notes.updatedAt && <span className="text-slate-500"><strong>Last saved:</strong> {new Date(record.notes.updatedAt).toLocaleString()}</span>}
            </div>
            {!editable && <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800">This is a read-only view. Only leadership can edit records, and records are locked after a meeting is closed.</p>}
            <form onSubmit={saveRecord} className="space-y-4">
              {[{ label: "Agenda", value: agenda, setter: setAgenda, placeholder: "Topics to discuss…" }, { label: "Meeting minutes", value: minutes, setter: setMinutes, placeholder: "Summarize what happened, reports presented and matters discussed…" }, { label: "Decisions and resolutions", value: decisions, setter: setDecisions, placeholder: "Record decisions and how they were approved…" }, { label: "Action items / follow-up", value: actionItems, setter: setActionItems, placeholder: "Action, responsible person and due date…" }].map((field) => (
                <div key={field.label}>
                  <label className="mb-1 block text-sm font-semibold text-slate-700">{field.label}</label>
                  <textarea value={field.value} onChange={(event) => field.setter(event.target.value)} maxLength={12000} rows={field.label === "Meeting minutes" ? 5 : 3} disabled={!editable} placeholder={field.placeholder} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 disabled:bg-slate-50 disabled:text-slate-600" />
                </div>
              ))}
              <div className="space-y-3">
                <div>
                  <h3 className="font-bold text-slate-900">Attendance register</h3>
                  <p className="text-xs text-slate-500 mt-1">Choose exactly one status for every active member: Present, Absent or Excused. An Excused status requires a reason.</p>
                </div>
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full min-w-[650px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-3">Member</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Note</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {attendance.map((row) => <tr key={row.memberId} className={!row.isActive ? "opacity-60" : ""}>
                        <td className="px-3 py-3"><div className="font-medium">{row.fullName}</div><div className="text-xs text-slate-500">{row.phoneNumber}{!row.isActive ? " · Inactive" : ""}</div></td>
                        <td className="px-3 py-3"><select value={row.status} onChange={(event) => updateAttendance(row.memberId, "status", event.target.value)} disabled={!editable} required={row.isActive} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 disabled:bg-slate-50"><option value="">Choose status</option>{ATTENDANCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></td>
                        <td className="px-3 py-3"><input value={row.notes} onChange={(event) => updateAttendance(row.memberId, "notes", event.target.value)} disabled={!editable} maxLength={500} placeholder={row.status === "EXCUSED" ? "Required reason for excusal" : "Optional note"} required={row.isActive && row.status === "EXCUSED"} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 disabled:bg-slate-50" /></td>
                      </tr>)}
                    </tbody>
                  </table>
                </div>
              </div>
              {editable && <button type="submit" disabled={saving} className="rounded-lg bg-emerald-600 px-5 py-2.5 font-bold text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? "Saving records…" : "Save Meeting Record & Attendance"}</button>}
            </form>
          </>}
        </>
      )}
    </section>
  );
}
