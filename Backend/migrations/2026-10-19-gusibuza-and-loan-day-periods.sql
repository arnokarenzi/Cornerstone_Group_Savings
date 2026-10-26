-- CORNESTONE: late share purchases (gusibuza) and explicit loan interest periods in days.
-- Back up the database first. Run ONCE, after migrations through 2026-10-19-fine-assessments-and-cash-witness.sql.
-- Existing loan rows keep NULL interest_method and retain their legacy repayment behaviour.

ALTER TABLE transactions
  ADD COLUMN credited_meeting_id INT NULL AFTER meeting_id,
  ADD KEY idx_transactions_credited_meeting (credited_meeting_id),
  ADD CONSTRAINT fk_transactions_credited_meeting
    FOREIGN KEY (credited_meeting_id) REFERENCES meetings(id) ON DELETE SET NULL;

ALTER TABLE transactions
  MODIFY COLUMN type ENUM('SHARE_PURCHASE','LOAN_DISBURSEMENT','LOAN_REPAYMENT','FINE_PAYMENT','SOCIAL_FUND','GUSIBUZA_FEE') NOT NULL;

ALTER TABLE loans
  ADD COLUMN interest_method VARCHAR(30) NULL AFTER interest_rate,
  ADD COLUMN interest_period_days INT NULL AFTER interest_method,
  ADD COLUMN interest_periods_charged INT NOT NULL DEFAULT 0 AFTER interest_period_days;
