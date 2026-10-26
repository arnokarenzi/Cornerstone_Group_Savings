-- CORNESTONE rule-enforcement update: assessed fines and named cash-count witnesses.
-- BACK UP cornestone_online_db first. Run ONCE after v5 (fund ledger), Priority 2 (receipts/audit), and Priority 3 (constitution).
-- Existing cash reconciliation records remain valid with witness_member_id = NULL (historical witness not recorded).

ALTER TABLE cash_reconciliations
  ADD COLUMN witness_member_id INT NULL AFTER reconciled_by,
  ADD KEY idx_cash_reconciliations_witness (witness_member_id),
  ADD CONSTRAINT fk_cash_reconciliations_witness_member
    FOREIGN KEY (witness_member_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE fine_assessments (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  meeting_id INT NOT NULL,
  member_id INT NOT NULL,
  fine_label VARCHAR(100) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('OUTSTANDING','PARTIALLY_PAID','PAID','REVERSED') NOT NULL DEFAULT 'OUTSTANDING',
  assessed_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fine_assessments_member_balance (group_id, cycle_id, member_id, status),
  KEY idx_fine_assessments_meeting (meeting_id),
  CONSTRAINT fk_fine_assessments_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_fine_assessments_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_fine_assessments_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_fine_assessments_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_fine_assessments_assessed_by FOREIGN KEY (assessed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_fine_assessments_amount CHECK (amount > 0),
  CONSTRAINT chk_fine_assessments_paid CHECK (amount_paid >= 0 AND amount_paid <= amount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE transactions
  ADD COLUMN fine_assessment_id BIGINT NULL AFTER loan_id,
  ADD KEY idx_transactions_fine_assessment (fine_assessment_id),
  ADD CONSTRAINT fk_transactions_fine_assessment
    FOREIGN KEY (fine_assessment_id) REFERENCES fine_assessments(id) ON DELETE SET NULL;
