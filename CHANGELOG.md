# Changelog

Versions follow semantic versioning. Feature history before 1.5.0 is in README.md (v0.2 to v1.5).

## 1.7.1
- `npm run test:pg` runs the whole suite against a real PostgreSQL 18, plus real-database-only tests (concurrent migrations, rollback, constraints).

## 1.7.0
- Compliance reminders by email (SMTP) and WhatsApp (Cloud API): per-company recipients and timing, daily job, message log, test sends, simulators for development.

## 1.6.0
- TDS on non-salary payments and Form 26Q: deductions from bills and vendor payments, challans, statement data and exports, filing record with quarter lock, ledger posting, compliance calendar items. Vendor PAN.

## 1.5.0
- Production packaging: validated configuration that refuses unsafe settings, security headers, rate limiting, request ids and JSON logs, `/v1/ready`, graceful shutdown, advisory-locked migrations, same-origin web serving, Dockerfile and compose stack.
- Naming standards: `apps/` and `docs/` layout, `@ibmp/*` packages, `IBMP_`-prefixed environment variables, camelCase JSON API.
