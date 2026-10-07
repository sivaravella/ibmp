import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { fyOf, parseFy } from '../compliance.js';
import { BSR_RE, CHALLAN_SERIAL_RE, TOKEN_RE, quarterOf, tdsDueDate, toCsv } from '../tds.js';
import { settle } from '../payments.js';
import { A, post } from '../ledger.js';
import { CSV_26Q, RATES_VERIFIED, SECTIONS, build26q, computeDeduction, deducteeType, partyPan, standardRate } from '../tdsns.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const code = (err, c) => Object.assign(err, { code: c });
const section = z.enum(Object.keys(SECTIONS));
const EXPENSE_ACCOUNT = { '94A': A.INTEREST_EXP, '94C': A.CONTRACT_EXP, '94H': A.COMMISSION_EXP, '94IA': A.RENT_EXP, '94IB': A.RENT_EXP, '94JA': A.PROF_FEES_EXP, '94JB': A.PROF_FEES_EXP };
const fixDeduction = (d) => ({ ...d, date: ymd(d.date), base: Number(d.base), taxed_base: Number(d.taxed_base), rate: Number(d.rate), tds: Number(d.tds), gst: Number(d.gst) });

/**
 * TDS on payments other than salary: deductions from vendor bills and direct expense payments, the monthly challans, and Form 26Q.
 * Every deduction and challan posts to the ledger (TDS Payable (non-salary), account 2250).
 */
