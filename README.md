# IBMP — Integrated Business Management Platform

GST-integrated SaaS for Indian SMEs. Handover context: [docs/project-context.md](docs/project-context.md). Release notes: [CHANGELOG.md](CHANGELOG.md).

## Layout
| Path | What |
|---|---|
| `apps/api/` | `@ibmp/api`: Node.js + Express + PostgreSQL REST API (`/v1`). Source in `src/`, SQL migrations in `migrations/`, tests in `test/`, runnable scripts in `scripts/` |
| `apps/web/` | `@ibmp/web`: React (Vite) web portal |
| `docs/` | Handover and import notes |
| `legacy/` | Original single-file prototype (v6.0 locked, v6.2 current), its regression tooling and the original export. **Frozen reference; the v6.0 file is never edited.** |
| `Dockerfile`, `docker-compose.yml` | One image serves the API and the built web app; compose adds PostgreSQL |

## Conventions
- **Files:** kebab-case (`filing-lock.js`); React components PascalCase.
- **Environment variables:** `IBMP_`-prefixed (`IBMP_DATABASE_URL`, `IBMP_JWT_SECRET`, ...). The unprefixed names (`DATABASE_URL`, `PORT`, `JWT_SECRET`) still work as fallbacks. Full list in `apps/apps/api/.env.example`.
- **API:** plural REST paths under `/v1`; **camelCase JSON in requests and responses**; errors are `{ "error": "...", "code"?: "..." }` (validation adds `issues`, server faults add `requestId`). Database columns stay snake_case. The one exception is the `payload` of GST and e-invoice documents, which keeps the government portals' own field names exactly.
- **Packages:** `@ibmp/api`, `@ibmp/web`; semantic versions, one version for the release.

## Run locally (production mode, real PostgreSQL)
```
npm run setup      # install both apps
npm run local      # builds the web app, starts PostgreSQL (data in .data/) and the API in production mode
npm run seed       # optional demo data: demo@ibmp.in / password123, consultant@ibmp.in / password123
```
Open http://localhost:4000. Payments and GST filing are **simulated** here (`IBMP_ENABLE_SIMULATORS`); nothing is charged or filed. Secrets are generated once into `.data/secrets.json`.

Development with hot reload: `npm --prefix apps/api run dev:mem` (in-memory database) and `npm --prefix apps/web run dev` (port 5173, proxies `/v1`).

## Deploy
```
# .env next to docker-compose.yml: IBMP_DB_PASSWORD, IBMP_JWT_SECRET (32+ chars), IBMP_SECRETS_KEY (16+ chars), optional Razorpay keys
docker compose up -d --build
```
In production the API refuses to start with a missing or weak JWT secret, no database, no encryption key, or wildcard CORS. It serves security headers, rate-limits sign-in and API calls, logs one JSON line per request, exposes `/v1/health` (liveness) and `/v1/ready` (database check), shuts down gracefully, and runs migrations under a database lock so several instances can start together. Put it behind HTTPS and set `IBMP_TRUST_PROXY=1`. **Docker verified (7 October 2026, Docker 29, Windows):** `docker compose up -d --build` builds a 256 MB image in under a minute; it runs as the unprivileged `node` user on Node 22 with PostgreSQL 17, applies all 19 migrations, passes its health check, serves the web app and API on one port with the security headers, rate-limits sign-in after 20 attempts a minute, stops cleanly on SIGTERM (about half a second, exit 0), keeps its data across a restart, refuses to start with a weak `IBMP_JWT_SECRET`, and passes `npm run smoke:ui` when seeded. Still not verified live: Razorpay, SMTP, WhatsApp Cloud, Twilio and any GSP, and a deployment behind a real HTTPS proxy.

## Tests
`npm test`: runs against in-memory Postgres (pg-mem), no database needed (fast; 3 real-database tests are skipped).
`npm run smoke:ui` (portal running, demo users seeded): opens every screen for every role in headless Chrome and fails on a crash, a console or page error, a 5xx response, the error-boundary message, or values like `undefined` and `NaN` on screen (58 views across five roles, including every sub-tab and every new-record drawer; verified to fail on a deliberately corrupted screen). Needs Chrome or Edge.
`npm run test:pg`: the same suite against a **real PostgreSQL 18** (a throwaway embedded instance, one fresh database per test file, started and removed by `apps/api/scripts/test-pg.js`). A loader shim in `apps/api/test/support/` swaps `pg-mem` for it, so the test files are unchanged. It adds tests only a real database can run: concurrent migrations under the advisory lock, rollback of a failed migration, and key constraints. Last run: 187 of 187 passing on PostgreSQL 18.4. Run one file with `npm run test:pg -- test/tds.test.js`.

## Portal MVP (v0.1)
Register (company + sector + GSTIN/state) / login · parties · items with GST slab and stock · invoices with
CGST+SGST vs IGST by place of supply, per-company numbering, stock deduction, payments · dashboard.

## v0.2 — Purchases
Vendor bills (GST exclusive, as in prototype v6.2): ITC split into CGST+SGST/IGST by vendor state, stock added, duplicate vendor-bill-no guard (per vendor), payments, payable + input GST on the dashboard. Migrations are now tracked in schema_migrations.

## v0.3 - Returns
Credit notes (CN-0001..) against sales invoices and debit notes (DN-0001..) against vendor bills, ported from prototype v6.1/v6.2 rules:
- Goods return (stock moves: sales +, purchase -) or value-only (price/discount, no stock); partial or full.
- Guards: qty <= balance, value <= returnable balance, note date >= document date, fully returned documents rejected, purchase returns blocked if stock is insufficient.
- GST on a note mirrors the document (same slab, same CGST+SGST/IGST split); dashboard GST is net of notes; receivable/payable and payment caps are net of returns; status can become `returned`.
- Endpoints: `GET /invoices/:id/returnable`, `POST /invoices/:id/returns` (and the same under `/purchases`), `GET /returns`, `GET /returns/:id`.
- `npm run dev:mem` in `api/` runs the API on an in-memory database if Docker/PostgreSQL isn't available.

