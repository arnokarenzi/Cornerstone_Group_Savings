-- CORNESTONE constitution versioning: versioned, member-approved group constitution/rules.
-- BACK UP cornestone_online_db first. Run ONCE after the v5 ledger and v7 Priority 2 migrations.
-- This migration creates proposal/history tables only. Existing group settings are
-- imported lazily as a CURRENT, LEGACY_IMPORTED version when the Constitution page is first opened.
-- No existing loans or transactions are changed. A new proposal takes effect only after member vote approval.

CREATE TABLE group_constitutions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  version_number INT NOT NULL,
  constitution_json LONGTEXT NOT NULL CHECK (JSON_VALID(constitution_json)),
  status ENUM('CURRENT','PENDING','SUPERSEDED','REJECTED','DEADLOCKED') NOT NULL,
  approval_method ENUM('LEGACY_IMPORTED','MEMBER_VOTE') NOT NULL DEFAULT 'MEMBER_VOTE',
  proposal_reason VARCHAR(1000) NULL,
  created_by INT NULL,
  submitted_at TIMESTAMP NULL DEFAULT NULL,
  resolved_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_constitution_group_version (group_id, version_number),
  KEY idx_constitution_group_status (group_id, status),
  CONSTRAINT fk_constitution_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_constitution_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE constitution_votes (
  id BIGINT NOT NULL AUTO_INCREMENT,
  constitution_id BIGINT NOT NULL,
  group_id INT NOT NULL,
  voter_user_id INT NOT NULL,
  vote ENUM('APPROVE','REJECT') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_constitution_vote_member (constitution_id, voter_user_id),
  KEY idx_constitution_votes_group (group_id, constitution_id),
  CONSTRAINT fk_constitution_vote_version FOREIGN KEY (constitution_id) REFERENCES group_constitutions(id) ON DELETE CASCADE,
  CONSTRAINT fk_constitution_vote_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_constitution_voter FOREIGN KEY (voter_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
