# IBMP — Project Context & Handover

*Exported 6 Oct 2026 from the original "IBMP" Claude project. Upload this file to the new project first, because it tells Claude where things stand.*

## About IBMP

- **IBMP (Integrated Business Management Platform)** is a cloud-native, GST-integrated SaaS for Indian SMEs. It covers six sectors: retail, trading, service, wholesale, hospital and pharmacy.
- It is being built as a separate company, distinct from the Kusalava group. Target go-live: **31 December 2026**.
- **Planned stack:**
  - Mobile: React Native
  - Web: React.js
  - Backend: Node.js
  - Database: PostgreSQL
  - Hosting: AWS ap-south-1
  - API base: `https://api.ibmp.in/v1`
- **GST integration:** a GST Suvidha Provider (GSP), Masters India or Tera Software, for GSTR-1, GSTR-3B, e-Invoice and e-Way Bill.
- **Subscription tiers:** Free Trial / Starter ₹999 per month / Professional ₹2,499 per month / Enterprise ₹4,999 per month.
- **User categories:**
  - Individual: one user, one company.
  - Consultant: several companies in one login, priced by slabs of 0–5 and 5–10 companies.
  - Enterprise: employee logins.
  - Professionals are verified against ICSI, ICAI or ICMAI membership.
- **Product requirements:**
  - A dynamic web portal plus Android and iOS apps.
  - GSTIN auto-fetch and GST return filing.
  - Payment gateway and subscription controls.
  - Invoice sharing by WhatsApp and email.
- **Foundation documents** (from earlier work; not in this export unless added separately):
  - PRD (21 pages)
  - Database Schema (33 pages)
  - REST API Specification (34 pages)
  - Compliance Calendar Rules Engine (19 pages)
  - GST Logic Document (19 pages)

## Current state of the prototype

| File | Status |
|---|---|
| `IBMP_App_v6.0_BASELINE_LOCKED.html` | **Locked baseline. Never edit it.** SHA-256 `e48e320a…955db` |
| `IBMP_App_v6.1.html` | v6.0 plus Sales Return (Credit Note) and Purchase Return (Debit Note) |
| `IBMP_App_v6.2.html` | **Current working version.** v6.1 plus fixes for 3 bugs found in v6.0. SHA-256 `085226b2…14c6a` |

The full change log, design rules and known issues are in `IBMP_BASELINE_LOCK.md`.

## Standing rules (owner's instruction)

> "Lock this existing developed project. Whatever we enhance hereafter, this copy should not get any error. There shouldn't be any error in the existing project due to enhancement at any stage."

1. Never edit a released version. Each enhancement goes into the next version number (v6.3, v6.4, …).
2. Changes are additive. Existing function names, element IDs and tabs are never removed or renamed.
3. New code uses its own prefix, e.g. `rtn_` for the returns module.
4. If an existing function has to change, wrap it so the original still runs first, unchanged.
5. Before any version is delivered, it must pass `regression_check.js` against the latest baseline JSON (currently `baseline_v6.2.json`), with zero new errors. It must also pass a functional test of the new feature.
6. Pre-existing bugs found along the way are reported to the owner and only fixed when the owner approves.

## Open items / next candidates

- **Capital Asset / Expense purchase mode isn't built.** In that mode the vendor and date fields are hidden, and saving still records goods lines only.
- **Receipt and Payment windows:** they sit inside the Payments tab. They work there, but must be moved to `<body>` before any feature opens them from another tab.
- **No persistent storage yet.** All data is in memory and resets on reload.

## Suggested custom instructions for the new project

Paste into the new project's "Instructions" box:

```
This project is IBMP (Integrated Business Management Platform), a GST-integrated SaaS for Indian SMEs.
Read 00_PROJECT_CONTEXT.md and IBMP_BASELINE_LOCK.md before any work.
The latest working app is IBMP_App_v6.2.html. IBMP_App_v6.0_BASELINE_LOCKED.html is frozen and must never be edited.
Every enhancement goes into a new version number. Changes are additive: never rename or remove existing functions, element IDs or tabs; prefix new code; wrap rather than rewrite existing functions.
Before delivering any version, run regression_check.js against the latest baseline JSON and a functional test of the new feature, using headless Chromium (Playwright). Deliver only versions with zero new errors, and update the version log in IBMP_BASELINE_LOCK.md.
Report pre-existing bugs; fix them only when I approve.
```
