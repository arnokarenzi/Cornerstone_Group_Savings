-- CORNESTONE: controlled cycle closure, immutable share-out snapshot and next-cycle startup.
-- Back up cornestone_online_db before running. Apply once. This migration preserves existing cycles.

ALTER TABLE cycles
  MODIFY COLUMN status ENUM('ACTIVE','CLOSING','COMPLETED') NOT NULL DEFAULT 'ACTIVE';

CREATE TABLE IF NOT EXISTS cycle_closures (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  status ENUM('DISTRIBUTING','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DISTRIBUTING',
  distributable_cash DECIMAL(12,2) NOT NULL,
  social_fund_cash_at_start DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  snapshot_json LONGTEXT NOT NULL,
  final_loan_fund_cash DECIMAL(12,2) NULL,
  final_social_fund_cash DECIMAL(12,2) NULL,
  witness_member_id INT NULL,
  next_cycle_id INT NULL,
  created_by INT NULL,
  closed_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cycle_closures_cycle (cycle_id),
  KEY idx_cycle_closures_group_status (group_id, status),
  CONSTRAINT fk_cycle_closures_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_cycle_closures_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_cycle_closures_next_cycle FOREIGN KEY (next_cycle_id) REFERENCES cycles(id) ON DELETE SET NULL,
  CONSTRAINT fk_cycle_closures_witness FOREIGN KEY (witness_member_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_cycle_closures_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_cycle_closures_closer FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_cycle_closures_cash_nonnegative CHECK (distributable_cash >= 0 AND social_fund_cash_at_start >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS cycle_shareout_payouts (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  member_id INT NOT NULL,
  shares_count INT NOT NULL DEFAULT 0,
  savings_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  profit_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  payout_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('PENDING','PAID','NOT_PAYABLE') NOT NULL DEFAULT 'PENDING',
  ledger_entry_id BIGINT NULL,
  receipt_id BIGINT NULL,
  paid_by INT NULL,
  paid_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cycle_shareout_member (cycle_id, member_id),
  KEY idx_cycle_shareout_group_cycle_status (group_id, cycle_id, status),
  CONSTRAINT fk_cycle_shareout_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_cycle_shareout_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_cycle_shareout_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_cycle_shareout_ledger FOREIGN KEY (ledger_entry_id) REFERENCES fund_ledger_entries(id) ON DELETE SET NULL,
  CONSTRAINT fk_cycle_shareout_receipt FOREIGN KEY (receipt_id) REFERENCES financial_receipts(id) ON DELETE SET NULL,
  CONSTRAINT fk_cycle_shareout_payer FOREIGN KEY (paid_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_cycle_shareout_amounts CHECK (shares_count >= 0 AND savings_amount >= 0 AND payout_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
