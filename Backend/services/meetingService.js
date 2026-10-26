const db = require("../config/db");
const { insertLedgerEntry } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { validateMeetingContributions, resolveFineAssessment, parseSettings } = require("./constitutionRules");
const { getVirtualPaymentWindowStatus, DEFAULT_TIME_ZONE } = require("./virtualPaymentWindow");

async function synchronizeVirtualPaymentWindow(groupId, cycleId, actorUserId = null, auditMeta = {}) {
  const gid = Number(groupId);
  const cid = Number(cycleId);
  if (![gid, cid].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Group ID and cycle ID must be valid positive integers.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [cycleRows] = await connection.query(
      `SELECT id, start_date, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE`, [cid, gid],
    );
    if (!cycleRows.length) throw new Error("The selected cycle does not belong to this company.");
    if (cycleRows[0].status !== "ACTIVE") throw new Error("The virtual savings window is available only for the active cycle.");
    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [gid]);
    if (!groupRows.length) throw new Error("CORNESTONE company record was not found.");
    const settings = parseSettings(groupRows[0].settings);
    const intervalDays = Number(settings.meetingIntervalDays ?? 14);
    const windowDays = Number(settings.virtualMeetingWindowDays ?? 3);
    const timeZone = String(settings.paymentWindowTimeZone || DEFAULT_TIME_ZONE);
    const windowStatus = getVirtualPaymentWindowStatus({
      cycleStartDate: cycleRows[0].start_date,
      intervalDays,
      windowDays,
      timeZone,
    });

    if (!windowStatus.isOpen || !windowStatus.windowNumber) {
      await connection.query(
        `UPDATE meetings SET status = 'CLOSED', closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
         WHERE group_id = ? AND cycle_id = ? AND status = 'OPEN'`, [gid, cid],
      );
      await connection.commit();
      return { meetings: [], nextMeetingNumber: windowStatus.windowNumber ? windowStatus.windowNumber + 1 : 1, virtualWindow: windowStatus };
    }

    await connection.query(
      `UPDATE meetings SET status = 'CLOSED', closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
       WHERE group_id = ? AND cycle_id = ? AND status = 'OPEN' AND meeting_number <> ?`,
      [gid, cid, windowStatus.windowNumber],
    );
    let [meetingRows] = await connection.query(
      `SELECT id, group_id, cycle_id, meeting_number, date, status FROM meetings
       WHERE group_id = ? AND cycle_id = ? AND meeting_number = ? LIMIT 1 FOR UPDATE`,
      [gid, cid, windowStatus.windowNumber],
    );
    if (!meetingRows.length) {
      const [inserted] = await connection.query(
        `INSERT INTO meetings (group_id, cycle_id, meeting_number, date, status)
         VALUES (?, ?, ?, ?, 'OPEN')`, [gid, cid, windowStatus.windowNumber, windowStatus.windowStartDate],
      );
      meetingRows = [{ id: inserted.insertId, group_id: gid, cycle_id: cid, meeting_number: windowStatus.windowNumber, date: windowStatus.windowStartDate, status: "OPEN" }];
      await writeAuditEvent(connection, {
        groupId: gid, cycleId: cid, meetingId: inserted.insertId, actorUserId,
        action: "VIRTUAL_SAVINGS_WINDOW_OPENED", entityType: "VIRTUAL_PAYMENT_WINDOW", entityId: inserted.insertId,
        afterData: { ...windowStatus, meetingNumber: windowStatus.windowNumber }, ...auditMeta,
      });
    } else if (meetingRows[0].status !== "OPEN") {
      await connection.query(
        `UPDATE meetings SET status = 'OPEN', date = ?, closed_at = NULL WHERE id = ? AND group_id = ? AND cycle_id = ?`,
        [windowStatus.windowStartDate, meetingRows[0].id, gid, cid],
      );
      meetingRows[0].status = "OPEN";
    }
    await connection.commit();
    const meetings = [{ ...meetingRows[0], meeting_number: windowStatus.windowNumber, status: "OPEN" }];
    return { meetings, nextMeetingNumber: windowStatus.windowNumber + 1, virtualWindow: windowStatus };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function openMeeting(groupId, cycleId, meetingNumber, date, createdBy, auditMeta = {}) {
  const window = await synchronizeVirtualPaymentWindow(groupId, cycleId, createdBy, auditMeta);
  if (!window.virtualWindow?.isOpen || !window.meetings.length) {
    throw new Error(`Savings contributions are closed. The next virtual window opens on ${window.virtualWindow?.nextOpenDate || "the next scheduled date"}.`);
  }
  if (Number(meetingNumber) !== Number(window.virtualWindow.windowNumber)) {
    throw new Error(`Virtual windows are scheduled automatically. The current window is #${window.virtualWindow.windowNumber}; arbitrary meeting numbers and dates are not allowed.`);
  }
  return { ...window.meetings[0], id: Number(window.meetings[0].id), meetingId: Number(window.meetings[0].id), groupId: Number(groupId), cycleId: Number(cycleId), meetingNumber: Number(window.virtualWindow.windowNumber), status: "OPEN" };
}

async function closeMeeting(groupId, cycleId, meetingId, createdBy, auditMeta = {}) {
  // Virtual payment windows close automatically after their configured calendar
  // duration. A user cannot manually close or extend a window early.
  throw new Error("Virtual savings windows close automatically after the configured three-day period. Manual meeting closure is disabled.");
}


/** Record online share purchases and approved fines atomically in both records and cashbook. */
async function recordMeetingTransactions(groupId, cycleId, meetingId, memberId, transactionsData, createdBy, auditMeta = {}, fineAssessment = null) {
  const parsedGroupId = Number(groupId);
  const parsedCycleId = Number(cycleId);
  const parsedMeetingId = Number(meetingId);
  const parsedMemberId = Number(memberId);
  const parsedCreatedBy = Number(createdBy);
  if (![parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId, parsedCreatedBy].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Group, cycle, virtual-window, member, and recorder IDs must be valid positive integers.");
  }
  if (!Array.isArray(transactionsData) || transactionsData.length < 1) throw new Error("At least one share purchase must be supplied.");
  if (fineAssessment) throw new Error("Fine assessments are not recorded as savings contributions; use the fine workflow.");
  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [cycleRows] = await connection.query(
      `SELECT id, start_date, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE`, [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length || cycleRows[0].status !== "ACTIVE") throw new Error("The selected financial cycle is not active for this company.");
    const [meetingRows] = await connection.query(
      `SELECT id, meeting_number, status FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? FOR UPDATE`,
      [parsedMeetingId, parsedGroupId, parsedCycleId],
    );
    if (!meetingRows.length || meetingRows[0].status !== "OPEN") throw new Error("The scheduled virtual savings window is not open.");
    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [parsedGroupId]);
    if (!groupRows.length) throw new Error("CORNESTONE company record was not found.");
    const settings = parseSettings(groupRows[0].settings);
    const virtualWindow = getVirtualPaymentWindowStatus({
      cycleStartDate: cycleRows[0].start_date,
      intervalDays: Number(settings.meetingIntervalDays ?? 14),
      windowDays: Number(settings.virtualMeetingWindowDays ?? 3),
      timeZone: String(settings.paymentWindowTimeZone || DEFAULT_TIME_ZONE),
    });
    if (!virtualWindow.isOpen || Number(meetingRows[0].meeting_number) !== Number(virtualWindow.windowNumber)) {
      throw new Error(`Savings contributions can be posted only during the scheduled virtual window. Current status: ${virtualWindow.isOpen ? "open window mismatch" : `closed; next window opens ${virtualWindow.nextOpenDate}`}.`);
    }
    const [memberRows] = await connection.query(
      "SELECT id FROM users WHERE id = ? AND group_id = ? AND is_active = 1", [parsedMemberId, parsedGroupId],
    );
    if (!memberRows.length) throw new Error("The selected member is not active in CORNESTONE Co.LTD.");

    const sharePurchases = transactionsData.filter((tx) => String(tx?.type || "").toUpperCase() === "SHARE_PURCHASE");
    if (sharePurchases.length !== transactionsData.length || transactionsData.some((tx) => String(tx?.type || "").toUpperCase() === "SOCIAL_FUND")) {
      throw new Error("CORNESTONE does not collect Social Fund contributions. This workflow accepts share purchases only.");
    }
    const shareValue = Number(settings.shareValue ?? 1000);
    if (!Number.isFinite(shareValue) || shareValue <= 0) throw new Error("The company share price setting is invalid.");
    const [priorRows] = await connection.query(
      `SELECT COALESCE(SUM(shares_count), 0) AS shares_count FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND COALESCE(credited_meeting_id, meeting_id) = ?
         AND member_id = ? AND type = 'SHARE_PURCHASE' AND status = 'POSTED' FOR UPDATE`,
      [parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId],
    );
    const previousShares = Number(priorRows[0]?.shares_count || 0);
    validateMeetingContributions({ terms: settings, existingSharesThisMeeting: previousShares, sharePurchases, socialFundTransactions: [], attendanceStatus: null });

    const recordedTransactions = [];
    for (const tx of sharePurchases) {
      const sharesCount = Number(tx.sharesCount);
      const amount = Number(tx.amount);
      if (!Number.isSafeInteger(sharesCount) || sharesCount <= 0) throw new Error("Shares purchased must be a positive whole number.");
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Share purchase amount must be greater than zero.");
      const expectedAmount = Math.round((sharesCount * shareValue + Number.EPSILON) * 100) / 100;
      const safeAmount = Math.round((amount + Number.EPSILON) * 100) / 100;
      if (Math.abs(safeAmount - expectedAmount) > 0.009) throw new Error(`Share purchase amount must equal ${sharesCount} × ${shareValue.toLocaleString()} RWF = ${expectedAmount.toLocaleString()} RWF.`);
      const [inserted] = await connection.query(
        `INSERT INTO transactions (group_id, cycle_id, meeting_id, member_id, type, amount, shares_count, share_value_at_transaction)
         VALUES (?, ?, ?, ?, 'SHARE_PURCHASE', ?, ?, ?)`,
        [parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId, safeAmount, sharesCount, shareValue],
      );
      const ledgerEntryId = await insertLedgerEntry(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId, memberId: parsedMemberId,
        fundType: "LOAN_FUND", entryType: "SHARE_PURCHASE", direction: "IN", amount: safeAmount,
        profitEffect: 0, notes: `${sharesCount} share(s) purchased during virtual savings window #${virtualWindow.windowNumber}.`,
        sourceType: "TRANSACTION", sourceId: inserted.insertId, sourceComponent: "TOTAL", createdBy: parsedCreatedBy,
      });
      const receipt = await createReceipt(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId, memberId: parsedMemberId,
        sourceType: "TRANSACTION", sourceId: inserted.insertId, sourceComponent: "TOTAL", activityType: "SHARE_PURCHASE",
        amount: safeAmount, summary: `${sharesCount} share(s) purchased`,
        details: { transactionId: inserted.insertId, ledgerEntryId, sharesCount, shareValue, virtualWindowNumber: virtualWindow.windowNumber },
        issuedBy: parsedCreatedBy,
      });
      await writeAuditEvent(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId, actorUserId: parsedCreatedBy,
        action: "SHARE_PURCHASE_RECORDED", entityType: "TRANSACTION", entityId: inserted.insertId,
        afterData: { memberId: parsedMemberId, sharesCount, amount: safeAmount, shareValue, virtualWindowNumber: virtualWindow.windowNumber, receiptNumber: receipt.receiptNumber }, ...auditMeta,
      });
      recordedTransactions.push({ transactionId: inserted.insertId, ledgerEntryId, type: "SHARE_PURCHASE", amount: safeAmount, sharesCount, receipt });
    }
    await connection.commit();
    return { transactions: recordedTransactions, virtualWindow };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    throw new Error(`Transaction failed: ${error.message}`);
  } finally { connection.release(); }
}

module.exports = { openMeeting, synchronizeVirtualPaymentWindow, closeMeeting, recordMeetingTransactions };
