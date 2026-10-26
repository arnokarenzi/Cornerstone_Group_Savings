# CORNESTONE Co.LTD. — Online Savings Platform

This is the standalone CORNESTONE company version of the savings application. It uses the separate `cornestone_online_db` database. It must not be pointed at the old Itsinda database. The project does not integrate MTN Mobile Money, Airtel Money, bank APIs, or a payment gateway; actual payments are entered and reconciled by authorized staff.

## Current build: Phase 9 configurable constitutional loan terms and deployment readiness

The current package includes all changes from Phases 1–9. The following bullets summarize financial workflows originally added in Phase 6:

- Member withdrawal requests, committee approval/rejection, a separate payout action, transaction and Loan Fund ledger entries, an auditable receipt, and audit events. Paid redemptions are recorded as `SHARE_REDEMPTION`, netted from future borrowing capacity, and subtracted from remaining shares at share-out. A member cannot receive a withdrawal while principal or accrued service charges remain unpaid.
- Member/committee loan-restructuring requests, committee decision and audit history. The permitted extension is calculated from the current approved Constitution & Rules maximum loan term; restructuring does not forgive principal or accrued service charges.
- Database-backed idempotency keys for financial write endpoints. Repeat requests with the same key and same payload replay the recorded response instead of making a second financial entry; changed payloads, unknown outcomes, and key conflicts are blocked for reconciliation.
- The current production configuration preflight is `npm run preflight:phase9`; the read-only financial audit is `npm run audit:finance`. These do not replace a real staging test or backup restoration test.
- Frontend source changes for the six required navigation sections and the financial-request interface.

### Initial CORNESTONE rules in this build

- Share price: **1,000 RWF**.
- Maximum borrowing: **2 × eligible net savings**, less outstanding principal on other loans.
- Initial loan settings for a new company are a **10%** service charge, a **28-day** further-charge interval, and a **180-day** initial maximum term. These are starting constitutional values, not hard-coded runtime rules. Loan applications, new loan agreements, displayed terms and further-charge calculations read the current approved Constitution & Rules. A later approved amendment affects new loans; existing loans retain the terms snapshotted when disbursed.
- A loan is charged the initial configured rate at disbursement even if repaid early. Further charges are due at each boundary of the configured service-charge period and use principal outstanding at that boundary. The service-charge period and maximum contractual loan term are separate constitutional settings.
- Example under the initial defaults only: a 10,000 RWF loan has a 1,000 RWF initial charge. If fully repaid after four days, total due is **11,000 RWF**, subject to no separate fees. If the constitution changes the rate or period, new loans use those approved values.
- Savings contributions: three calendar days open in each 14-day period, calculated from the active cycle start in `Africa/Kigali` time. Loan repayments are allowed outside those windows.
- Shares per payment window: minimum 0, maximum 30.
- Savings cycle: 12 months.
- Social Fund processing and late-share/Gusibuza contributions are disabled in the active online financial workflows.

### Share-out formula — proposed, not yet formally approved

The proposed formula is `PROPORTIONAL_NET_CASH_BY_REDEEMED_SHARES`: after liabilities and approved closing blockers are settled and the remaining Loan Fund cash is reconciled, available cash is distributed proportionally to each member's **net unredeemed shares**. A surplus or deficit is shared in the same proportion. Mid-cycle redeemed shares are removed and are not counted a second time at closing.

This formula can result in a final payout above or below the member's share contributions. It must be formally proposed and approved through the Constitution & Rules member-vote workflow before the first live cycle is closed or members are promised a fixed return. The current preflight blocks deployment until the formula is in the current member-vote-approved constitution.

## Before applying Phase 6

1. Back up the database and verify the file is non-empty:

   ```bash
   sudo /opt/lampp/bin/mysqldump -u root cornestone_online_db > "$HOME/cornestone_online_db_before_phase6.sql"
   ls -lh "$HOME/cornestone_online_db_before_phase6.sql"
   ```

   Add `-p` after `-u root` if the MariaDB root account has a password.

