const db = require("../config/db");
const { writeAuditEvent } = require("./auditService");

const ATTENDANCE_STATUSES = new Set(["PRESENT", "ABSENT", "EXCUSED"]);
const MAX_TEXT = 12000;
function cleanText(value, label) {
  const text = String(value ?? "").trim();
  if (text.length > MAX_TEXT) throw new Error(`${label} cannot exceed ${MAX_TEXT} characters.`);
  return text || null;
}
function parseJson(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function listMeetings(groupId, cycleId) {
  const [rows] = await db.query(
    `SELECT m.id, m.group_id, m.cycle_id, m.meeting_number, m.date, m.status,
        mr.updated_at AS record_updated_at,
        COALESCE(SUM(CASE WHEN ma.attendance_status = 'PRESENT' THEN 1 ELSE 0 END), 0) AS present_count,
        COUNT(ma.id) AS attendance_marked_count
     FROM meetings m
     LEFT JOIN meeting_records mr ON mr.meeting_id = m.id
     LEFT JOIN meeting_attendance ma ON ma.meeting_id = m.id
     WHERE m.group_id = ? AND m.cycle_id = ?
     GROUP BY m.id, m.group_id, m.cycle_id, m.meeting_number, m.date, m.status, mr.updated_at
     ORDER BY m.meeting_number DESC, m.id DESC`,
    [groupId, cycleId],
  );
  return rows.map((row) => ({
    id: Number(row.id), groupId: Number(row.group_id), cycleId: Number(row.cycle_id),
    meetingNumber: Number(row.meeting_number), date: row.date, status: row.status,
    presentCount: Number(row.present_count || 0), attendanceMarkedCount: Number(row.attendance_marked_count || 0),
    recordUpdatedAt: row.record_updated_at,
  }));
}

async function getMeetingRecord(groupId, cycleId, meetingId) {
  const [meetingRows] = await db.query(
    `SELECT id, group_id, cycle_id, meeting_number, date, status
     FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? LIMIT 1`,
    [meetingId, groupId, cycleId],
  );
  if (!meetingRows.length) {
    const error = new Error("The selected meeting does not belong to this group and cycle.");
    error.statusCode = 404;
    throw error;
  }
  const [recordRows] = await db.query(
    `SELECT agenda, minutes, decisions, action_items, recorded_by, updated_by, created_at, updated_at
     FROM meeting_records WHERE meeting_id = ? AND group_id = ? AND cycle_id = ? LIMIT 1`,
    [meetingId, groupId, cycleId],
  );
  const [memberRows] = await db.query(
    `SELECT u.id, u.full_name, u.phone_number, u.is_active,
        COALESCE(a.attendance_status, 'NOT_RECORDED') AS attendance_status,
        COALESCE(a.notes, '') AS attendance_notes,
        a.updated_at AS attendance_updated_at
     FROM users u
     LEFT JOIN meeting_attendance a ON a.member_id = u.id AND a.meeting_id = ?
     WHERE u.group_id = ? AND (COALESCE(u.is_active, 1) = 1 OR a.id IS NOT NULL)
     ORDER BY u.is_active DESC, u.full_name ASC`,
    [meetingId, groupId],
  );
  const [summaryRows] = await db.query(
    `SELECT member_id,
        COALESCE(SUM(CASE WHEN type = 'SHARE_PURCHASE' AND COALESCE(credited_meeting_id, meeting_id) = ? AND status = 'POSTED' THEN shares_count ELSE 0 END), 0) AS shares_credited_for_meeting,
        COALESCE(SUM(CASE WHEN meeting_id = ? AND type = 'SHARE_PURCHASE' AND COALESCE(credited_meeting_id, meeting_id) <> meeting_id AND status = 'POSTED' THEN shares_count ELSE 0 END), 0) AS gusibuza_shares_bought_now,
        COALESCE(SUM(CASE WHEN meeting_id = ? AND type = 'GUSIBUZA_FEE' AND status = 'POSTED' THEN amount ELSE 0 END), 0) AS gusibuza_fees_paid
     FROM transactions
     WHERE group_id = ? AND cycle_id = ? AND (meeting_id = ? OR credited_meeting_id = ?)
     GROUP BY member_id`,
    [meetingId, meetingId, meetingId, groupId, cycleId, meetingId, meetingId],
  );
  const [fineSummaryRows] = await db.query(
    `SELECT member_id, COALESCE(SUM(CASE WHEN status <> 'REVERSED' THEN amount ELSE 0 END), 0) AS assessed,
        COALESCE(SUM(CASE WHEN status <> 'REVERSED' THEN amount_paid ELSE 0 END), 0) AS paid
     FROM fine_assessments WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? GROUP BY member_id`,
    [groupId, cycleId, meetingId],
  );
  const summaryByMember = new Map(summaryRows.map((row) => [Number(row.member_id), {
    sharesCreditedForMeeting: Number(row.shares_credited_for_meeting || 0),
    gusibuzaSharesBoughtNow: Number(row.gusibuza_shares_bought_now || 0),
    gusibuzaFeesPaid: Number(row.gusibuza_fees_paid || 0),
  }]));
  const fineSummaryByMember = new Map(fineSummaryRows.map((row) => [Number(row.member_id), {
    finesAssessed: Number(row.assessed || 0), finesPaid: Number(row.paid || 0),
  }]));
  const record = recordRows[0] || {};
  return {
    meeting: {
      id: Number(meetingRows[0].id), groupId: Number(meetingRows[0].group_id), cycleId: Number(meetingRows[0].cycle_id),
      meetingNumber: Number(meetingRows[0].meeting_number), date: meetingRows[0].date, status: meetingRows[0].status,
    },
    notes: { agenda: record.agenda || "", minutes: record.minutes || "", decisions: record.decisions || "", actionItems: record.action_items || "", updatedAt: record.updated_at || null },
    attendance: memberRows.map((row) => ({
      memberId: Number(row.id), fullName: row.full_name, phoneNumber: row.phone_number,
      isActive: Number(row.is_active) !== 0, status: row.attendance_status, notes: row.attendance_notes || "",
      updatedAt: row.attendance_updated_at || null,
      summary: { ...(summaryByMember.get(Number(row.id)) || { sharesCreditedForMeeting: 0, gusibuzaSharesBoughtNow: 0, gusibuzaFeesPaid: 0 }), ...(fineSummaryByMember.get(Number(row.id)) || { finesAssessed: 0, finesPaid: 0 }) },
    })),
  };
}

async function saveMeetingRecord({ groupId, cycleId, meetingId, actorUserId, agenda, minutes, decisions, actionItems, attendance, auditMeta = {} }) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [meetingRows] = await connection.query(
      `SELECT id, meeting_number, status FROM meetings
       WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE`,
      [meetingId, groupId, cycleId],
    );
    if (!meetingRows.length) throw new Error("The selected meeting does not belong to this group and cycle.");
    if (meetingRows[0].status !== "OPEN") throw new Error("Meeting notes and attendance are locked after the meeting is closed.");

    const [existingRows] = await connection.query(
      `SELECT agenda, minutes, decisions, action_items FROM meeting_records WHERE meeting_id = ? FOR UPDATE`,
      [meetingId],
    );
    const before = existingRows[0] || null;
    const [beforeAttendanceRows] = await connection.query(
      `SELECT member_id, attendance_status, notes FROM meeting_attendance WHERE meeting_id = ? ORDER BY member_id`,
      [meetingId],
    );
    const nextRecord = {
      agenda: cleanText(agenda, "Agenda"), minutes: cleanText(minutes, "Minutes"),
      decisions: cleanText(decisions, "Decisions"), actionItems: cleanText(actionItems, "Action items"),
    };
    await connection.query(
      `INSERT INTO meeting_records (group_id, cycle_id, meeting_id, agenda, minutes, decisions, action_items, recorded_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE agenda = VALUES(agenda), minutes = VALUES(minutes), decisions = VALUES(decisions),
         action_items = VALUES(action_items), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
      [groupId, cycleId, meetingId, nextRecord.agenda, nextRecord.minutes, nextRecord.decisions, nextRecord.actionItems, actorUserId, actorUserId],
    );

    if (!Array.isArray(attendance)) throw new Error("Attendance must be provided as a list.");
    const seen = new Set();
    for (const item of attendance) {
      const memberId = Number(item.memberId);
      const status = String(item.status || "").toUpperCase();
      if (!Number.isSafeInteger(memberId) || memberId <= 0 || !ATTENDANCE_STATUSES.has(status)) {
        throw new Error("Mark every member as Present, Absent, or Excused before saving the attendance register.");
      }
      if (seen.has(memberId)) throw new Error("A member appears more than once in the attendance list.");
      seen.add(memberId);
      const [memberRows] = await connection.query("SELECT id, full_name FROM users WHERE id = ? AND group_id = ?", [memberId, groupId]);
      if (!memberRows.length) throw new Error("Attendance cannot be recorded for a member from another group.");
      const notes = String(item.notes || "").trim().slice(0, 500) || null;
      if (status === "EXCUSED" && !notes) throw new Error(`Enter the reason ${memberRows[0]?.full_name ? `for ${memberRows[0].full_name} ` : ""}is excused from this meeting.`);
      await connection.query(
        `INSERT INTO meeting_attendance
          (group_id, cycle_id, meeting_id, member_id, attendance_status, notes, recorded_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE attendance_status = VALUES(attendance_status), notes = VALUES(notes), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
        [groupId, cycleId, meetingId, memberId, status, notes, actorUserId, actorUserId],
      );
    }

    const after = { ...nextRecord, attendance: attendance.map((item) => ({ memberId: Number(item.memberId), status: String(item.status || "").toUpperCase(), notes: String(item.notes || "").trim().slice(0, 500) })) };
    await writeAuditEvent(connection, {
      groupId, cycleId, meetingId, actorUserId, action: "MEETING_RECORDS_UPDATED", entityType: "MEETING_RECORD", entityId: meetingId,
      beforeData: before || beforeAttendanceRows.length ? {
        notes: before ? { agenda: before.agenda, minutes: before.minutes, decisions: before.decisions, actionItems: before.action_items } : null,
        attendance: beforeAttendanceRows.map((row) => ({ memberId: Number(row.member_id), status: row.attendance_status, notes: row.notes || "" })),
      } : null,
      afterData: after, ...auditMeta,
    });
    await connection.commit();
    return { meetingId, meetingNumber: Number(meetingRows[0].meeting_number), status: "OPEN", message: "Meeting notes and attendance saved." };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { listMeetings, getMeetingRecord, saveMeetingRecord };