export function tdsNsRoutes(pool) {
  const r = Router();
  const needOwner = (req) => { if (req.user.role !== 'owner') throw code(httpError(403, 'Only the account owner can change TDS records.'), 'OWNER_ONLY'); };
  const fyParam = (req) => {
    const fy = req.query.fy ?? fyOf(todayFn());
    if (parseFy(fy) === null) throw httpError(400, 'fy must look like 2026-27');
    return fy;
  };
  const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
  const fyRange = (fy) => [`${parseFy(fy)}-04-01`, `${parseFy(fy) + 1}-03-31`];
  const company = async (q, cid) => (await q.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];

  /** A quarter whose statement is recorded as filed is closed: deductions and challans in it can no longer change. */
  async function assertQuarterOpen(q, cid, date, what) {
    const fy = fyOf(date), quarter = quarterOf(date.slice(0, 7));
    const s = (await q.query('SELECT token_no FROM tds26_statements WHERE company_id=$1 AND fy=$2 AND quarter=$3', [cid, fy, quarter])).rows[0];
    if (s) throw code(httpError(409, `The 26Q statement for ${fy} Q${quarter} is recorded as filed (token ${s.token_no}), so the ${what} cannot change. Remove the filing record first if it was entered by mistake.`), 'PERIOD_LOCKED');
  }

  const loadVendor = async (q, cid, id) => {
    const p = (await q.query("SELECT * FROM parties WHERE id=$1 AND company_id=$2 AND type='vendor'", [id, cid])).rows[0];
    if (!p) throw httpError(400, 'Unknown vendor');
    return p;
  };

  async function prior(q, cid, partyId, sec, fy) {
    const [from, to] = fyRange(fy);
    const x = (await q.query(
      `SELECT COALESCE(SUM(base),0) AS base, COALESCE(SUM(taxed_base),0) AS taxed FROM tds_deductions
       WHERE company_id=$1 AND party_id=$2 AND section=$3 AND status='active' AND date >= $4 AND date <= $5`, [cid, partyId, sec, from, to])).rows[0];
    return { base: Number(x.base), taxedBase: Number(x.taxed) };
  }

  const quoteFor = async (q, cid, { partyId, section: sec, amount, date, rateOverride }) => {
    const party = await loadVendor(q, cid, partyId);
    const pan = partyPan(party);
    const pr = await prior(q, cid, party.id, sec, fyOf(date));
    const c = computeDeduction({ section: sec, pan, prior: pr, payment: amount, rateOverride: rateOverride ?? null });
    return { party, pan, prior: pr, calc: c };
  };

  // ---------- reference data ----------

  r.get('/tds/ns/sections', h(async (_req, res) => {
    res.json({
      ratesVerified: RATES_VERIFIED,
      warning: 'These rates and limits are a starting point, not authority: confirm them for the current year before relying on them.',
      sections: Object.entries(SECTIONS).map(([k, s]) => ({ code: k, section: s.section, label: s.label, rate: s.rate, single: s.single ?? null, annual: s.annual ?? null, note: s.note ?? null, billOnly: k === '94Q' })),
    });
  }));

  r.post('/tds/ns/quote', h(async (req, res) => {
    const b = z.object({ partyId: z.number().int(), section, amount: z.number().positive(), date: isoDate, rateOverride: z.number().min(0).max(100).optional() }).parse(req.body);
    const { pan, prior: pr, calc } = await quoteFor(pool, req.user.companyId, b);
    res.json({ ...calc, pan, standardRate: standardRate(b.section, pan), prior: pr });
  }));

  // ---------- deductions ----------

  async function insertDeduction(q, row) {
    return (await q.query(
      `INSERT INTO tds_deductions (company_id, party_id, section, kind, purchase_id, date, base, taxed_base, rate, rate_reason, tds, cert_ref, expense_account_id, mode, narration, journal_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [row.cid, row.partyId, row.section, row.kind, row.purchaseId ?? null, row.date, row.base, row.calc.taxed_base, row.calc.rate, row.calc.rate_reason, row.calc.tds, row.certRef ?? null,
        row.expenseAccountId ?? null, row.mode ?? null, row.narration ?? null, row.entryId ?? null])).rows[0];
  }

  // Deduct from a vendor bill: the vendor is now owed the bill less the TDS, and the TDS is owed to the government.
  r.post('/tds/ns/bills', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ purchaseId: z.number().int(), section, rateOverride: z.number().min(0).max(100).optional(), certRef: z.string().max(40).optional() }).parse(req.body);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bill = (await client.query('SELECT * FROM purchases WHERE id=$1 AND company_id=$2', [b.purchaseId, cid])).rows[0];
      if (!bill) throw httpError(404, 'Bill not found');
      const date = ymd(bill.date);
      await assertQuarterOpen(client, cid, date, 'deduction');
      if ((await client.query("SELECT 1 FROM tds_deductions WHERE purchase_id=$1 AND status='active'", [bill.id])).rowCount) throw httpError(409, 'TDS is already deducted on this bill. Reverse that deduction first to change it.');
      const base = Number(bill.taxable);
      const { party, calc } = await quoteFor(client, cid, { partyId: bill.party_id, section: b.section, amount: base, date, rateOverride: b.rateOverride });
      if (calc.tds > Number(bill.total) - Number(bill.returned) - Number(bill.paid) + 0.001)
        throw httpError(409, `The TDS of ₹${calc.tds} is more than the ₹${(Number(bill.total) - Number(bill.returned) - Number(bill.paid)).toFixed(2)} still unpaid on this bill. TDS has to come out of the payment: deduct before paying in full.`);
      let entryId = null;
      if (calc.tds > 0) {
        entryId = await post(client, { companyId: cid, date, sourceType: 'tds_deduction', sourceId: bill.id, narration: `TDS ${SECTIONS[b.section].section} deducted on ${bill.number}`,
          lines: [{ code: A.CREDITORS, debit: calc.tds, partyId: party.id }, { code: A.TDS_NS_PAYABLE, credit: calc.tds }] });
        const tds = Number(bill.tds) + calc.tds;
        await client.query('UPDATE purchases SET tds=$1, status=$2 WHERE id=$3', [tds, settle(bill.total, bill.paid, Number(bill.returned) + tds), bill.id]);
      }
      const row = await insertDeduction(client, { cid, partyId: party.id, section: b.section, kind: 'bill', purchaseId: bill.id, date, base, calc, certRef: b.certRef, entryId });
      await client.query('COMMIT');
      res.status(201).json({ ...fixDeduction(row), thresholdCrossed: calc.threshold_crossed, catchUp: calc.catch_up });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));

  // Pay a vendor directly (rent, professional fees, commission, ...): the expense, the payment and the TDS in one entry.
  r.post('/tds/ns/expenses', h(async (req, res) => {
    needOwner(req);
    const b = z.object({
      partyId: z.number().int(), section, date: isoDate, amount: z.number().positive().max(1e10), mode: z.enum(['cash', 'bank']).default('bank'),
      rateOverride: z.number().min(0).max(100).optional(), certRef: z.string().max(40).optional(), narration: z.string().max(200).optional(),
    }).parse(req.body);
    if (!EXPENSE_ACCOUNT[b.section]) throw httpError(400, `${SECTIONS[b.section].section} applies to purchases of goods: deduct it from the vendor bill instead.`);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertQuarterOpen(client, cid, b.date, 'deduction');
      const { party, calc } = await quoteFor(client, cid, { partyId: b.partyId, section: b.section, amount: b.amount, date: b.date, rateOverride: b.rateOverride });
      const entryId = await post(client, {
        companyId: cid, date: b.date, sourceType: 'tds_expense', sourceId: party.id,
        narration: b.narration || `${SECTIONS[b.section].label}: ${party.name}`,
        lines: [{ code: EXPENSE_ACCOUNT[b.section], debit: b.amount, partyId: party.id }, { code: b.mode === 'bank' ? A.BANK : A.CASH, credit: b.amount - calc.tds }, { code: A.TDS_NS_PAYABLE, credit: calc.tds }],
      });
      const row = await insertDeduction(client, { cid, partyId: party.id, section: b.section, kind: 'expense', date: b.date, base: b.amount, calc, certRef: b.certRef, mode: b.mode, narration: b.narration, entryId });
      await client.query('COMMIT');
      res.status(201).json({ ...fixDeduction(row), thresholdCrossed: calc.threshold_crossed, catchUp: calc.catch_up, paidToVendor: b.amount - calc.tds });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));

  /** Post the opposite of a journal entry. */
  async function reverseEntry(q, cid, entryId, date, narration, sourceType, sourceId) {
    const lines = (await q.query('SELECT account_id, party_id, debit, credit FROM journal_lines WHERE entry_id=$1', [entryId])).rows;
    return post(q, { companyId: cid, date, narration, sourceType, sourceId, lines: lines.map((l) => ({ accountId: l.account_id, partyId: l.party_id, debit: Number(l.credit), credit: Number(l.debit) })) });
  }

  r.delete('/tds/ns/deductions/:id', h(async (req, res) => {
    needOwner(req);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const d = (await client.query("SELECT * FROM tds_deductions WHERE id=$1 AND company_id=$2 AND status='active'", [req.params.id, cid])).rows[0];
      if (!d) throw httpError(404, 'Not found');
      const date = ymd(d.date);
      await assertQuarterOpen(client, cid, date, 'deduction');
      const type = deducteeType(partyPan((await client.query('SELECT * FROM parties WHERE id=$1', [d.party_id])).rows[0]));
      if ((await client.query('SELECT 1 FROM tds_ns_challans WHERE company_id=$1 AND month=$2 AND deductee_type=$3', [cid, date.slice(0, 7), type])).rowCount)
        throw code(httpError(409, 'The TDS for this month has been deposited with a challan. Remove the challan first.'), 'CHALLAN_EXISTS');
      const later = await client.query("SELECT 1 FROM tds_deductions WHERE company_id=$1 AND party_id=$2 AND section=$3 AND status='active' AND id > $4 AND date >= $5 AND date <= $6",
        [cid, d.party_id, d.section, d.id, ...fyRange(fyOf(date))]);
      if (later.rowCount) throw httpError(409, 'Later deductions for this vendor and section build on this one (yearly limits). Reverse the later ones first.');
      if (d.journal_entry_id) await reverseEntry(client, cid, d.journal_entry_id, date, `Reversal of TDS deduction ${d.id}`, 'tds_reversal', d.id);
      if (d.kind === 'bill') {
        const bill = (await client.query('SELECT * FROM purchases WHERE id=$1', [d.purchase_id])).rows[0];
        const tds = Math.max(0, Number(bill.tds) - Number(d.tds));
        await client.query('UPDATE purchases SET tds=$1, status=$2 WHERE id=$3', [tds, settle(bill.total, bill.paid, Number(bill.returned) + tds), bill.id]);
      }
      await client.query("UPDATE tds_deductions SET status='reversed' WHERE id=$1", [d.id]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));

  const listDeductions = async (cid, fy, quarter) => {
    const [from, to] = fyRange(fy);
    const rows = (await pool.query(
      `SELECT d.*, p.name AS party_name, p.pan AS party_pan, p.gstin AS party_gstin FROM tds_deductions d JOIN parties p ON p.id=d.party_id
       WHERE d.company_id=$1 AND d.date >= $2 AND d.date <= $3 ORDER BY d.date, d.id`, [cid, from, to])).rows.map(fixDeduction);
    const out = rows.map((d) => ({ ...d, pan: partyPan({ pan: d.party_pan, gstin: d.party_gstin }), quarter: quarterOf(d.date.slice(0, 7)) }));
    return quarter ? out.filter((d) => d.quarter === quarter) : out;
  };

  r.get('/tds/ns/deductions', h(async (req, res) => {
    const fy = fyParam(req);
    const quarter = req.query.quarter === undefined ? null : Number(req.query.quarter);
    if (quarter !== null && ![1, 2, 3, 4].includes(quarter)) throw httpError(400, 'quarter must be 1, 2, 3 or 4');
    const rows = await listDeductions(req.user.companyId, fy, quarter);
    res.json({ fy, deductions: rows.map((d) => ({ ...d, sectionName: SECTIONS[d.section].section, deducteeType: deducteeType(d.pan) })) });
  }));

  // Per vendor and section: what was paid, what was taxed, and what was deducted this year.
  r.get('/tds/ns/deductees', h(async (req, res) => {
    const fy = fyParam(req);
    const rows = (await listDeductions(req.user.companyId, fy)).filter((d) => d.status === 'active');
    const by = new Map();
    for (const d of rows) {
      const k = `${d.party_id}|${d.section}`;
      if (!by.has(k)) by.set(k, { partyId: d.party_id, name: d.party_name, pan: d.pan, section: d.section, sectionName: SECTIONS[d.section].section, paid: 0, taxedBase: 0, tds: 0, payments: 0 });
      const x = by.get(k);
      x.paid += d.base; x.taxedBase += d.taxed_base; x.tds += d.tds; x.payments += 1;
    }
    res.json({ fy, deductees: [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.section.localeCompare(b.section)) });
  }));

  // ---------- challans ----------

  const monthTax = async (q, cid, month) => {
    const rows = (await q.query(
      `SELECT d.tds, p.pan, p.gstin FROM tds_deductions d JOIN parties p ON p.id=d.party_id WHERE d.company_id=$1 AND d.status='active' AND d.tds > 0 AND d.date >= $2 AND d.date <= $3`,
      [cid, `${month}-01`, monthEnd(month)])).rows;
    const t = { company: 0, non_company: 0 };
    for (const x of rows) t[deducteeType(partyPan(x))] += Number(x.tds);
    return t;
  };

  // The months with TDS to deposit, and the challan (if recorded) for each.
  r.get('/tds/ns/challans', h(async (req, res) => {
    const fy = fyParam(req), cid = req.user.companyId;
    const ds = (await listDeductions(cid, fy)).filter((d) => d.status === 'active' && d.tds > 0);
    const chs = (await pool.query('SELECT * FROM tds_ns_challans WHERE company_id=$1 AND month >= $2 AND month <= $3', [cid, fyRange(fy)[0].slice(0, 7), fyRange(fy)[1].slice(0, 7)])).rows;
    const groups = new Map();
    for (const d of ds) {
      const type = deducteeType(d.pan), k = `${d.date.slice(0, 7)}|${type}`;
      if (!groups.has(k)) groups.set(k, { month: d.date.slice(0, 7), deducteeType: type, tds: 0 });
      groups.get(k).tds += d.tds;
    }
    const today = todayFn();
    const rows = [...groups.values()].sort((a, b) => a.month.localeCompare(b.month) || a.deducteeType.localeCompare(b.deducteeType)).map((g) => {
      const c = chs.find((x) => x.month === g.month && x.deductee_type === g.deducteeType);
      const due = tdsDueDate(g.month);
      return {
        ...g, quarter: quarterOf(g.month), challanType: g.deducteeType === 'company' ? '0020' : '0021', dueDate: due,
        challan: c ? { id: c.id, bsr: c.bsr, serial: c.serial, depositedOn: ymd(c.deposited_on), tax: Number(c.tax), interest: Number(c.interest), fee: Number(c.fee) } : null,
        late: c ? ymd(c.deposited_on) > due : today > due,
      };
    });
    res.json({ fy, challans: rows });
  }));

  r.post('/tds/ns/challans', h(async (req, res) => {
    needOwner(req);
    const b = z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/), deducteeType: z.enum(['company', 'non_company']), bsr: z.string().regex(BSR_RE, 'BSR code is 7 digits'),
      serial: z.string().regex(CHALLAN_SERIAL_RE, 'Challan serial number is 5 digits'), depositedOn: isoDate,
      interest: z.number().min(0).max(1e9).default(0), fee: z.number().min(0).max(1e9).default(0), mode: z.enum(['cash', 'bank']).default('bank'),
    }).parse(req.body);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertQuarterOpen(client, cid, `${b.month}-01`, 'challan');
      if (b.depositedOn < `${b.month}-01`) throw httpError(400, 'The deposit date cannot be before the month the tax was deducted.');
      const tax = (await monthTax(client, cid, b.month))[b.deducteeType];
      if (!(tax > 0)) throw httpError(400, 'No TDS was deducted for this month and type of deductee, so there is nothing to deposit.');
      if ((await client.query('SELECT 1 FROM tds_ns_challans WHERE company_id=$1 AND month=$2 AND deductee_type=$3', [cid, b.month, b.deducteeType])).rowCount)
        throw httpError(409, 'A challan is already recorded for this month and type of deductee. Remove it first to change it.');
      const entryId = await post(client, {
        companyId: cid, date: b.depositedOn, sourceType: 'tds_challan', sourceId: null, narration: `TDS deposited for ${b.month} (${b.deducteeType === 'company' ? 'company' : 'non-company'} deductees), BSR ${b.bsr} serial ${b.serial}`,
        lines: [{ code: A.TDS_NS_PAYABLE, debit: tax }, { code: A.INT_PEN_EXP, debit: b.interest + b.fee }, { code: b.mode === 'bank' ? A.BANK : A.CASH, credit: tax + b.interest + b.fee }],
      });
      const row = (await client.query(
        `INSERT INTO tds_ns_challans (company_id, month, deductee_type, bsr, serial, deposited_on, tax, interest, fee, journal_entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [cid, b.month, b.deducteeType, b.bsr, b.serial, b.depositedOn, tax, b.interest, b.fee, entryId])).rows[0];
      // The monthly payment item on the compliance calendar is done once the deposit is recorded for both types of deductee.
      const left = (await monthTax(client, cid, b.month));
      const other = b.deducteeType === 'company' ? 'non_company' : 'company';
      const otherDone = !(left[other] > 0) || (await client.query('SELECT 1 FROM tds_ns_challans WHERE company_id=$1 AND month=$2 AND deductee_type=$3', [cid, b.month, other])).rowCount;
      if (otherDone) await setCompliance(client, cid, 'TDS_PAY_NS', b.month, b.depositedOn, `${b.bsr}/${b.serial}`);
      await client.query('COMMIT');
      res.status(201).json({ id: row.id, month: b.month, deducteeType: b.deducteeType, tax, interest: b.interest, fee: b.fee });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));

  r.delete('/tds/ns/challans/:id', h(async (req, res) => {
    needOwner(req);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = (await client.query('SELECT * FROM tds_ns_challans WHERE id=$1 AND company_id=$2', [req.params.id, cid])).rows[0];
      if (!c) throw httpError(404, 'Not found');
      await assertQuarterOpen(client, cid, `${c.month}-01`, 'challan');
      if (c.journal_entry_id) await reverseEntry(client, cid, c.journal_entry_id, ymd(c.deposited_on), `Reversal of TDS challan ${c.bsr}/${c.serial}`, 'tds_challan_reversal', c.id);
      await client.query('DELETE FROM tds_ns_challans WHERE id=$1', [c.id]);
      await setCompliance(client, cid, 'TDS_PAY_NS', c.month, null, null);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));

  async function setCompliance(q, cid, rule, key, completedOn, reference) {
    const cur = (await q.query('SELECT id FROM compliance_records WHERE company_id=$1 AND rule_code=$2 AND period_key=$3', [cid, rule, key])).rows[0];
    if (cur) await q.query('UPDATE compliance_records SET completed_on=$1, reference=$2 WHERE id=$3', [completedOn, reference, cur.id]);
    else if (completedOn) await q.query('INSERT INTO compliance_records (company_id, rule_code, period_key, completed_on, reference) VALUES ($1,$2,$3,$4,$5)', [cid, rule, key, completedOn, reference]);
  }

  // ---------- Form 26Q ----------

  const asOf = (req) => {
    if (req.query.asOf === undefined) return todayFn();
    if (!isoDate.safeParse(req.query.asOf).success) throw httpError(400, 'asOf must be YYYY-MM-DD');
    return req.query.asOf;
  };
  async function statementFor(req) {
    const fy = fyParam(req), quarter = Number(req.query.quarter);
    if (![1, 2, 3, 4].includes(quarter)) throw httpError(400, 'quarter must be 1, 2, 3 or 4');
    const cid = req.user.companyId;
    const deductions = (await listDeductions(cid, fy, quarter)).filter((d) => d.status === 'active' && d.tds > 0);
    const challans = (await pool.query('SELECT * FROM tds_ns_challans WHERE company_id=$1', [cid])).rows.map((c) => ({ ...c, deposited_on: ymd(c.deposited_on), tax: Number(c.tax) }));
    const statements = (await pool.query('SELECT * FROM tds26_statements WHERE company_id=$1 AND fy=$2', [cid, fy])).rows.map((s) => ({ ...s, filed_on: ymd(s.filed_on) }));
    const built = build26q({ company: await company(pool, cid), fy, quarter, deductions, challans, statements, asOf: asOf(req) });
    return { fy, quarter, ...built, recorded: statements.find((s) => s.quarter === quarter) ?? null };
  }

  r.get('/tds/26q', h(async (req, res) => res.json(await statementFor(req))));

  r.get('/tds/26q/export', h(async (req, res) => {
    const part = z.enum(['json', 'challans', 'deductees']).parse(req.query.section ?? 'json');
    const { fy, quarter, statement } = await statementFor(req);
    const base = `26Q_${fy}_Q${quarter}`;
    if (part === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
      return res.type('application/json').send(JSON.stringify(statement, null, 2));
    }
    res.setHeader('Content-Disposition', `attachment; filename="${base}_${part}.csv"`);
    res.type('text/csv').send(toCsv(statement[part], CSV_26Q[part]));
  }));

  r.post('/tds/26q/filed', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ fy: z.string(), quarter: z.number().int().min(1).max(4), tokenNo: z.string().regex(TOKEN_RE, 'The token number is 15 digits'), filedOn: isoDate }).parse(req.body);
    if (parseFy(b.fy) === null) throw httpError(400, 'fy must look like 2026-27');
    const cid = req.user.companyId;
    if ((await pool.query('SELECT 1 FROM tds26_statements WHERE company_id=$1 AND fy=$2 AND quarter=$3', [cid, b.fy, b.quarter])).rowCount)
      throw httpError(409, 'This quarter already has a recorded statement. Remove it first if it was entered by mistake.');
    await pool.query('INSERT INTO tds26_statements (company_id, fy, quarter, token_no, filed_on, filed_by) VALUES ($1,$2,$3,$4,$5,$6)', [cid, b.fy, b.quarter, b.tokenNo, b.filedOn, req.user.id]);
    await setCompliance(pool, cid, 'TDS_RET_26Q', `${parseFy(b.fy)}-Q${b.quarter}`, b.filedOn, b.tokenNo);
    res.status(201).json({ ok: true });
  }));

  r.get('/tds/26q/statements', h(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM tds26_statements WHERE company_id=$1 ORDER BY fy DESC, quarter DESC', [req.user.companyId]);
    res.json(rows.map((s) => ({ ...s, filed_on: ymd(s.filed_on) })));
  }));

  r.delete('/tds/26q/statements/:id', h(async (req, res) => {
    needOwner(req);
    const x = (await pool.query('DELETE FROM tds26_statements WHERE id=$1 AND company_id=$2 RETURNING fy, quarter', [req.params.id, req.user.companyId])).rows[0];
    if (!x) throw httpError(404, 'Not found');
    await setCompliance(pool, req.user.companyId, 'TDS_RET_26Q', `${parseFy(x.fy)}-Q${x.quarter}`, null, null);
    res.json({ ok: true });
  }));

  return r;
}
