const db = require('../config/db');

/**
 * Fetch group settings from the JSON column
 */
async function getGroupSettings(groupId) {
  const [rows] = await db.query('SELECT settings FROM `groups` WHERE id = ?', [groupId]);
  if (rows.length === 0) {
    throw new Error('Group not found');
  }
  // mysql2 automatically parses JSON columns into JavaScript objects
  return rows[0].settings;
}

/**
 * Update custom manual rules for a specific association
 */
async function updateGroupSettings(groupId, newSettings) {
  const currentSettings = await getGroupSettings(groupId);
  const mergedSettings = { ...currentSettings, ...newSettings };

  await db.query(
    'UPDATE `groups` SET settings = ? WHERE id = ?',
    [JSON.stringify(mergedSettings), groupId]
  );

  return mergedSettings;
}

module.exports = { getGroupSettings, updateGroupSettings };
