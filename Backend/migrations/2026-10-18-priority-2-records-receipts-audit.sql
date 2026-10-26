-- CORNESTONE Phase 1: meeting records, attendance, receipts and audit trail.
-- BACK UP cornestone_online_db before running this migration. Run ONCE after the v5 financial-ledger migration.
-- Existing financial records are preserved. Historical receipts are NOT invented retroactively.

ALTER TABLE transactions
  ADD COLUMN status ENUM('POSTED','REVERSED') NOT NULL DEFAULT 'POSTED',
  ADD COLUMN reversed_by INT NULL,
  ADD COLUMN reversed_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN reversal_reason VARCHAR(1000) NULL,
  ADD KEY idx_transactions_status_group_cycle (group_id, cycle_id, status),
  ADD CONSTRAINT fk_transactions_reversed_by FOREIGN KEY (reversed_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE fund_ledger_entries
  ADD COLUMN reversal_of_entry_id BIGINT NULL,
  ADD UNIQUE KEY uq_fund_ledger_reversal_of_entry (reversal_of_entry_id),
  ADD CONSTRAINT fk_fund_ledger_reversal_of_entry FOREIGN KEY (reversal_of_entry_id) REFERENCES fund_ledger_entries(id) ON DELETE SET NULL;

CREATE TABLE meeting_records (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  meeting_id INT NOT NULL,
  agenda LONGTEXT NULL,
  minutes LONGTEXT NULL,
  decisions LONGTEXT NULL,
  action_items LONGTEXT NULL,
  recorded_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_records_meeting (meeting_id),
  KEY idx_meeting_records_group_cycle (group_id, cycle_id),
  CONSTRAINT fk_meeting_records_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_records_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_records_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_records_recorded_by FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_meeting_records_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE meeting_attendance (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  meeting_id INT NOT NULL,
  member_id INT NOT NULL,
  attendance_status ENUM('PRESENT','ABSENT','EXCUSED','NOT_RECORDED') NOT NULL DEFAULT 'NOT_RECORDED',
  notes VARCHAR(500) NULL,
  recorded_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_attendance_meeting_member (meeting_id, member_id),
  KEY idx_meeting_attendance_group_cycle (group_id, cycle_id),
  CONSTRAINT fk_meeting_attendance_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_attendance_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_attendance_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_attendance_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_attendance_recorded_by FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_meeting_attendance_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE financial_receipts (
  id BIGINT NOT NULL AUTO_INCREMENT,
  receipt_number VARCHAR(80) NOT NULL,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  meeting_id INT NULL,
  member_id INT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(80) NOT NULL,
  source_component VARCHAR(32) NOT NULL DEFAULT 'TOTAL',
  activity_type VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'RWF',
  summary VARCHAR(255) NOT NULL,
  details_json LONGTEXT NOT NULL,
  issued_by INT NULL,
  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipt_number (receipt_number),
  UNIQUE KEY uq_receipt_source (source_type, source_id, source_component),
  KEY idx_receipts_group_cycle (group_id, cycle_id, id),
  KEY idx_receipts_member (member_id, id),
  CONSTRAINT fk_receipts_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_receipts_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_receipts_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_receipts_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_receipts_issuer FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_receipts_nonnegative CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NULL,
  meeting_id INT NULL,
  actor_user_id INT NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id VARCHAR(80) NULL,
  reason VARCHAR(1000) NULL,
  before_json LONGTEXT NULL,
  after_json LONGTEXT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_group_created (group_id, created_at),
  KEY idx_audit_cycle_created (group_id, cycle_id, created_at),
  KEY idx_audit_meeting_created (meeting_id, created_at),
  CONSTRAINT fk_audit_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_audit_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
