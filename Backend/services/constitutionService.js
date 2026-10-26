const db = require("../config/db");
const { writeAuditEvent } = require("./auditService");
const {
  normalizeConstitution,
  getInitialConstitutionFromSettings,
  parseSettings,
  majorityThreshold,
  evaluateVoteOutcome,
} = require("./constitutionRules");

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* handled with fallback below */ }
  }
  return fallback;
}

function mapConstitution(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    groupId: Number(row.group_id),
    versionNumber: Number(row.version_number),
    terms: parseJson(row.constitution_json),
    status: row.status,
    approvalMethod: row.approval_method,
    proposalReason: row.proposal_reason || "",
    createdBy: row.created_by == null ? null : Number(row.created_by),
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

async function ensureCurrentConstitution(groupId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [groupRows] = await connection.query(
      "SELECT id, settings FROM `groups` WHERE id = ? FOR UPDATE",
      [groupId],
    );
    if (!groupRows.length) {
      const error = new Error("Group not found.");
      error.statusCode = 404;
      throw error;
    }
    const [currentRows] = await connection.query(
      `SELECT * FROM group_constitutions WHERE group_id = ? AND status = 'CURRENT'
       ORDER BY version_number DESC LIMIT 1 FOR UPDATE`,
      [groupId],
    );
    if (currentRows.length) {
      await connection.commit();
      return mapConstitution(currentRows[0]);
    }

    const terms = getInitialConstitutionFromSettings(groupRows[0].settings);
    const [versionRows] = await connection.query(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM group_constitutions WHERE group_id = ?",
      [groupId],
    );
    const versionNumber = Number(versionRows[0]?.next_version || 1);
    const [insertResult] = await connection.query(
      `INSERT INTO group_constitutions
        (group_id, version_number, constitution_json, status, approval_method, proposal_reason, created_by)
       VALUES (?, ?, ?, 'CURRENT', 'LEGACY_IMPORTED', ?, NULL)`,
      [groupId, versionNumber, JSON.stringify(terms), "Imported from existing group settings. The group should review and ratify these interim rules."],
    );
    const [rows] = await connection.query("SELECT * FROM group_constitutions WHERE id = ?", [insertResult.insertId]);
    await connection.commit();
    return mapConstitution(rows[0]);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function getConstitution(groupId, userId) {
  const current = await ensureCurrentConstitution(groupId);
  const [proposalRows] = await db.query(
    `SELECT c.*,
       (SELECT COUNT(*) FROM constitution_votes v
          JOIN users voter ON voter.id = v.voter_user_id
         WHERE v.constitution_id = c.id AND v.vote = 'APPROVE'
           AND voter.group_id = c.group_id AND COALESCE(voter.is_active, 1) = 1
           AND COALESCE(voter.approval_status, 'APPROVED') = 'APPROVED'
           AND voter.email_verified_at IS NOT NULL) AS approvals,
       (SELECT COUNT(*) FROM constitution_votes v
          JOIN users voter ON voter.id = v.voter_user_id
         WHERE v.constitution_id = c.id AND v.vote = 'REJECT'
           AND voter.group_id = c.group_id AND COALESCE(voter.is_active, 1) = 1
           AND COALESCE(voter.approval_status, 'APPROVED') = 'APPROVED'
           AND voter.email_verified_at IS NOT NULL) AS rejections,
       (SELECT vote FROM constitution_votes v WHERE v.constitution_id = c.id AND v.voter_user_id = ?) AS user_vote
     FROM group_constitutions c
     WHERE c.group_id = ? AND c.status = 'PENDING'
     ORDER BY c.version_number DESC LIMIT 1`,
    [userId, groupId],
  );
  const pendingRow = proposalRows[0] || null;
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS active_members FROM users
     WHERE group_id = ? AND COALESCE(is_active, 1) = 1
       AND COALESCE(approval_status, 'APPROVED') = 'APPROVED'
       AND email_verified_at IS NOT NULL`,
    [groupId],
  );
  const activeMembers = Number(countRows[0]?.active_members || 0);
  const pending = pendingRow ? {
    ...mapConstitution(pendingRow),
    approvals: Number(pendingRow.approvals || 0),
    rejections: Number(pendingRow.rejections || 0),
    activeMembers,
    votesRequired: activeMembers > 0 ? majorityThreshold(activeMembers) : null,
    userVote: pendingRow.user_vote || null,
  } : null;
  const [historyRows] = await db.query(
    `SELECT * FROM group_constitutions WHERE group_id = ? ORDER BY version_number DESC LIMIT 10`,
    [groupId],
  );
  return {
    current,
    pending,
    activeMembers,
    history: historyRows.map(mapConstitution),
    legacyWarning: current.approvalMethod === "LEGACY_IMPORTED",
  };
}

async function createConstitutionProposal(groupId, actorUserId, submittedTerms, reason, auditMeta = {}) {
  // Ensure groups created after the migration also get an interim rules version.
  await ensureCurrentConstitution(groupId);
  const trimmedReason = String(reason || "").trim();
  if (trimmedReason.length < 10) throw new Error("Explain why the group is proposing these rule changes (at least 10 characters).");
  if (trimmedReason.length > 1000) throw new Error("Proposal reason cannot exceed 1,000 characters.");

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [groupRows] = await connection.query("SELECT id, settings FROM `groups` WHERE id = ? FOR UPDATE", [groupId]);
    if (!groupRows.length) {
      const error = new Error("Group not found.");
      error.statusCode = 404;
      throw error;
    }
    const [currentRows] = await connection.query(
      `SELECT * FROM group_constitutions WHERE group_id = ? AND status = 'CURRENT'
       ORDER BY version_number DESC LIMIT 1 FOR UPDATE`, [groupId],
    );
    if (!currentRows.length) throw new Error("The current constitution has not been initialized. Reload this page and try again.");
    const [pendingRows] = await connection.query(
      "SELECT id FROM group_constitutions WHERE group_id = ? AND status = 'PENDING' LIMIT 1 FOR UPDATE", [groupId],
    );
    if (pendingRows.length) {
      const error = new Error("A constitution proposal is already awaiting member votes. Resolve it before creating another proposal.");
      error.statusCode = 409;
      throw error;
    }

    const currentTerms = parseJson(currentRows[0].constitution_json);
    const terms = normalizeConstitution(submittedTerms, currentTerms);
    const [versionRows] = await connection.query(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM group_constitutions WHERE group_id = ?", [groupId],
    );
    const versionNumber = Number(versionRows[0]?.next_version || 1);
    const [result] = await connection.query(
      `INSERT INTO group_constitutions
        (group_id, version_number, constitution_json, status, approval_method, proposal_reason, created_by, submitted_at)
       VALUES (?, ?, ?, 'PENDING', 'MEMBER_VOTE', ?, ?, CURRENT_TIMESTAMP)`,
      [groupId, versionNumber, JSON.stringify(terms), trimmedReason, actorUserId],
    );
    await writeAuditEvent(connection, {
      groupId, actorUserId, action: "CONSTITUTION_PROPOSED", entityType: "GROUP_CONSTITUTION", entityId: result.insertId,
      beforeData: currentTerms, afterData: { versionNumber, terms, reason: trimmedReason }, ...auditMeta,
    });
    const [createdRows] = await connection.query("SELECT * FROM group_constitutions WHERE id = ?", [result.insertId]);
    await connection.commit();
    return mapConstitution(createdRows[0]);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

function mergeConstitutionIntoGroupSettings(rawSettings, terms) {
  const prior = parseSettings(rawSettings);
  return {
    ...prior,
    shareValue: terms.shareValue,
    minSharesPerMeeting: terms.minSharesPerMeeting,
    maxSharesPerMeeting: terms.maxSharesPerMeeting,
    loanRatioLimit: terms.loanRatioLimit,
    monthlyInterestRate: terms.monthlyInterestRate,
    interestRate: terms.interestRate,
    interestMethod: terms.interestMethod,
    interestPeriodDays: terms.interestPeriodDays,
    maxLoanTermDays: terms.maxLoanTermDays,
    maxLoanDurationMonths: terms.maxLoanDurationMonths,
    gusibuzaEnabled: terms.gusibuzaEnabled,
    gusibuzaFeeMode: terms.gusibuzaFeeMode,
    gusibuzaFeeAmount: terms.gusibuzaFeeAmount,
    socialFundMode: terms.socialFundMode,
    socialFundContributionAmount: terms.socialFundContributionAmount,
    fineRules: terms.fineRules,
    allowOtherFines: terms.allowOtherFines,
    meetingFrequency: terms.meetingFrequency,
    meetingIntervalDays: terms.meetingIntervalDays,
    virtualMeetingWindowDays: terms.virtualMeetingWindowDays,
    paymentWindowTimeZone: "Africa/Kigali",
    cycleDurationMonths: terms.cycleDurationMonths,
    withdrawalPolicy: terms.withdrawalPolicy,
    defaultPolicy: terms.defaultPolicy,
  };
}

async function castConstitutionVote(groupId, proposalId, voterUserId, voteValue, auditMeta = {}) {
  const vote = String(voteValue || "").toUpperCase();
  if (!["APPROVE", "REJECT"].includes(vote)) throw new Error("Vote must be APPROVE or REJECT.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [groupRows] = await connection.query("SELECT id, settings FROM `groups` WHERE id = ? FOR UPDATE", [groupId]);
    if (!groupRows.length) {
      const error = new Error("Group not found.");
      error.statusCode = 404;
      throw error;
    }
    const [voterRows] = await connection.query(
      `SELECT id FROM users WHERE id = ? AND group_id = ?
         AND COALESCE(is_active, 1) = 1
         AND COALESCE(approval_status, 'APPROVED') = 'APPROVED'
         AND email_verified_at IS NOT NULL
       FOR UPDATE`,
      [voterUserId, groupId],
    );
    if (!voterRows.length) {
      const error = new Error("Only active, approved, email-verified members of this company may vote on its constitution.");
      error.statusCode = 403;
      throw error;
    }
    const [proposalRows] = await connection.query(
      "SELECT * FROM group_constitutions WHERE id = ? AND group_id = ? AND status = 'PENDING' FOR UPDATE",
      [proposalId, groupId],
    );
    if (!proposalRows.length) {
      const error = new Error("This constitution proposal is no longer open for voting.");
      error.statusCode = 409;
      throw error;
    }
    const proposal = proposalRows[0];
    const [existingVoteRows] = await connection.query(
      "SELECT id FROM constitution_votes WHERE constitution_id = ? AND voter_user_id = ? LIMIT 1",
      [proposalId, voterUserId],
    );
    if (existingVoteRows.length) {
      const error = new Error("You have already voted on this proposal. Each member may vote once.");
      error.statusCode = 409;
      throw error;
    }

    await connection.query(
      "INSERT INTO constitution_votes (constitution_id, group_id, voter_user_id, vote) VALUES (?, ?, ?, ?)",
      [proposalId, groupId, voterUserId, vote],
    );
    const [voteRows] = await connection.query(
      `SELECT COUNT(*) AS total_votes,
         SUM(CASE WHEN v.vote = 'APPROVE' THEN 1 ELSE 0 END) AS approvals,
         SUM(CASE WHEN v.vote = 'REJECT' THEN 1 ELSE 0 END) AS rejections
       FROM constitution_votes v
       JOIN users voter ON voter.id = v.voter_user_id
       WHERE v.constitution_id = ? AND voter.group_id = ?
         AND COALESCE(voter.is_active, 1) = 1
         AND COALESCE(voter.approval_status, 'APPROVED') = 'APPROVED'
         AND voter.email_verified_at IS NOT NULL`, [proposalId, groupId],
    );
    const counts = voteRows[0];
    const [activeRows] = await connection.query(
      `SELECT COUNT(*) AS active_members FROM users
       WHERE group_id = ? AND COALESCE(is_active, 1) = 1
         AND COALESCE(approval_status, 'APPROVED') = 'APPROVED'
         AND email_verified_at IS NOT NULL`, [groupId],
    );
    const activeMembers = Number(activeRows[0]?.active_members || 0);
    const approvals = Number(counts.approvals || 0);
    const rejections = Number(counts.rejections || 0);
    const totalVotes = Number(counts.total_votes || 0);
    const outcome = evaluateVoteOutcome({ activeMembers, approvals, rejections, totalVotes });

    if (outcome === "CURRENT") {
      const [oldCurrentRows] = await connection.query(
        "SELECT id, constitution_json FROM group_constitutions WHERE group_id = ? AND status = 'CURRENT' FOR UPDATE", [groupId],
      );
      const oldCurrentTerms = oldCurrentRows.length ? parseJson(oldCurrentRows[0].constitution_json) : null;
      await connection.query("UPDATE group_constitutions SET status = 'SUPERSEDED', resolved_at = CURRENT_TIMESTAMP WHERE group_id = ? AND status = 'CURRENT'", [groupId]);
      await connection.query(
        "UPDATE group_constitutions SET status = 'CURRENT', approval_method = 'MEMBER_VOTE', resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
        [proposalId],
      );
      const terms = parseJson(proposal.constitution_json);
      await connection.query("UPDATE `groups` SET settings = ? WHERE id = ?", [JSON.stringify(mergeConstitutionIntoGroupSettings(groupRows[0].settings, terms)), groupId]);
      await writeAuditEvent(connection, {
        groupId, actorUserId: voterUserId, action: "CONSTITUTION_APPROVED", entityType: "GROUP_CONSTITUTION", entityId: proposalId,
        reason: proposal.proposal_reason, beforeData: oldCurrentTerms, afterData: { versionNumber: Number(proposal.version_number), terms, approvals, rejections, activeMembers }, ...auditMeta,
      });
    } else if (outcome === "REJECTED" || outcome === "DEADLOCKED") {
      await connection.query("UPDATE group_constitutions SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [outcome, proposalId]);
      await writeAuditEvent(connection, {
        groupId, actorUserId: voterUserId, action: outcome === "REJECTED" ? "CONSTITUTION_REJECTED" : "CONSTITUTION_DEADLOCKED",
        entityType: "GROUP_CONSTITUTION", entityId: proposalId, reason: proposal.proposal_reason,
        afterData: { approvals, rejections, totalVotes, activeMembers, status: outcome }, ...auditMeta,
      });
    } else {
      await writeAuditEvent(connection, {
        groupId, actorUserId: voterUserId, action: "CONSTITUTION_VOTE_CAST", entityType: "GROUP_CONSTITUTION", entityId: proposalId,
        afterData: { vote, approvals, rejections, totalVotes, activeMembers, status: outcome }, ...auditMeta,
      });
    }

    await connection.commit();
    return {
      proposalId: Number(proposalId), vote, status: outcome, approvals, rejections, totalVotes, activeMembers,
      votesRequired: activeMembers > 0 ? majorityThreshold(activeMembers) : null,
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { ensureCurrentConstitution, getConstitution, createConstitutionProposal, castConstitutionVote };
