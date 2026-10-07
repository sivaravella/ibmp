# IBMP — Baseline Lock (v6.0)

**Locked on:** 1 Oct 2026
**Locked file:** `IBMP_App_v6.0_BASELINE_LOCKED.html` (source upload: `IBMP_App_v6.0 18.html`)
**SHA-256:** `e48e320adf818af3abc8aa1655843282abe7fb9a7cff68417eadf327e56955db`
**Size:** 429,013 bytes

This file is the frozen reference. It is never edited. Every enhancement is made on a new copy (v6.1, v6.2, …) and must pass the regression check against this baseline before it is accepted.

## What the baseline contains (verified in headless Chromium)

- 157 JavaScript functions, 408 element IDs, 15 tabs
- Tabs: dashboard, parties, items, invoice-new, invoices, ledgers, purchases, payments, gst, compliance, reports, tasks, employees, payroll, attendance
- Load + demo data + every tab opens with **0 JavaScript errors**

## Enhancement rules (apply at every stage)

1. **Never edit the locked file.** Copy it to the next version number and work on the copy.
2. **Additive only.** New features add new functions, IDs and tabs. Existing function names, element IDs, tab IDs and the `state` fields already used are not renamed or removed.
3. **No silent changes to existing functions.** If an existing function must change (e.g. `showTab`, `goTo`, `loadDemo`), the change is a guarded addition — new behaviour only runs for new inputs, old inputs behave exactly as before.
4. **Namespacing for new code.** New functions/IDs use a clear prefix per module (e.g. `hr2_…`, `inv2_…`) so they cannot collide with existing names.
5. **Regression gate.** Every new version is run through `regression_check.js`. It fails if any baseline function, ID or tab disappears, any handler points to a missing function, any tab that worked now throws, or any new JS error appears. Only a PASS version is delivered.
6. **Rollback is always available.** If anything goes wrong, the locked file is the fallback.

## How to run the check

```
node regression_check.js IBMP_App_v6.1.html --baseline baseline.json
```

(Requires Node + Playwright. Claude runs this automatically before handing over any enhanced version.)

## Known pre-existing items (not regressions)

- The checker flags three words inside handler text — `Investment`, `Products`, `Vehicles` — as "missing functions". These are label text inside the existing handlers (e.g. "Vehicles (" ), not real calls. They are recorded in the baseline and ignored.
- pdf.js loads from cdnjs; offline it simply won't load, and the baseline does not depend on it.

## Version log

| Version | Date | Change | Regression check | SHA-256 |
|---|---|---|---|---|
| v6.0 | 1 Oct 2026 | Locked baseline | — | `e48e320a…955db` |
| v6.1 | 1 Oct 2026 | Sales Return (Credit Note) in All Invoices; Purchase Return (Debit Note) in Purchases | PASS vs v6.0 (0 errors) | `42c921e4…818fe` |
| v6.2 | 1 Oct 2026 | Fixed 3 v6.0 bugs: trapped pop-ups, duplicate purchase row, purchase GST | PASS vs v6.0 and v6.1 (0 errors) | `085226b2…14c6a` |

### v6.1 — what was added (module `rtn_`, appended before `</body>`, no baseline markup edited)
- "↩ Sales Return" / "↩ Purchase Return" buttons in the tab headers, plus a credit or debit note register under each table.
- Return window: customer/vendor → that party's invoices/bills → item-wise return qty (partial or Full Return), reason, return type (goods / value only), live accounting preview.
- On submit: journal (Dr Sales Returns + Output GST / Cr Debtors; Dr Creditors / Cr Purchase Returns + Input GST), stock ±, outstanding reduced, invoice/bill status, CN/DN numbering (CN-0001, DN-0001), GST tab summary, ledger balances panel under Chart of Accounts, printable note via the existing share window.
- Guards: return qty ≤ balance qty; note value ≤ returnable balance; note date ≥ document date; fully returned documents can't be selected.
- Wrapped (original runs first, unchanged): `confirmSaveInvoice`, `savePurchase` (to remember line items), `renderLedgerTree` (to append the balance panel).
- Invoices/bills created before v6.1 have no stored line items: the user adds the returned items manually, or uses Full Return (value reversal).
- From v6.2 onward, check against `baseline_v6.1.json` (a superset of v6.0).

### v6.2 — fixes (build: `build_v62.py` = locked v6.0 + 3 fixes + returns module)
1. **Trapped pop-ups.** A malformed tag (`<div       </div><!-- /pur-goods-section -->`) left 2 `<div>`s open, so quick-add, employee, payslip, purchase-scan, note-share and both old return windows sat inside the hidden purchase window. Fixed by correcting the tag. Also added padding to the purchase window, scoped to that window only (its `.modal-body` style was never defined).
2. **Duplicate purchase row.** `savePurchase` added two rows per bill. The first, duplicate row was removed; the remaining row shows "✓ Stock updated" plus the payment note. The empty-table colspan was corrected from 6 to 7.
3. **Purchase GST.** Bills now use the GST rate selected in the window. Line values are taxable (excl. GST) and GST is added on top, matching the window's "Total Value + ITC (GST)" display. Journal: Dr Purchases (taxable) + Dr Input GST Credit / Cr Sundry Creditors (total). Each bill stores `gstPct` and `gstMode:'exclusive'`. Purchase returns on v6.2 bills use the same basis; bills recorded under v6.1 keep the old inclusive split so their returns still tie back.
- Verified: e.g. 10 × ₹500 at 12% → taxable ₹5,000, GST ₹600, total ₹5,600, one table row; return of 4 → ₹2,000 + ₹240 = ₹2,240, stock −4.
- Not a bug: the receipt and payment windows sit inside the Payments tab and only show while that tab is open. All their buttons are on that tab, so they work. If a future feature opens them from another tab, they must be moved to `<body>` first.
- Known, not fixed: in "Capital Asset / Expense" purchase mode, the vendor/date fields are hidden and saving still records goods lines only. Asset purchase saving is not implemented.
- From v6.3 onward, check against `baseline_v6.2.json`.

### Pre-existing issues found in v6.0 (all three fixed in v6.2)
- An unclosed `<div>` traps 7 pop-ups inside the hidden purchase window, so they never appear: quick-add, employee, payslip, old sales-return, old purchase-return, purchase-scan, and note-share. v6.1 lifts only the note-share window, which it needs.
- Saving a purchase bill adds two rows to the Purchases table for the same bill.
- Purchase bills are posted as GST-inclusive at a flat 18%, whatever GST rate is selected. Purchase returns follow the same split so they tie back to the bill.
