-- CORNESTONE Phase 6: controlled share redemption, loan restructuring and idempotent writes.
-- Existing financial rows are preserved. Back up cornestone_online_db before applying.

ALTER TABLE transactions
  MODIFY COLUMN type ENUM('SHARE_PURCHASE','SHARE_REDEMPTION','LOAN_DISBURSEMENT','LOAN_REPAYMENT','FINE_PAYMENT') NOT NULL;

ALTER TABLE transactions
  ADD COLUMN share_value_at_transaction DECIMAL(12,2) NULL AFTER shares_count;

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  member_id INT NOT NULL,
  requested_amount DECIMAL(12,2) NOT NULL,
  share_value_at_request DECIMAL(12,2) NOT NULL,
  shares_to_redeem INT NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  status ENUM('REQUESTED','APPROVED','REJECTED','PAID','CANCELLED') NOT NULL DEFAULT 'REQUESTED',
  requested_by INT NOT NULL,
  reviewed_by INT NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  decision_notes VARCHAR(1000) NULL,
  paid_by INT NULL,
  paid_at TIMESTAMP NULL DEFAULT NULL,
  transaction_id BIGINT NULL,
  ledger_entry_id BIGINT NULL,
  receipt_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_withdrawal_group_cycle_status (group_id, cycle_id, status, id),
  KEY idx_withdrawal_member_cycle (member_id, cycle_id, status),
  CONSTRAINT fk_withdrawal_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_withdrawal_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_withdrawal_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_withdrawal_requester FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_withdrawal_payer FOREIGN KEY (paid_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_withdrawal_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL,
  CONSTRAINT fk_withdrawal_ledger FOREIGN KEY (ledger_entry_id) REFERENCES fund_ledger_entries(id) ON DELETE SET NULL,
  CONSTRAINT fk_withdrawal_receipt FOREIGN KEY (receipt_id) REFERENCES financial_receipts(id) ON DELETE SET NULL,
  CONSTRAINT chk_withdrawal_amount_positive CHECK (requested_amount > 0 AND shares_to_redeem > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS loan_restructuring_requests (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  loan_id INT NOT NULL,
  member_id INT NOT NULL,
  original_due_date DATE NOT NULL,
  requested_due_date DATE NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  status ENUM('REQUESTED','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'REQUESTED',
  requested_by INT NOT NULL,
  reviewed_by INT NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  decision_notes VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_restructure_group_cycle_status (group_id, cycle_id, status, id),
  KEY idx_restructure_loan_status (loan_id, status, id),
  CONSTRAINT fk_restructure_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_restructure_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_restructure_loan FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  CONSTRAINT fk_restructure_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_restructure_requester FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_restructure_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_restructure_due_dates CHECK (requested_due_date > original_due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS financial_idempotency_keys (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  user_id INT NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status ENUM('PROCESSING','COMPLETED') NOT NULL DEFAULT 'PROCESSING',
  response_status SMALLINT NULL,
  response_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_financial_idempotency_group_key (group_id, idempotency_key),
  KEY idx_financial_idempotency_created (created_at),
  CONSTRAINT fk_idempotency_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_idempotency_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