## v0.4 - Ledger
Double-entry ledger. A system chart of 15 accounts is seeded per company (custom accounts can be added); every posting is a balanced journal entry written in the same transaction as its document:
- Invoice: Dr Debtors / Cr Sales + Output CGST/SGST/IGST. Purchase: Dr Purchases + Input GST / Cr Creditors.
- Credit note: Dr Sales Returns + Output GST / Cr Debtors. Debit note: Dr Creditors / Cr Purchase Returns + Input GST.
- Receipt: Dr Cash or Bank / Cr Debtors. Vendor payment: Dr Creditors / Cr Cash or Bank. Payments now take `mode` (cash|bank) and `date`, and are stored in `payments`.
- Manual journals (opening balances, expenses, adjustments) must balance.
- Reports: chart with balances (`/accounts?asOf=`), account statement with opening/running balance, party statements, journal register, trial balance.
- Documents created before v0.4 are not back-posted (no production data yet); only new activity reaches the ledger.

## v0.5 - GST reports
`GET /v1/gst/gstr1?period=YYYY-MM` and `GET /v1/gst/gstr3b?period=YYYY-MM` (UI: **GST Reports**), built from the documents and reconciled to the ledger.
- GSTR-1: B2B (4A/4B), B2C large (5, inter-state > 2.5 lakh), B2C small (7, by place of supply and rate), credit notes (9B CDNR / CDNUR), HSN summary (12), documents issued (13). Credit notes against small B2C invoices net into table 7; HSN is net of credit notes.
- GSTR-3B: 3.1(a) taxable and 3.1(c) nil-rated (net of credit notes), 3.2 inter-state to unregistered, 4 ITC (available, reversed by debit notes, ineligible), section 49 set-off with cash payable and ITC carry-forward.
- ITC is only claimed on bills from vendors that have a GSTIN; others are listed as ineligible and flagged.
- Reconciliation compares the GST accounts in the ledger for the period with the report; a stray manual journal shows up as a difference.
- Not covered: exports/SEZ, reverse charge, e-commerce, amendments, QRMP (quarterly) filers, e-invoice/e-way bill, and actual filing. Filing needs the GSP integration (Masters India / Tera) and its JSON schema.
- `npm run seed` (with the portal running) loads an October 2026 demo company: demo@ibmp.in / password123.
## v0.6 - Compliance calendar
Rules engine in `apps/api/src/compliance.js` generates statutory due dates per company profile and financial year (`GET /v1/compliance?fy=2026-27`); only user actions are stored, so a rule change never leaves stale rows.
- Rules: GSTR-1 (11th) / GSTR-3B (20th) monthly; QRMP quarterly GSTR-1 (13th), GSTR-3B (22nd or 24th by state) and PMT-06 (25th); GSTR-9; TDS payment (7th, March: 30 Apr) and 24Q/26Q returns; PF and ESI (15th); advance tax (15 Jun/Sep/Dec/Mar); ITR and tax audit report.
- Applicability comes from settings (`/compliance/settings`): GST frequency, TDS, PF, ESI, advance tax, tax audit; GST items need a GSTIN.
- Status as of a date (`asOf` for testing): overdue, due soon (7 days), upcoming, completed (and "filed late").
- Mark filed with date and ARN/challan reference; extend a due date when the government notifies an extension (statutory date and reason are kept); custom items.
- New companies only see periods due after sign-up; move "track from" back to record earlier filings.
- GST items link to the matching GST report; the dashboard shows overdue and next-due items.
- The due dates are statutory defaults written from general knowledge of the Indian rules, not from the project's Compliance Calendar Rules Engine document (not in the handover). Reconcile against that document and current notifications before relying on them. Not modelled: state Professional Tax, ROC filings, late fees and interest, holiday adjustment, reminders.
## v0.7 - Payroll
Employees (`/payroll/employees`) and monthly runs (`/payroll/runs`, UI: **Payroll**). Calculation engine in `apps/api/src/payroll.js`:
- Pay: salary structure (basic, HRA, special, travel, medical) prorated on calendar days for loss of pay, joining and exit dates; one-off earnings and deductions (e.g. advance recovery) per payslip.
- PF: 12% of basic capped at the ₹15,000 wage ceiling (or actual wages if opted), employer share split EPS 8.33% / EPF, EDLI 0.5%, admin charge 0.5% (min ₹500 per establishment).
- ESI: employees whose full monthly gross is within ₹21,000, 0.75% / 3.25% rounded up.
- TDS on salary: full-year projection (year-to-date from finalized runs + this month + remaining months at the current structure), new or old regime, standard deduction, 87A rebate with marginal relief, 4% cess; later months absorb differences.
- Professional tax is a fixed monthly amount per employee (state slabs differ, so it is not guessed).
- Lifecycle: draft (edit LOP and adjustments, recalculate) -> finalize (locks, posts Dr Salaries + employer contributions / Cr Salary, PF, ESI, TDS, PT payable, advances) -> pay salaries -> record PF/ESI/TDS/PT remittances. A finalized run can be reopened until salaries or any statutory amount are marked paid (a reversing entry is posted).
- Payslips snapshot employee details, so later master changes never alter past slips. Printable payslip in the UI.
- Not covered: surcharge (warned above ₹50 lakh taxable), income from a previous employer, HRA/LTA exemptions in the old regime, perquisites, arrears, labour welfare fund, gratuity/bonus, Form 16/24Q, ECR/ESI file formats, daily attendance register (loss-of-pay days are entered per payslip).
- The FY 2026-27 tax slabs are carried over from FY 2025-26 and flagged as unverified in the API and UI; confirm against the Finance Act. The statutory rates and ceilings are written from general knowledge, so check them against current EPFO/ESIC notifications.
- Eight payroll accounts were added to the system chart; companies created earlier get them automatically on their first payroll posting.
## v0.8 - Attendance register
Daily register per employee (`/attendance`, UI: **Attendance**): Present, Absent, Half day, Paid leave, Holiday, Week off.
- Month grid with a status brush; auto-fill marks weekly offs and holidays and can default every other day to present; bulk apply by employees and dates; per-company week-off days and holiday list.
- Loss of pay = absent days + 0.5 per half day. Only days inside an employee's joining/exit range count, and marks outside it are rejected.
- Unmarked days are paid as present but flagged: the grid shows the count, and a payslip warns when the register is in use for that employee and month.
- Payroll: a new run takes each employee's loss of pay from the register; "Sync attendance" on a draft run overwrites loss of pay with the register's value (other adjustments are kept), and the payslip table shows when the register disagrees with a manual figure. A company that never uses the register is unaffected.
- Once payroll for a month is finalized or paid, that month's attendance is frozen (mark, bulk, auto-fill and sync all return 409); reopening the run unlocks it.
- Not covered: leave types with balances, accrual and approval workflows, shift/clock-in capture, overtime, regularisation requests, employee self-service.
## v0.9 - Leave management
Leave types, balances, adjustments and an apply / approve workflow (`/leave/*`, UI: **Leave**).
- Types: default CL (12, monthly), SL (6, up front), EL (15, monthly, carries up to 30) and unpaid LWP are created per company on first use. They are starting points, not statutory entitlements (state Shops & Establishments rules differ), so edit them. Each type sets paid/unpaid, days per year, accrual (monthly or up front) and a carry-forward cap.
- Balances are computed, not stored: carried forward + accrued + adjustments - approved leave. Leave year is April-March. A month earns credit if the employee is on the books on its 15th (joiners and leavers are pro-rated); totals round to the nearest half day; the balance carries forward up to the cap and the rest lapses.
- Applications: week offs and holidays inside the dates are not counted; half days; no overlapping requests; no request across two leave years; dates must be within employment. Pending requests reserve balance for new applications but not against approving earlier ones.
- Approving writes into the attendance register: paid leave becomes `L` (or `HL` for a half day), unpaid leave `A` (or `HD`), so payroll loss of pay follows automatically. Approval needs real balance; an insufficient request can be approved as another type such as leave without pay. Cancelling an approved request restores what the register showed before.
- Payroll lock: leave that falls in a month whose payroll is finalized or paid cannot be approved or cancelled until the run is reopened.
- Adjustments (opening balances, corrections, encashment as a negative) need a reason and cannot overdraw a balance.
- Not covered: employee self-service, approval chains and roles (any signed-in user of the company can decide), sandwich rules, probation restrictions, leave encashment pay-outs in payroll, compensatory off, maternity/statutory leave rules, leave-balance printing on payslips.
## v1.0 - Subscription plans and payment gateway
Plans, billing and feature control (`/billing/*`, UI: **Billing**). Configuration is in `apps/api/.env.example`.
- Plans (`apps/api/src/plans.js`): Free Trial, Starter ₹999, Professional ₹2,499, Enterprise ₹4,999 per month, billable for 1, 3, 6 or 12 months. A new company starts a 14-day trial with every feature.
- GST: prices are exclusive; 18% GST is added, split CGST+SGST or IGST by comparing the customer's state with `IBMP_STATE_CODE`. Each payment produces a numbered tax invoice (`IBMP/2026-27/00001`), numbered only when paid so the series has no gaps from abandoned checkouts.
- Buying: a new purchase starts today; renewing the same plan starts the day after the current period ends; upgrading starts today and credits the unused value of the current plan (once: absorbed invoices are marked); moving to a lower plan waits until the current period ends. Cancelling only stops renewal reminders, access continues to the paid end date.
- Control: Starter covers accounting, GST and compliance; payroll, attendance and leave need Professional (402 `PLAN_REQUIRED`). After a paid period ends there are 3 days of full access (grace), then the portal is read-only (402 `SUBSCRIPTION_EXPIRED`): data stays viewable and exportable, and billing stays reachable.
- Gateway (`apps/api/src/gateway.js`): one provider interface. Razorpay (Orders API, checkout signature, webhook signature) when `RAZORPAY_KEY_ID`/`SECRET` are set; a simulated gateway for development and tests (never available in production). Each billing period is a one-off order the customer pays, not an auto-debit mandate.
- Payment confirmation arrives two ways, both verified by signature and settled once: the browser callback (`POST /billing/verify`) and the server webhook (`POST /webhooks/payments`, amount-checked against the invoice). A payment for an abandoned checkout is still honoured. Every callback is logged in `billing_events`.
- Tested: pricing, credit, status, signature maths (including a standard HMAC test vector), the request sent to Razorpay (against a stubbed HTTP layer) and the full purchase flows. **Not tested against a live Razorpay account**: run through its test mode (test keys, a test card, a webhook pointed at your server) before going live.
- Assumptions to confirm against the PRD: the trial length and its features, which plan includes the HR modules, GST-exclusive pricing, no discount for longer periods, the 3-day grace, and the issuer's state (default 36). Enterprise's employee logins and Consultant slab pricing (0-5 and 5-10 companies) are not built: both need multi-user and multi-company support first.
- Not covered: refunds and credit notes for subscription invoices, auto-renewal and dunning emails, coupons, a back-office to change prices or see customers, proration for downgrades, e-invoicing of subscription invoices (IRN) if IBMP's turnover requires it.
## v1.1 - Multi-company support for consultants
One login can manage several companies (`/companies`, `/auth/switch`, UI: **Companies** and the company switcher).
- Accounts: `individual` (one company) or `consultant` (CA / CS / CMA). Register as a consultant with the professional body and membership number, or convert an existing account under Companies. A login belongs to companies through `user_companies`; the token carries the *active* company, and every request re-checks membership, so removing a membership (or archiving a company) cuts off even a valid token at once. Sign-in resumes in the company last used.
- Each company has its own books, users' data and settings; nothing is shared between a consultant's companies. New companies get the standard chart of accounts.
- Billing: a consultant's client companies have no subscription of their own. They are covered by the consultant's own (home) company subscription, which pays for all of them and gives each the full feature set. Invoices and payments live on the consultant's account, and Billing works the same from any of their companies.
- Slabs: `consultant_5` (up to 5 companies) and `consultant_10` (up to 10), counting the practice's own company plus clients; archived companies do not count. The free trial allows up to 5 so a consultant can try real clients. Over the limit returns 402 `COMPANY_LIMIT` with the plan to move to; at 10, 409 `COMPANY_LIMIT_MAX`. Moving between slabs is an upgrade with credit for unused time. Individuals and consultants buy from separate plan lists. An expired subscription makes every client company read-only.
- Archive a finished client (hidden, kept, frees a slot) and restore it later if a slot is free.
- Practice overview (`GET /consultant/overview`): overdue and due-soon compliance counts for every company, worst first, with the most overdue and next deadline.
- Professional verification: the claimed credentials are stored as `pending`. Staff decide with `POST /admin/consultants/:userId/decision`, which only exists when `ADMIN_API_KEY` is set (see `apps/api/.env.example`). Verification is shown to the consultant but does **not** block anything yet: decide whether an unverified consultant should be limited.
- **The two consultant slab prices (₹3,999 and ₹6,999 per month) are placeholders**: the handover names the slabs but not the prices. Set them in `apps/api/src/plans.js` before launch. The bands are "up to 5" and "up to 10" companies; confirm that reading of "0-5 and 5-10".
- Not built: inviting a client or staff member to a company as a second user (a company still has one login, the consultant's), the Enterprise employee logins, per-client billing, and a consultant being a member of a company that is billed elsewhere. `node seed-demo.js` also creates `consultant@ibmp.in` / `password123` with three clients.
## v1.2 - GST filing (GSP integration)
Prepare, review and file GSTR-1 and GSTR-3B (`/filing/*`, UI: **GST Filing**), look up GSTINs, and lock filed months.

**Read this first: no real GSP is connected.** The product plan names Masters India or Tera Software, but I had neither provider's API documentation nor sandbox credentials, so no live adapter exists. What is built:
- **A GSP interface** (`apps/api/src/gsp.js`): `sendOtp`, `verifyOtp`, `searchGstin`, `saveReturn`, `returnStatus`, `submitReturn`, `fileReturn`. A real adapter implements these seven methods; nothing else changes.
- **A simulated GSP**, the default outside production, loudly labelled in the UI and in every response. OTP is `123456`; it rejects a recipient GSTIN with a bad check character and an invoice valued below its taxable value, as a real portal would. It proves the flow works; it proves nothing about what the real portal accepts.
- `GSP_PROVIDER=masters_india` or `tera` selects a stub whose every call returns 501 and says what is missing. In production with no GSP configured, filing is off.

**What works without any GSP:** GSTR-1 and GSTR-3B as **JSON in the GSTN structure** (`GET /filing/export/GSTR1?period=2026-09&file=1`, or "Download JSON"), ready to upload with the GST offline utility. GSTR-1 covers b2b, b2cl, b2cs, cdnr, cdnur, nil, hsn (with GST unit codes), doc_issue and aggregate turnover; GSTR-3B covers outward supplies, inter-state to unregistered, ITC (available, reversed, net, ineligible). The structure was written from the published schema without a validator to test against, and `warnings` list every known gap (nil vs exempt vs non-GST, GSTR-3B table 5, interest and late fee, imports and reverse charge, turnover computed from IBMP data only). Check the first export against the portal before relying on it.

**The filing workflow** (monthly filers only; QRMP is refused): connect to the portal (username + OTP; the session token is encrypted at rest with `SECRETS_KEY` and expires), **prepare** a snapshot with blocking errors and warnings, **save** to the GSP (rejections are stored and shown), **submit**, then **file** with an EVC OTP.
- Filing is irreversible, so it needs an explicit confirmation, the OTP, and the **hash of the exact payload that was reviewed**. If the books change after preparing, the return is marked stale and must be prepared again. A GSTR-3B with cash tax payable is refused until a challan reference is given.
- Only the account owner can connect or file. Every step is logged (who, what, when).
- On filing, the matching compliance-calendar item is marked completed with the ARN.
- **Locks:** once a GSTR-1 or GSTR-3B for a month is submitted or filed, invoices, purchase bills and credit/debit notes dated in that month are refused (409 `PERIOD_FILED`); date them in the current period or amend through a later return.
- **GSTIN lookup** (`GET /filing/gstin/:gstin`, "Fetch details" on parties and new companies) validates the GSTIN's check character locally first (verified against real GSTINs), then asks the GSP. With the simulator the returned name is fake and labelled.
- Not built: e-invoice (IRN) and e-way bill generation, amendments (GSTR-1A / table 9A), GSTR-2B reconciliation, QRMP filing, paying the tax challan, DSC-based filing, and a real adapter for either GSP. Before any live filing, run the full flow in the GSP's sandbox with a test GSTIN.
## v1.3 - E-invoice (IRN) and e-way bill
Generate IRNs for B2B invoices and credit notes, and e-way bills for goods (`/einvoice/*`, `/ewb/*`, UI: **E-invoice & E-way**). The same limits as GST filing apply: **no real GSP, IRP or e-way bill portal is connected**. Documents go through the GSP interface, which only has the simulator behind it. Every IRN, acknowledgement, QR and e-way bill it returns is fake and labelled SIMULATED in the UI. Do not issue invoices or move goods on the strength of them.

What is built:
- **Payload builders** for the NIC e-invoice schema (INV-01 v1.1: invoice and credit note with reference to the original) and the e-way bill JSON, with the checks the IRP and portal apply: addresses and 6-digit PIN codes for both parties, HSN, valid GST rates, document-number format, totals within ₹1, vehicle-number format, distance up to 4,000 km, goods only, mode-specific transport details. Hard failures are errors that block generation; things the IRP might refuse (a GSTIN with a bad check character, retired 12%/28% slabs, documents older than 30 days) are warnings. Written from the published schemas with no validator to test against: check the first payload on the sandbox.
- **Workflow:** prepare (review errors and warnings) -> generate. The e-invoice payload is rebuilt at generation, so a fixed address needs no re-prepare. Cancel an IRN or an e-way bill (the simulator enforces the 24-hour window, the reason codes and "a cancelled document number cannot be reported again"); update the vehicle (Part B) on an e-way bill, including transporter-assigned vehicles. A document with a live IRN or e-way bill cannot be prepared again. Every step is logged, and only the account owner can generate or cancel.
- **Applicability:** a setting says whether e-invoicing applies and from which date; the documents list then shows which B2B invoices and credit notes still need an IRN. B2C documents are never e-invoiced. IBMP sees only one GSTIN, so the ₹5 crore threshold test is a hint, not a decision. The e-way bill limit (default ₹50,000) is configurable because states differ.
- **New data:** business details (legal name, address, PIN, contact) and party addresses, which the portals require and the system did not hold. Edit them under Setup and Parties (a party's GSTIN is deliberately not editable).
- **Links:** GSTR-1 export warns when invoices were reported to the IRP, since they reach GSTR-1 automatically and the upload may need to leave them out (confirm with your GSP).
- Simulator assumptions worth knowing: the IRN is a SHA-256 of seller GSTIN, document type, number and financial year (the real IRP issues its own); e-way bill validity is one day per 200 km (20 km for over-dimensional cargo) to the end of that many days after generation; distance 0 is treated as 100 km.
- **Not built:** e-way bill by IRN, extending validity, consolidated e-way bills, bill-to/ship-to and dispatch-from variants, exports and SEZ supplies, reverse charge, e-invoicing of debit notes, recovering an IRN after a lost response, invoice cancellation in IBMP (so a cancelled IRN means issuing a new document yourself), the IRP's separate API credentials, and a real adapter.
- **Rates:** the 40% slab is now accepted on items. The September 2025 rate rationalisation retired the 12% and 28% slabs for most goods; they stay selectable so old documents still work, and e-invoices warn about them. Review your item rates.
## v1.4 - Form 24Q and Form 16
Year-end and quarterly TDS-on-salary reporting (`/tds/*`, UI: **TDS & Form 16**), built on finalized payroll.

**What this is, and is not.** It prepares the *data* correctly and checks it. It does **not** produce the NSDL FVU input file (that fixed-field format is version-specific and I could not validate it), and it cannot issue Form 16 **Part A**, which only TRACES generates once your 24Q statements are processed. The workflow is: prepare the statement here, key or import its CSV into NSDL's Return Preparation Utility, validate with the FVU, upload through TRACES / TIN-FC, record the 15-digit token number here.

- **Setup:** TAN, deductor PAN (taken from the GSTIN if blank), deductor type and the person responsible. For each month's TDS deposit, enter the bank challan's BSR code and serial number (and any interest or fee paid on it) once the payment is recorded on the payroll run.
- **Form 24Q, per quarter:** the challan list, one deductee row per employee per month with tax (the payroll TDS, which includes 4% cess, is split into income tax and cess), and, for Q4, **Annexure II** with each employee's salary and tax computation for the year. Download challans, deductees and Annexure II as CSV, or everything as JSON.
- **Checks:** TAN and PAN present and well-formed, address complete, a finalized payroll month for each month in the quarter, TDS deposited, challan details present, employee PANs present, quarter over. The PAN used is the employee's current record, so a PAN fixed after payroll is picked up. Estimates, as warnings only: interest for late deposit (1.5% per month or part), late filing fee under section 234E (₹200 a day, capped at the tax deducted), and short or excess deduction per employee at year end.
- **Form 16 Part B:** every line of the salary and tax computation (gross salary, standard deduction, tax on employment, taxable income, tax on income, rebate or marginal relief, cess, net tax, tax deducted), the month-wise tax with its challan, and a quarter-wise summary with token numbers for Part A. Printable from the browser; sign it and attach Part A. An employee whose payroll for the year is incomplete (employed in months with no finalized run) is flagged on the list and the certificate warns not to issue it.
- **Filing record:** `POST /tds/24q/filed` stores the token number and marks the TDS return item done in the compliance calendar; removing it reopens the item. The calendar now also has a **Form 16** deadline (15 June after the year).
- Not covered (reported as nil with a warning where relevant): perquisites (Form 12BA), section 10 exemptions such as HRA and LTA, income from previous employers or other sources, the section-wise breakup of Chapter VI-A deductions (only the declared total is held), surcharge, relief under section 89, 26Q (non-salary TDS), correction statements, and government deductors.
- The tax rules are those of the payroll engine: the FY 2025-26 table is verified, and FY 2026-27 reuses it and is flagged as unverified. Check the figures against the current Finance Act before issuing certificates.
## v1.5 - ECR and ESI file exports
Monthly PF and ESI contribution files from a finalized payroll month (`/statutory/*`, UI: **PF & ESI**, part of the HR plan).

- **EPFO ECR** (`GET /statutory/pf/export?month=2026-08`): the ECR 2.0 text file, one line per member with eleven fields separated by `#~#`: UAN, member name, gross wages, EPF wages, EPS wages, EDLI wages, member's 12%, EPS 8.33%, employer's EPF-EPS difference, non-contributory days, refund of advances. EPS and EDLI wages are capped at ₹15,000 even where the member contributes on higher wages. Also available as CSV, with the challan shown by EPFO account (A/c 01 members' and employer's shares, A/c 10 pension, A/c 02 admin, A/c 21 EDLI) and its total, which ties to the PF payment on the payroll run.
- **ESIC monthly contribution** (`GET /statutory/esi/export?month=...`): the template's six columns: IP number, name, days wages were paid, total monthly wages, reason code for zero working days (1 on leave, 2 left service, 0 otherwise) and last working day. Only employees covered in that month are listed.
- **Checks that block a file:** a UAN that is missing, not 12 digits or used twice; an ESI number that is missing, not 10 or 17 digits or used twice; a month that is not finalized; member contributions that do not add up to the payroll run. UAN and ESI numbers are now also validated when an employee is saved. The current employee record wins over the payslip, so a UAN fixed after payroll is the one exported. Names are cleaned to capital letters, spaces and full stops as the ECR requires, with a warning.
- **References:** record the 13-digit TRRN the EPFO portal returns and the ESIC challan number. Once the payment is also recorded on the payroll run, the matching PF or ESI compliance-calendar item is marked completed with that reference, and late payments are flagged.
- **The layouts were written from the published formats without the portals' validators**, and the portals recompute employer-side charges themselves. Treat the first upload as a test and read what the portal says.
- Not covered: higher pension (EPS on actual wages), exits (the portal's separate member-exit step), joiners' date-of-joining fields, an `.xls` file for ESIC (the CSV is meant to be opened in Excel or pasted into ESIC's own template), the ESI contribution-period rule (an employee who crosses ₹21,000 stays covered until the period ends), and uploading to either portal.
## v1.6 - TDS on non-salary payments and Form 26Q
UI: **TDS & Form 16 > Non-salary TDS & 26Q**. Section catalogue and maths in `apps/api/src/tdsns.js`, routes in `routes/tdsns.js`, migration `015`.
- **Deductions** (`/tds/ns/*`): deduct from a purchase bill (the vendor is then owed the bill less the TDS) or pay a vendor directly (rent, fees, commission, interest, contractors: expense, payment and TDS in one entry). `POST /tds/ns/quote` shows the result first. Sections: 194A, 194C, 194H, 194I(a), 194I(b), 194J(a), 194J(b), 194Q.
- **Yearly limits** build up per vendor and section. Once a limit is crossed the new payment carries catch-up tax on what was paid earlier (flagged). Payments under the limit are still recorded, because they count. 194C also deducts on any single payment over its limit; 194Q taxes only what is above ₹50 lakh.
- **PAN**: set on the vendor (`PUT /parties/:id/pan`), else taken from its GSTIN. No PAN means 20% (5% for 194Q) and `PANNOTAVBL` on the statement. A rate can be overridden per deduction, with a certificate number, for lower-deduction certificates.
- **Challans**: one per month and type of deductee (company 0020, non-company 0021), for the sum of that month's deductions; recording one posts the deposit (Dr TDS Payable, Dr interest/fee, Cr bank/cash) and completes the calendar item.
- **Form 26Q** (`/tds/26q`, `/export`, `/filed`): the statement data per quarter (deductor, challans, deductee rows) with checks (TAN, person responsible, address, every deduction matched to a challan of the right amount, quarter ended) and warnings (no PAN, certificate rates, late deposit interest, section 234E late-filing fee). CSV and JSON downloads. Recording the token number completes the calendar item and **locks the quarter**: its deductions and challans can no longer change until the record is removed.
- **Books**: everything posts to the ledger (account 2250 TDS Payable (non-salary), expense accounts 5400 to 5450); reversing a deduction or removing a challan posts the opposite entry. Reversal is blocked while a challan covers the month, while a later deduction builds on it, or after filing.
- **Limits, stated plainly:** the rates and thresholds are **not verified** (`RATES_VERIFIED=false`, shown in the UI); the Income-tax Act 2025 renumbers the sections from 1 April 2026, so confirm the section codes the current Return Preparation Utility accepts. This is statement **data**, not the NSDL `.fvu` file. Not modelled: GST on expense payments (record GST on the vendor bill instead), the 206AB higher rate for non-filers, TDS on director remuneration, proportional TDS on partial debit notes, lower-deduction certificates beyond a typed rate, correction statements, and Form 16A (issued by TRACES).

## v1.7 - Compliance reminders (email and WhatsApp)
UI: **Compliance > Reminders**. Engine in `apps/api/src/reminders.js`, providers in `notify.js`, routes in `routes/reminders.js`, migration `016`.
- **When:** for every open compliance item, on the days before the due date (default 7, 3, 1 and the day itself) and after it while it stays open (default 1, 3, 7). One digest message per recipient per run, not one per item. Done items are never reminded; moving a due date restarts the sequence.
- **Never twice, never a backlog:** every item and moment is logged, so re-running, restarting or a second instance sends nothing again. A server that was down on the day sends one catch-up for the latest moment. Reminders only cover moments from the day they were switched on.
- **Who:** up to 20 recipients per company, each an email address or a WhatsApp number. A WhatsApp number needs the owner to confirm the person agreed to receive messages (stored with the date). Recipients can be paused or removed; addresses are masked in the UI and log.
- **The daily job** runs in the API process hourly between 09:00 and 21:00 IST, under a database lock. It skips archived companies and companies whose subscription has expired (the portal is read-only then). `POST /reminders/run` and `GET /reminders/preview` do the same for one company on demand; `POST /reminders/recipients/:id/test` sends a test message.
- **Providers (same pattern as payments and the GSP):** email over any SMTP server (`IBMP_SMTP_URL`, `IBMP_MAIL_FROM`); WhatsApp through Meta's Cloud API (`IBMP_WHATSAPP_*`). Outside production, or with `IBMP_ENABLE_SIMULATORS`, a simulator records messages instead of sending them and is labelled as such. In production a channel that is not configured is reported as skipped, never faked. **Neither real provider has been tested live.**
- **WhatsApp needs an approved template.** A business can only start a conversation with a template that Meta has approved (category Utility), with two variables, for example: "Compliance reminder for {{1}}: {{2}}. Open IBMP for details." Create it in WhatsApp Manager and set its name; until it is approved, sends fail, are logged as failed and are retried at the next run.
- **Not built:** replies and STOP handling for WhatsApp (needs an inbound webhook), delivery receipts, per-item or per-category rules, reminders to the person a task is assigned to, SMS, and unsubscribe links in emails (the footer tells recipients to ask the account owner).

## v1.8 - SMS reminders
A third reminder channel next to email and WhatsApp: same timing, recipients, consent, log, preview and test send (**Compliance > Reminders**). Provider: **Twilio** (`twilioSms` in `apps/api/src/notify.js`, built to Twilio's published Messages API: HTTP Basic auth, form fields To, Body and From or MessagingServiceSid). A simulator stands in outside production. **Not tested against a live Twilio account.**
- **India's DLT rules shape the message.** Every SMS must match a template registered on the TRAI DLT platform (Principal Entity, sender ID and template approval by your operator, typically 24 to 48 hours); only the `{#var#}` placeholders may differ. So the wording is not free text: register this template, or your own with the same placeholders in this order, and put the registered text in `IBMP_SMS_TEMPLATE`:
  `IBMP reminder: {#var#} has {#var#} compliance item(s) to action. Next: {#var#} due {#var#}. Open IBMP for details.`
  Variables, in order: company, number of items, the most urgent item, its due date (at most 4 placeholders). Each value is cut to `IBMP_SMS_VAR_MAX` characters (default 30, the usual DLT variable limit). Real SMS is only enabled when the credentials, a sender or messaging service, and a valid template are all set.
- **One short SMS per recipient per run** (the count and the most urgent item), not one per item; the full list is in the app.
- **Consent** is recorded for SMS numbers as for WhatsApp; a number can be on both channels.
- **What I could not verify:** how Twilio handles India's DLT identifiers (entity and template IDs) on the API call, and delivery to Indian numbers on a live account. Twilio documents India-specific registration separately: confirm it before relying on delivery. MSG91 and other Indian SMS providers are not implemented: their public API pages could not be read, so no adapter was written from memory.
- **Not built:** delivery receipts, STOP/opt-out handling for replies, other SMS providers.

## v1.9 - Platform owner console
For the people who run IBMP, at **`/platform`** (its own sign-in, separate from the business portal). Routes in `apps/api/src/routes/platform.js`, accounts in `platform.js`, UI in `apps/web/src/platform/`, migration `018`.
- **Sign-in is separate.** Platform admins live in their own table; their token is signed with a different key (derived from the main one) and tagged as a platform token, so a business token does not work on `/v1/platform` and a platform token does not work on any business route. Passwords need 12+ characters; five wrong attempts lock the account for 15 minutes; an unknown email looks the same as a wrong password; switching an admin off takes effect on their next request; tokens last 4 hours. There is no sign-up: create admins with `npm --prefix apps/api run admin:create -- --email you@company.com --name "You"` (a password is generated and shown once), or with the back-office key (`POST /v1/admin/platform-admins`).
- **Roles:** `owner` can change things; `support` is read-only.
- **Overview:** users and companies (new in 7 and 30 days), subscriptions by status and paying plans, revenue (paid invoices, last 30 days and all time, excluding and including GST), consultants awaiting verification.
- **Consultants:** list by status, verify, reject (a reason is required and the consultant sees it) or reopen; flags a registered name that differs from the account holder's.
- **Companies:** search by name, GSTIN or owner email, with paging; a detail view with people, plan, trial or paid-until date, invoices and record **counts** (never the records themselves). Actions, each with a mandatory reason: **suspend / reactivate** (the company is locked out of the portal immediately, a consultant's client companies with their home company), **extend a trial** (1 to 90 days), **grant a complimentary plan** (1 to 366 days, for the right kind of account; no invoice is raised).
- **Billing:** paid invoices across the platform and the number of checkouts waiting for payment. **Audit log:** every change, with who, when, before and after and the reason; sign-ins are logged and hidden by default. **Staff:** list, switch off or on, change your own password.
- **Deliberately not built:** signing in as a customer (impersonation), viewing or editing a company's books, refunds and payment-gateway actions, two-factor sign-in (recommended before a public launch), IP allow-listing (put `/platform` behind your VPN or proxy rules in production), and creating or deleting admins from the console.
- **Scale note:** the overview computes subscription statuses in application code from all subscriptions: fine for thousands of accounts, worth moving to SQL beyond that.
- **Demo logins (local only, `npm run seed:users`):** `platform@ibmp.in` (owner) and `support@ibmp.in` (read-only), password `platform-demo-123`.

## v1.10 - Analytical dashboards, new design system, production polish
- **Design system** (`apps/web/src/styles.css`, `apps/web/src/ui/`): design tokens, an icon set and charts drawn as plain SVG (no charting library), so the whole UI adds a few kilobytes. Every existing screen picks up the new typography, forms, tables and buttons; the shell has a grouped sidebar, top bar with plan status, and an off-canvas menu on phones. The platform console uses the same system in a rose and amber key so it is never mistaken for the business portal.
- **Business dashboard** (`GET /v1/analytics`, `routes/analytics.js`): KPI cards for sales, purchases, collections and net GST, each compared with the **same days of the previous month** (a month in progress is never judged against a whole one) and a trend line; a 6, 12 or 24 month chart of sales, purchases and collections; cash and bank from the ledger with a collection-rate meter; receivables and payables ageing; invoice status; top customers and items; where the money went; GST position (output tax, input credit and net, including months where credit exceeds tax); compliance health and quick actions.
- **Other dashboards:** the platform overview (revenue and sign-up trends, subscription mix, plans, consultant pipeline, items needing attention, an MRR estimate at list price); the compliance calendar (health ring, where you are behind, the next 30 days); the consultant practice overview (totals and deadlines by client).
- **Performance:** screens are loaded on demand (the first download is about 34 KB of application code plus a separately cached React chunk, down from one 377 KB bundle; the platform console is its own chunk), and migration `019` adds 38 indexes for the queries the app actually runs (every table is filtered by company, most by date; child rows by parent).
- **Resilience:** an error boundary per screen, loading skeletons, empty states, clear messages when the server cannot be reached or fails (with a reference to quote), `Cache-Control: no-store` on all API responses, and the version in `GET /v1/health`.
- **Accessibility:** visible focus rings, labelled controls, `aria-current` on navigation, charts with text alternatives, reduced-motion support. Not audited with an assistive-technology tool.
- **Design QA tool:** `node tools/screenshot.mjs <path> <out.png> [--email e] [--click "Nav text"] [--w 390] [--full] [--anon]` signs in and screenshots the running portal in headless Chrome (on Windows Git Bash set `MSYS_NO_PATHCONV=1`).
- **Demo data:** `node apps/api/scripts/seed-history.js` (run with the portal up) gives `owner@ibmp.in` twelve months of varied activity so the charts have something to show.
- **Not done:** a dark theme; the data-entry screens (payroll, TDS, e-invoice and so on) have the new look but not new layouts; no automated browser tests.

## v1.11 - Data-entry screens redesigned, full-width layout
- **Shared building blocks** (`apps/web/src/ui/forms.jsx`): a slide-over **drawer** (rendered on `<body>`, closes on Escape or the scrim, returns focus, prints on its own), labelled **fields**, a table **toolbar** (search plus filter chips with counts), **paging**, status badges and a `useTable` hook. New records, payments, returns, payslips and statements open in drawers over the list instead of stacked inline forms.
- **Screens rebuilt:** Invoices and Purchases (one shared `DocList`: summary cards with trend lines and a like-for-like month comparison, search, status filters, balance due, a new-document drawer with a live GST estimate and stock warnings, payment and return drawers), Parties (what is missing for e-invoices and TDS), Items (stock value, low and out-of-stock), Returns (credit and debit notes, GST effect, printable note), Ledger (account totals by type, journal with a balance check, trial balance status, party statements), Payroll (trend chart, year-to-date totals excluding drafts, run view with cost to company, payslip and employee drawers), Leave (summary and an apply drawer), GST reports (summary cards, how the tax is paid), e-invoice (status counts). The remaining screens (GST filing, attendance, PF and ESI, TDS, billing) have the new header and styling.
- **Space:** the 1480 px page cap is gone, so content fills the screen; the sidebar can fold to icons (remembered per browser); dashboards use a 12-column grid (four panels per row on wide screens, two on laptops, one on phones); KPI cards adapt to their own width with a container query; legends sit in the panel header.
- **Fixed:** the form drawer could not be a plain `<aside>` (the sidebar's styles leaked into it) and, inside an animated page, a fixed panel is sized to the page, so drawers render in a portal.
- **Not done:** attendance, GST filing, PF and ESI and the TDS screens keep their existing layouts under the new styling; no dark theme.

## v1.12 - Invoice module: create screen with preview, GST tax invoice, search and filters
- **Create invoice** (`InvoiceNew`) is its own screen: customer (with a quick "New customer" drawer), invoice and due date (the due date follows your usual credit period), buyer's reference/PO, place-of-supply override, item cards with description, rate, discount % and stock warnings, a different delivery address, notes. Beside the form is the invoice exactly as it will print, updating as you type; the preview maths is the server's (`computeInvoice`), and a test compares the two on 300 random invoices. "Save and add another" and "Duplicate" are supported.
- **Invoice view** (`InvoiceView`): the document, payment summary and balance, print one copy or all three (Original for Recipient, Duplicate for Transporter, Triplicate for Supplier; Save as PDF from the print dialog), record a receipt, return, duplicate, e-invoice link.
- **Tax invoice** (`InvoiceDocument`): rule 46 fields (supplier and recipient with GSTIN and state, serial number and date, HSN/SAC, description, quantity and unit, discount, taxable value, rate and amount of CGST/SGST/IGST per line, place of supply, reverse-charge statement, total in words, signature), tax summary by HSN and rate, bank details and a pay-by-UPI QR on unpaid invoices, terms, e-invoice IRN and QR, e-way bill, and a Bill of Supply when nothing on it is taxable. Business details are edited in **Invoice settings**.
- **List**: search, status chips, an Overdue chip, period (this month, last month, quarter, financial year, custom), customer, sort, due date with days overdue, CSV export; a row opens the invoice. Purchases keep their drawer.
- **Data**: migration 020 (due date, reference, notes, delivery address, per-line discount and tax, bank/UPI/terms/signatory/credit days); header totals and ledger figures are unchanged.
- **Not done:** reverse charge (printed as "No"), invoice numbering per financial year, no URL routing (refreshing returns to the dashboard).

## Next
A real GSP adapter. **Blocked on the provider:** Masters India's public docs lack response formats, the OTP/EVC session flow and the e-invoice and e-way bill endpoints, and Tera publishes none. It needs the full API documentation and sandbox credentials (see `apps/api/src/gsp.js` for the interface to implement).
