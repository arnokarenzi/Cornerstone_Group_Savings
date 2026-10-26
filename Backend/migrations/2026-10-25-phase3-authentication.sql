-- Phase 3 authentication migration note.
-- The fresh-install schema already contains `users.token_version` and
-- `email_verification_tokens`; existing Phase 2 databases must apply the
-- idempotent `npm run configure:phase3` script instead of running ALTER TABLE
-- statements directly. This update is safe during fresh install and helps
-- preserve access for previously trusted/approved administrator accounts.
UPDATE users SET email_verified_at = CURRENT_TIMESTAMP
WHERE approval_status = 'APPROVED' AND email_verified_at IS NULL;
