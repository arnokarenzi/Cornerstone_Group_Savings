function toJson(value) {
  if (value == null) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > 60000) return JSON.stringify({ truncated: true, preview: encoded.slice(0, 59000) });
    return encoded;
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

/** Call this inside the same SQL transaction as the operation being audited. */
async function writeAuditEvent(connection, event) {
  const action = String(event.action || "UNKNOWN").slice(0, 80);
  const entityType = String(event.entityType || "UNKNOWN").slice(0, 60);
  const reason = event.reason == null ? null : String(event.reason).trim().slice(0, 1000) || null;
  await connection.query(
    `INSERT INTO audit_logs
      (group_id, cycle_id, meeting_id, actor_user_id, action, entity_type, entity_id,
       reason, before_json, after_json, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.groupId,
      event.cycleId ?? null,
      event.meetingId ?? null,
      event.actorUserId ?? null,
      action,
      entityType,
      event.entityId == null ? null : String(event.entityId),
      reason,
      toJson(event.beforeData),
      toJson(event.afterData),
      event.ipAddress ? String(event.ipAddress).slice(0, 64) : null,
      event.userAgent ? String(event.userAgent).slice(0, 500) : null,
    ],
  );
}

function parseAuditRow(row) {
  const parse = (value) => {
    if (value == null) return null;
    try { return JSON.parse(value); } catch { return { raw: value }; }
  };
  return {
    id: Number(row.id),
    groupId: Number(row.group_id),
    cycleId: row.cycle_id == null ? null : Number(row.cycle_id),
    meetingId: row.meeting_id == null ? null : Number(row.meeting_id),
    actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
    actorName: row.actor_name || "Unknown user",
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    beforeData: parse(row.before_json),
    afterData: parse(row.after_json),
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  };
}

module.exports = { writeAuditEvent, parseAuditRow };
