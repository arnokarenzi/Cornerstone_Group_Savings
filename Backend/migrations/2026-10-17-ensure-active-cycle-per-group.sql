-- Run once against cornestone_online_db for groups created before the app began
-- automatically creating an initial cycle. This does not duplicate active cycles.
-- A group that has prior completed cycles receives the next cycle_number.

INSERT INTO cycles (group_id, cycle_number, start_date, status)
SELECT
  g.id,
  COALESCE(
    (SELECT MAX(c2.cycle_number) + 1 FROM cycles c2 WHERE c2.group_id = g.id),
    1
  ),
  CURDATE(),
  'ACTIVE'
FROM `groups` g
WHERE NOT EXISTS (
  SELECT 1
  FROM cycles c_active
  WHERE c_active.group_id = g.id
    AND c_active.status = 'ACTIVE'
);

-- Verify that each group now has an active cycle:
-- SELECT g.id, g.name, c.id AS cycle_id, c.cycle_number, c.status
-- FROM `groups` g
-- LEFT JOIN cycles c ON c.group_id = g.id AND c.status = 'ACTIVE'
-- ORDER BY g.id, c.cycle_number;
