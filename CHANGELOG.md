# Changelog

Versions follow semantic versioning. Feature history before 1.5.0 is in README.md (v0.2 to v1.5).

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
