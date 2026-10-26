# CORNESTONE Co.LTD. — Online Savings Platform

This is an independent copy of the former Itsinda application. It is configured for one company only and defaults to its own database, `cornestone_online_db`. It does not import data from the old application's database.

## Phase 1 scope

- Company branding and single-company setup.
- Public company/group creation disabled.
- Email-and-password sign-in with 8-hour JWT expiry and rate-limited login attempts.
- Suspended and unapproved accounts are blocked by the API.
- An auditable one-time command provisions the first approved ADMIN without a hard-coded password.
- New clean-install core schema plus the bundled application migrations.
- Six main navigation sections; cashbook, receipts, meeting records and audit tools are grouped inside Leadership Terminal.
- No Mobile Money, Airtel Money, bank-transfer API, or other online payment provider is integrated.

Member self-registration, email verification, committee approval/rejection screens, password-reset emails, online payment-window enforcement, and the final no-Social-Fund financial-rule changes remain subsequent phases. Do not use this Phase 1 copy to record real company financial activity until the financial-rule and workflow phases have been completed and tested.

## 1. Create a separate database

Create a new, empty MySQL database. Do not configure this app to point at the old Itsinda database.

For a local MySQL installation, an administrator can run commands similar to the following, changing the password to a unique one and using the correct host for your deployment:

```sql
CREATE DATABASE cornestone_online_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER 'cornestone_app'@'localhost' IDENTIFIED BY 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
GRANT ALL PRIVILEGES ON cornestone_online_db.* TO 'cornestone_app'@'localhost';
FLUSH PRIVILEGES;
```

The database user shown above must be able to create and alter tables during installation. For production, consider using a separate migration account for schema changes and a more restricted runtime account once installation is complete.

## 2. Configure the backend

```bash
cd Backend
cp .env.example .env
```

Edit `Backend/.env` and set the database host, port, user, password, database name, and a unique random `JWT_SECRET` of at least 32 characters. Keep `.env` private and out of version control. The default database name must remain `cornestone_online_db` unless you deliberately set `ALLOW_CUSTOM_DB_NAME=1` after confirming that the replacement database is new and separate from the old application.

Install the backend dependencies and install the core schema and bundled migrations into the empty database:

```bash
npm ci
npm run db:fresh-install
```

The fresh-install command refuses to run against a non-empty database and refuses database names containing `itsinda`. Migration files are one-time SQL migrations; if a fresh installation fails part-way through, inspect the reported SQL error and recreate the empty CORNESTONE database before retrying. Do not rerun the migration sequence blindly against a partially migrated schema.

## 3. Provision the first company administrator

The first administrator cannot be created by public signup. Provision it from the backend folder after the schema migrations succeed. The name, email, and password are supplied through environment variables; the password is never printed or stored in this project.

In a Bash-compatible terminal:

```bash
read -r -p "Initial administrator full name: " BOOTSTRAP_ADMIN_NAME
read -r -p "Initial administrator email: " BOOTSTRAP_ADMIN_EMAIL
read -r -s -p "Initial administrator password (12+ characters): " BOOTSTRAP_ADMIN_PASSWORD
echo
export BOOTSTRAP_ADMIN_NAME BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
npm run provision:company
unset BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_NAME
```

Use an email address controlled by the initial administrator and a unique password. The provisioning command creates the company record, approved ADMIN account, 12-month initial cycle, and an authentication audit event in one database transaction. It is deliberately one-time: it will not reset an existing administrator's password or create another administrator in a company that already has a user.

## 4. Configure and run the frontend

In another terminal:

```bash
cd Frontend
cp .env.example .env
npm ci
npm run dev
```

`Frontend/.env` should have `VITE_API_BASE_URL=http://localhost:5000/api` for local development. Start the backend with `npm start` from `Backend`. The frontend build can be checked with `npm run build`.

For an online deployment, host the frontend and backend, set the real frontend origin in `FRONTEND_ORIGINS`, set `VITE_API_BASE_URL` to the deployed API URL before building, enable HTTPS, configure SMTP for the future email-verification/password-reset phase, and set production secrets in the hosting environment instead of uploading `.env` files.

## Initial company constitution values

The initial company settings provisioned in the company record are:

- Share price: 1,000 RWF.
- Borrowing limit: 2 times eligible savings.
- Service charge: 10% per 28-day period.
- Social Fund disabled in the seeded settings (`socialFundMode: NONE`).
- Virtual schedule: 14-day interval and 3-day payment window.
- Shares per payment window: 0–30.
- Cycle duration: 12 months.
- Withdrawal policy and loan-default policy: initial proposed text stored in the company settings.

Phase 2 will align all remaining financial screens, services, ledger reports and cycle-close paths with these rules, including removing Social Fund processing entirely and permitting loan repayments outside the savings contribution window.
