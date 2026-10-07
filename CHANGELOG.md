# Changelog

Versions follow semantic versioning. Feature history before 1.5.0 is in README.md (v0.2 to v1.5).

## 1.19.1
- Docker re-verified at 1.19.0 (build, 26 migrations, health, headers, 404 for a missing file, data across a restart, rate limiting, weak-secret refusal, 103-screen browser smoke test). `docker-compose.yml`: `IBMP_HOST_PORT` and `IBMP_VERSION` can be set, and the Google and LinkedIn variables are passed through; the image tag was stale at 1.11.0.

## 1.19.0
- New screen **Sign-in and security** (Account menu): change or set a password, see the Google and LinkedIn accounts linked to your login and unlink them. A person who signed up with Google or LinkedIn has no password until they set one, and cannot unlink their only way in. Migration 026.
- Additional charges on an invoice take an optional SAC code (default 9965).

## 1.18.0
- Reverse charge on purchases: tick "Reverse charge" on a vendor bill when the vendor has not charged GST and the law makes you pay it. The vendor is owed only the taxable value; the tax is booked as your liability and as your input credit. GSTR-3B shows it in 3.1(d) and 4(A)(3) (and in the portal file as `isup_rev` and ISRC), and it is payable in cash, never from credit, though the credit it creates can be set against ordinary output tax. Such bills carry an RCM tag and cannot be returned from the screen (a return changes the tax you assessed: use a manual journal). Migration 025.

## 1.17.0
- Additional charges (freight, packing, insurance...): add up to five on the create screen. They are part of the value of the supply, so GST is charged at the highest rate on the invoice and they are not discounted. They print as lines (SAC 9965 unless you give one through the API), appear in the tax summary, GSTR-1 and the ledger, and do not touch stock.

## 1.16.0
- Discount on the whole invoice: one percentage on the create screen, taken off every item (after its own discount) before GST, so each item is still taxed at its own rate; the printed invoice shows each line's combined discount and "Total discount (incl. 10% on the invoice)". Migration 024.

## 1.15.0
- Invoice numbering: choose in Invoice settings between continuous numbers (INV-0001, the default and unchanged) and numbers that restart every 1 April (INV/26-27/0001), with your own prefix of up to 5 characters. Each financial year has its own counter, started from the invoices already issued in it; every number is unique and at most 16 characters (rule 46). Migration 023.

## 1.14.3
- Fixed "This screen hit a problem" when opening a screen after a new version had been released (or the server restarted on a rebuild): the open tab asked for screen files that no longer existed, and the server answered with the home page instead of a 404. Screens now retry once and the page reloads itself onto the new version (the address keeps you on the same screen); a missing file is a real 404; the error screen offers a reload and shows a short detail for support. `node tools/stale-tab-test.mjs` reproduces the scenario; the smoke test now also covers a brand-new empty account and rapid clicking through the menu.

## 1.14.2
- The subscription notice (free trial, renewal, expiry, plan required) moved from a band above every page into the top-right header, with its action button beside it; the duplicate plan pill is gone.

## 1.14.1
- The screen is kept in the address (`#/invoice?id=12`), so refresh, the back and forward buttons and a copied link work; the smoke test checks it. Business types: 24 to choose from.

## 1.14.0
- Invoice template, following the field set of Tally's free invoice generator: company logo (upload in Invoice settings, resized to fit 320 x 160), mode / terms of payment, buyer's ref. / order no., other references, dispatched through and destination, all on the create screen and printed in the header block. Migration 022.

## 1.13.0
- Sign in and sign up with Google and LinkedIn (OpenID Connect, authorization-code flow on the server). A button shows only when its `IBMP_GOOGLE_CLIENT_ID`/`_SECRET` or `IBMP_LINKEDIN_CLIENT_ID`/`_SECRET` are set. Existing accounts are matched by the provider's verified email; first-time users give their company details and start the trial. Migration 021 (`user_identities`).

## 1.12.0
- Invoices: create an invoice on its own full screen with a live A4 preview; an invoice view screen (print one copy or all three, record a receipt, return, duplicate); a professional GST tax invoice (rule 46: supplier/recipient GSTIN and state, place of supply, HSN/SAC, per-line discount and CGST/SGST/IGST, tax summary by HSN and rate, total in words, bank details and UPI QR, terms, signatory, e-invoice IRN/QR, e-way bill, Bill of Supply when nothing is taxable).
- Invoice list: search plus status, overdue, period, customer and sort filters, due-date column, CSV export.
- Due date and credit period, buyer reference/PO, delivery address, notes, place-of-supply override; invoice settings (bank, UPI, terms, signatory). Migration 020.

## 1.11.0
- Data-entry screens redesigned with drawers, summary cards, search and filters (invoices, purchases, parties, items, returns, ledger, payroll, leave, GST reports, e-invoice); full-width layout, collapsible sidebar, 12-column dashboard grid; the UI smoke test now covers 58 views including drawers.

## 1.10.2
- Verified the Docker image and compose stack end to end (build, health, migrations, security headers, rate limiting, graceful shutdown, persistence, unsafe-config refusal, UI smoke test against the container).

## 1.10.1
- `npm run smoke:ui`: automated browser smoke test of every screen for every role.

## 1.10.0
- New design system and analytical dashboards (business, platform, compliance, practice); `GET /v1/analytics`; lazy-loaded screens; 38 database indexes; error boundaries, offline and server-error messages; `no-store` on API responses; version in the health check.
- Fixed: the compliance "Due soon" filter count was blank after the camelCase change.

## 1.9.0
- Platform owner console at `/platform`: separate sign-in, overview, consultant verification, company directory with suspend, trial extension and complimentary plans, billing view, audit log, staff management. Company suspension locks a company out of the portal.

## 1.8.0
- SMS reminders (Twilio adapter, DLT-template-based wording, simulator), third channel in Compliance > Reminders.

## 1.7.1
- `npm run test:pg` runs the whole suite against a real PostgreSQL 18, plus real-database-only tests (concurrent migrations, rollback, constraints).

## 1.7.0
- Compliance reminders by email (SMTP) and WhatsApp (Cloud API): per-company recipients and timing, daily job, message log, test sends, simulators for development.

## 1.6.0
- TDS on non-salary payments and Form 26Q: deductions from bills and vendor payments, challans, statement data and exports, filing record with quarter lock, ledger posting, compliance calendar items. Vendor PAN.

## 1.5.0
- Production packaging: validated configuration that refuses unsafe settings, security headers, rate limiting, request ids and JSON logs, `/v1/ready`, graceful shutdown, advisory-locked migrations, same-origin web serving, Dockerfile and compose stack.
- Naming standards: `apps/` and `docs/` layout, `@ibmp/*` packages, `IBMP_`-prefixed environment variables, camelCase JSON API.