2. Extract this ZIP. Copy its `Backend` and `Frontend` contents over the same folders in your project. Preserve the real `Backend/.env` and `Frontend/.env`; do not place secrets into the ZIP or commit them to Git.

3. Use Node.js 20 or later. In `Backend`, run:

   ```bash
   npm install
   npm test
   npm run check:syntax
   npm run configure:phase6
   npm run audit:finance
   ```

   `configure:phase6` checks that it is connected to the configured standalone CORNESTONE database, applies the Phase 6 migration, and sets the requested defaults only when the constitution is still unratified. It preserves an already member-approved constitution and warns if an amendment/vote is needed. It refuses to discard unsupported legacy transaction types. **If it stops with a safeguard error, stop and review the data; do not bypass the check.**

4. In `Frontend`, run:

   ```bash
   npm install
   npm run lint
   npm run build
   ```

   The backend uses Node.js 20+ built-in `fetch` to call the Resend HTTPS API; there is no SMTP package requirement for email delivery. If you change backend dependencies, keep `Backend/package-lock.json` synchronized with `package.json`.

5. Restart the backend and frontend (`npm run dev` in each directory). Test all the workflows below using a test member and amounts only; do not use real funds until the financial policies and staging checks are approved.

## Phase 6 functional acceptance checks

- [ ] An ordinary member may request a withdrawal only for their own account and within unredeemed share balance.
- [ ] Another authorized leader can approve/reject; the requester cannot approve their own request.
- [ ] A payout requires a fresh balanced cash count and enough reconciled Loan Fund cash; payout generates a `SHARE_REDEMPTION` transaction, ledger entry, receipt and audit event.
- [ ] A withdrawal is blocked while outstanding principal or accrued service charges remain, and redeemed shares reduce future borrowing and share-out.
- [ ] A restructuring request is reviewed by a different authorized committee member. Approval updates the due date within the 180-day policy limit; it does not erase balances.
- [ ] A 10,000 RWF loan repaid after four days requires 11,000 RWF total (10,000 principal plus 1,000 initial service charge).
- [ ] Repaid or partially repaid loans get further 10% charges at each later 28-day boundary using principal outstanding at that boundary.
- [ ] Replaying a successful financial POST with the same `Idempotency-Key` and same body returns the original result and creates no second entry. Reconcile an unknown request outcome before changing its key.
- [ ] The correct constitution/shares, loans, cashbook, payout and receipt views are reviewed after each test.

## Commands and production verification

In the backend folder:

```bash
npm test
npm run check:syntax
npm run audit:finance
NODE_ENV=production npm run preflight:phase6
```

`preflight:phase6` expects real production values in the environment, validates the database schema, company, approved admin, current cycle, required financial terms and Resend HTTPS-email configuration (without sending an email). It will not pass with the local example `.env` unchanged. After setting the API key and verified sender, use `npm run email:test -- recipient@example.com` to send a real test message. The earlier `preflight:production` remains available for the earlier schema/security checks but uses the same current email configuration.

The frontend must pass lint/build and real browser tests before deployment. Before public launch, also complete: successful migration against the intended staging DB, live email delivery, HTTPS and exact CORS origins, private database networking, automated encrypted backups, a successful restore test, monitoring, and incident/recovery instructions. Do not expose the database port publicly.

## Important scope and non-goals

- The database is separate from the legacy Itsinda database. Do not run `npm run db:fresh-install` or `npm run provision:company` against an existing Phase 1–5 installation.
- No mobile-money/payment-gateway integration is included.
- The source package does not perform a live deployment, run against your private MariaDB, prove transactional-email delivery, or prove that the remote backup can be restored; these require your own local/staging environment.
- The six main sections remain Overview, My Digital Passbook, Share-Out Preview, Constitution & Rules, Leadership Terminal, and Cycle Closing & New Cycle.


## Phase 7 — member ratification and staging acceptance

