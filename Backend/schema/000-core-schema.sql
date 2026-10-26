-- CORNESTONE Co.LTD. clean-install core schema.
-- Apply this to the NEW, empty cornestone_online_db database before running the numbered migrations.
-- This schema intentionally does not import or reference the old Itsinda database.

CREATE TABLE `groups` (
  id INT NOT NULL AUTO_INCREMENT,
  company_key VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  registration_code VARCHAR(80) NOT NULL,
  settings LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_groups_company_key (company_key),
  UNIQUE KEY uq_groups_registration_code (registration_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(254) NULL,
  phone_number VARCHAR(50) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('MEMBER','TREASURER','SECRETARY','CHAIRPERSON','ADMIN') NOT NULL DEFAULT 'MEMBER',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  approval_status ENUM('PENDING','APPROVED','REJECTED','SUSPENDED') NOT NULL DEFAULT 'PENDING',
  email_verified_at TIMESTAMP NULL DEFAULT NULL,
  token_version INT UNSIGNED NOT NULL DEFAULT 0,
  last_login_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_phone_number (phone_number),
  KEY idx_users_group_role (group_id, role),
  KEY idx_users_group_approval (group_id, approval_status),
  CONSTRAINT fk_users_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE cycles (
  id INT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_number INT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NULL,
  status ENUM('ACTIVE','COMPLETED') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cycles_group_number (group_id, cycle_number),
  KEY idx_cycles_group_status (group_id, status),
  CONSTRAINT fk_cycles_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE meetings (
  id INT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  meeting_number INT NOT NULL,
  date DATE NOT NULL,
  status ENUM('OPEN','CLOSED','CANCELLED') NOT NULL DEFAULT 'OPEN',
  closed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_meetings_cycle_number (cycle_id, meeting_number),
  KEY idx_meetings_group_cycle_status (group_id, cycle_id, status),
  CONSTRAINT fk_meetings_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_meetings_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE transactions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  meeting_id INT NULL,
  member_id INT NOT NULL,
  type ENUM('SHARE_PURCHASE','LOAN_DISBURSEMENT','LOAN_REPAYMENT','FINE_PAYMENT','SOCIAL_FUND') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  shares_count INT NOT NULL DEFAULT 0,
  fine_reason VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_transactions_group_cycle (group_id, cycle_id, id),
  KEY idx_transactions_member_cycle (group_id, cycle_id, member_id, id),
  KEY idx_transactions_meeting (meeting_id),
  CONSTRAINT fk_transactions_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_transactions_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_transactions_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_transactions_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_transactions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_transactions_amount_nonnegative CHECK (amount >= 0),
  CONSTRAINT chk_transactions_shares_nonnegative CHECK (shares_count >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE loans (
  id INT NOT NULL AUTO_INCREMENT,
  group_id INT NOT NULL,
  cycle_id INT NOT NULL,
  member_id INT NOT NULL,
  principal_amount DECIMAL(12,2) NOT NULL,
  interest_rate DECIMAL(7,5) NOT NULL DEFAULT 0.10000,
  total_interest_due DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_amount_due DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  balance_remaining DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  due_date DATE NULL,
  status ENUM('ACTIVE','REPAID','DEFAULTED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  disbursed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_loans_group_cycle_member (group_id, cycle_id, member_id),
  KEY idx_loans_status_due (group_id, cycle_id, status, due_date),
  CONSTRAINT fk_loans_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_loans_cycle FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
  CONSTRAINT fk_loans_member FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_loans_amounts_nonnegative CHECK (principal_amount > 0 AND total_interest_due >= 0 AND total_amount_due >= 0 AND balance_remaining >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE password_reset_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_reset_token_hash (token_hash),
  KEY idx_password_reset_user_expiry (user_id, expires_at),
  CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE email_verification_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_verification_token_hash (token_hash),
  KEY idx_email_verification_user_expiry (user_id, expires_at),
  CONSTRAINT fk_email_verification_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE auth_audit_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NULL,
  email VARCHAR(254) NULL,
  event_type VARCHAR(60) NOT NULL,
  success TINYINT(1) NOT NULL DEFAULT 0,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  details_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_auth_audit_email_created (email, created_at),
  KEY idx_auth_audit_user_created (user_id, created_at),
  CONSTRAINT fk_auth_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
