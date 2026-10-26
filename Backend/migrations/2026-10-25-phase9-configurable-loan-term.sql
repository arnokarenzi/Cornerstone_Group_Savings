-- Phase 9: relax only the storage-level ceiling for requested loan terms.
-- The application/service validates each loan application against the current
-- member-approved Constitution & Rules maxLoanTermDays at creation, review and
-- disbursement. This constraint is a hard safety ceiling, not the company rule.
ALTER TABLE loan_applications
  DROP CONSTRAINT chk_loan_app_term;

ALTER TABLE loan_applications
  ADD CONSTRAINT chk_loan_app_term CHECK (requested_term_days > 0 AND requested_term_days <= 3660);
