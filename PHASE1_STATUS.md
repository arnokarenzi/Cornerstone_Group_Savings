# Phase 1 checklist — CORNESTONE Co.LTD.

## Implemented in this project copy

- [x] Separate project package names and company branding.
- [x] Default backend database changed to `cornestone_online_db`.
- [x] Fresh core schema and ordered SQL migration runner added.
- [x] Fresh-install command refuses non-empty databases and Itsinda-named databases.
- [x] Public group creation endpoint disabled.
- [x] One-time initial company/administrator provisioning command added; secret supplied through environment variables.
- [x] Login uses email instead of phone number.
- [x] Login attempts are rate-limited; tokens expire after 8 hours; the frontend uses session storage rather than persistent local storage.
- [x] Account approval state and account suspension are checked by API authentication middleware.
- [x] Authentication events are captured in `auth_audit_events`.
- [x] Six main navigation sections retained; cashbook, receipts, records and audit utilities moved inside Leadership Terminal.
- [x] Social Fund card removed from the Overview dashboard.
- [x] No payment-provider integration added.

## Intentionally reserved for later phases

- [ ] Member self-registration, email verification and approval/rejection UI.
- [ ] Password-reset email delivery and token-confirmation endpoints. The schema and SMTP environment placeholders are present, but the flow is not active yet.
- [ ] Move bearer-token authentication into a secure HttpOnly cookie/session design; session storage is an interim reduction in persistence, not a defense against XSS.
- [ ] Implement all constitution rules in both frontend and backend, including recurring virtual payment windows and loan repayments outside those windows.
- [ ] Remove Social Fund transactions, options, ledger branches, exports, reporting and cycle-closing requirements throughout the full financial workflow.
- [ ] Decouple the 28-day service-charge period from the maximum loan term.
- [ ] Complete the withdrawal/default policies and approve the share-out/surplus formula.
- [ ] Production deployment, SMTP provider configuration, monitoring, backup/restore validation and security review.

## Important

A live administrator account is not created in this coding environment because it has no access to the company's MySQL server or account owner credentials. Run the one-time provisioning command after setting up the new database. Do not put the actual administrator password in source code or share it in chat.
