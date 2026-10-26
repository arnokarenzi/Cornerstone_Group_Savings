-- IMPORTANT: Back up cornestone_online_db before running this migration.
-- Run this migration once against the existing application database.
-- It preserves existing rows and copies their recorded cash movements into the ledger.

ALTER TABLE transactions
  ADD COLUMN loan_id INT NULL,
  ADD COLUMN principal_amount DECIMAL(12,2) NULL,
  ADD COLUMN interest_amount DECIMAL(12,2) NULL,
  ADD KEY idx_transactions_loan_id (loan_id),
  ADD CONSTRAINT fk_transactions_loan_id
    FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE SET NULL;

CREATE TABLE fund_ledger_entries (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  meeting_id INT NULL,
  member_id INT NULL,
  loan_id INT NULL,
  fund_type ENUM('LOAN_FUND','SOCIAL_FUND') NOT NULL,
  entry_type VARCHAR(50) NOT NULL,
  direction ENUM('IN','OUT') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  profit_effect DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(500) NULL,
  source_type VARCHAR(40) NULL,
  source_id BIGINT NULL,
  source_component VARCHAR(40) NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fund_ledger_source_component (source_type, source_id, source_component),
  KEY idx_fund_ledger_group_cycle_fund (group_id, cycle_id, fund_type, id),
  KEY idx_fund_ledger_meeting (meeting_id),
  KEY idx_fund_ledger_member (member_id),
  CONSTRAINT fk_fund_ledger_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_fund_ledger_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_fund_ledger_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_fund_ledger_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_fund_ledger_loan FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE SET NULL,
  CONSTRAINT fk_fund_ledger_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_fund_ledger_positive_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE cash_reconciliations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  meeting_id INT NULL,
  fund_type ENUM('LOAN_FUND','SOCIAL_FUND') NOT NULL,
  book_balance_at_count DECIMAL(12,2) NOT NULL,
  counted_cash DECIMAL(12,2) NOT NULL,
  variance DECIMAL(12,2) NOT NULL,
  ledger_entry_id_at_count BIGINT NULL,
  notes VARCHAR(500) NULL,
  reconciled_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cash_reconciliation_group_cycle_fund (group_id, cycle_id, fund_type, id),
  CONSTRAINT fk_cash_reconciliation_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_reconciliation_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_reconciliation_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_cash_reconciliation_user FOREIGN KEY (reconciled_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Backfill cash inflows and fines/social-fund contributions from existing transactions.
-- Historical repayments are included as cash received, but not classified as profit because
-- the old schema did not store a loan ID or split principal from interest.
INSERT IGNORE INTO fund_ledger_entries
  (group_id, cycle_id, meeting_id, member_id, fund_type, entry_type, direction,
   amount, profit_effect, notes, source_type, source_id, source_component, created_at)
SELECT
  t.group_id,
  t.cycle_id,
  t.meeting_id,
  t.member_id,
  CASE WHEN t.type = 'SOCIAL_FUND' THEN 'SOCIAL_FUND' ELSE 'LOAN_FUND' END,
  CASE
    WHEN t.type = 'SHARE_PURCHASE' THEN 'SHARE_PURCHASE'
    WHEN t.type = 'FINE_PAYMENT' THEN 'FINE_PAYMENT'
    WHEN t.type = 'SOCIAL_FUND' THEN 'SOCIAL_FUND_CONTRIBUTION'
    WHEN t.type = 'LOAN_REPAYMENT' THEN 'LEGACY_REPAYMENT'
  END,
  'IN',
  t.amount,
  CASE WHEN t.type = 'FINE_PAYMENT' THEN t.amount ELSE 0 END,
  CASE WHEN t.type = 'LOAN_REPAYMENT'
       THEN 'Legacy repayment. Cash is included, but historic principal/interest split is unavailable.'
       ELSE NULL END,
  'TRANSACTION', t.id, 'LEGACY', t.created_at
FROM transactions t
WHERE t.amount > 0
  AND t.type IN ('SHARE_PURCHASE','FINE_PAYMENT','SOCIAL_FUND','LOAN_REPAYMENT');

-- The previous issue-loan service wrote loans to the loans table but did not consistently
-- write disbursement transactions. Backfill each loan exactly once by using the loan ID as source.
INSERT IGNORE INTO fund_ledger_entries
  (group_id, cycle_id, member_id, loan_id, fund_type, entry_type, direction,
   amount, profit_effect, notes, source_type, source_id, source_component, created_at)
SELECT
  l.group_id, l.cycle_id, l.member_id, l.id, 'LOAN_FUND', 'LOAN_DISBURSEMENT', 'OUT',
  l.principal_amount, 0, 'Backfilled loan disbursement from the loans table.',
  'LOAN', l.id, 'DISBURSEMENT', l.disbursed_at
FROM loans l
WHERE l.principal_amount > 0;

-- No historic cash counts can be invented. Leadership must count the physical cash and
-- record fresh reconciliations before the application marks a share-out as ready.