Read `PHASE7_UPGRADE_GUIDE.md` before upgrading, `SHARE_OUT_FORMULA_RATIFICATION_GUIDE.md` for the formal company vote, and `PHASE7_STAGING_ACCEPTANCE_TESTS.md` for required staging evidence. Phase 7 adds a hard block against cycle share-out until the current member-voted constitution contains the required formula, fixes the Phase 6 cashbook middleware import, and permits the `Idempotency-Key` CORS request header. See `PHASE7_STATUS.md` for validation limitations.

## Phase 8 — member payments, loan applications and committee roles

Phase 8 adds member-submitted manual payment records for share contributions, loan repayments and fine payments that remain pending until their designated committee recipient confirms receipt; member loan applications with live borrowing-capacity calculation; separate committee decision and actual disbursement; and ADMIN-only committee role management. Legacy direct loan-repayment/fine-payment posting endpoints are disabled to prevent bypass of receipt confirmation. The application continues to use the same six main navigation sections and does not add Mobile Money or payment-gateway integration.

Before upgrading, back up the existing database and read `PHASE8_UPGRADE_GUIDE.md`. Preserve the current `.env` files and existing administrator account. Phase 8's additive migration is applied with `npm run configure:phase8`; do not recreate the database or rerun one-time provisioning. Use `PHASE8_ACCEPTANCE_TESTS.md` for the member/committee end-to-end test plan. See `PHASE8_STATUS.md` for the validation completed and limitations.


## Phase 9 — configurable constitutional loan settings

Phase 9 removes fixed 28-day and 180-day runtime fallbacks. Member-facing loan statements show the rate, next-charge period and maximum term from the current approved Constitution & Rules. Runtime loan workflows fail closed if those values are missing or invalid. Historical loans preserve their original terms.

Before applying Phase 9, use `PHASE9_UPGRADE_GUIDE.md`. The database schema adjustment is applied with `npm run configure:phase9`; it does not rewrite existing loans. Use `npm run audit:constitutional-terms` to catch the hard-coded statement/runtime-fallback pattern and `PHASE9_DEPLOYMENT_PLAN.md` for the proposed online architecture and free-tier limitations.


## Phase 9 upgrade and deployment documents

- `PHASE9_UPGRADE_GUIDE.md` — backup, upgrade, migration, tests and production preflight instructions.
- `PHASE9_STATUS.md` — implementation and validation status, including items that still require local verification.
- `PHASE9_DEPLOYMENT_PLAN.md` — hosting layout, environment variables, provider trade-offs, monitoring and launch checklist.
- `PHASE9_DEPLOYMENT_DECISION.md` — concise production provider decision and limitations of free tiers.


## Phase 10 update

See `PHASE10_CONSTITUTION_AND_DEMO_HOSTING.md` for the explicit share-out constitutional clause and demonstration hosting options.


## Phase 11 — HTTPS transactional-email API

Email verification, password resets, and committee notifications now use the Resend REST API over HTTPS when `EMAIL_PROVIDER=resend`. Local development may continue using `EMAIL_PROVIDER=console` to print action links to the backend terminal. Production preflight requires a Resend API key and a sender address on your own verified domain.

Follow `PHASE11_HTTPS_TRANSACTIONAL_EMAIL_SETUP.md` for the Resend account, sender-domain, environment-variable, live-email-test, and free-host deployment steps. See `PHASE11_STATUS.md` for this phase’s implementation and validation summary. Run `npm run email:test -- your-real-inbox@example.com` from `Backend` to send a real test message; preflight itself never sends email.

## Phase 12 — free-demo deployment

Follow `PHASE12_CLOUDFLARE_RENDER_AIVEN_SETUP.md` for the current Cloudflare Pages frontend, Render Node.js backend, Aiven MySQL database, custom-domain/session-cookie requirements, TLS CA setup, Resend HTTPS-email configuration, and verification steps. The fresh-install script now supports the same verified TLS configuration as the app's normal database connection.
