-- CORNESTONE online-only financial model.
-- This migration deliberately narrows the active schema to the financial types
-- supported by the new company app. Phase 2's configure script checks that no
-- Social Fund or Gusibuza records exist before applying these enum changes.
ALTER TABLE transactions
  MODIFY COLUMN type ENUM('SHARE_PURCHASE','LOAN_DISBURSEMENT','LOAN_REPAYMENT','FINE_PAYMENT') NOT NULL;

ALTER TABLE fund_ledger_entries
  MODIFY COLUMN fund_type ENUM('LOAN_FUND') NOT NULL;

ALTER TABLE cash_reconciliations
  MODIFY COLUMN fund_type ENUM('LOAN_FUND') NOT NULL;
