import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, ymd } from '../util.js';
import { NORMAL_BY_TYPE, post } from '../ledger.js';

const paise = (n) => Math.round(Number(n) * 100);
const rupees = (p) => p / 100;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Debit/credit totals per account (in paise) for a company, optionally up to a date. */
async function totals(q, companyId, { asOf, before } = {}) {
  const args = [companyId];
  let where = 'e.company_id=$1';
  if (asOf) { args.push(asOf); where += ` AND e.date <= $${args.length}`; }
  if (before) { args.push(before); where += ` AND e.date < $${args.length}`; }
  const rows = (await q.query(
    `SELECT l.account_id, SUM(l.debit) AS d, SUM(l.credit) AS c
     FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE ${where} GROUP BY l.account_id`, args)).rows;
  return new Map(rows.map((r) => [r.account_id, { d: paise(r.d), c: paise(r.c) }]));
}

/** Balance in the account's normal direction (positive = on its usual side). */
const balanceOf = (a, t) => (a.normal === 'debit' ? (t?.d ?? 0) - (t?.c ?? 0) : (t?.c ?? 0) - (t?.d ?? 0));

export function ledgerRoutes(pool) {
  const r = Router();

  const account = async (req) => {
    const a = (await pool.query('SELECT * FROM accounts WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!a) throw httpError(404, 'Not found');
    return a;
  };

  r.get('/accounts', h(async (req, res) => {
    const accts = (await pool.query('SELECT * FROM accounts WHERE company_id=$1 ORDER BY code', [req.user.companyId])).rows;
    const t = await totals(pool, req.user.companyId, { asOf: req.query.asOf });
    res.json(accts.map((a) => ({
      ...a,
      debit: rupees(t.get(a.id)?.d ?? 0), credit: rupees(t.get(a.id)?.c ?? 0), balance: rupees(balanceOf(a, t.get(a.id))),
    })));
  }));

  r.post('/accounts', h(async (req, res) => {
    const b = z.object({
      code: z.string().regex(/^\d{4}$/), name: z.string().min(1),
      type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
    }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM accounts WHERE company_id=$1 AND code=$2', [req.user.companyId, b.code])).rowCount)
      throw httpError(409, 'Account code already exists');
    const { rows } = await pool.query(
      'INSERT INTO accounts (company_id,code,name,type,normal) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.companyId, b.code, b.name, b.type, NORMAL_BY_TYPE[b.type]]);
    res.status(201).json(rows[0]);
  }));

  // Statement for one account with opening balance and running balance.
  r.get('/accounts/:id/statement', h(async (req, res) => {
    const a = await account(req);
    const from = req.query.from, to = req.query.to;
    const opening = from ? balanceOf(a, (await totals(pool, req.user.companyId, { before: from })).get(a.id)) : 0;
    const args = [a.id, req.user.companyId];
    let where = 'l.account_id=$1 AND e.company_id=$2';
    if (from) { args.push(from); where += ` AND e.date >= $${args.length}`; }
    if (to) { args.push(to); where += ` AND e.date <= $${args.length}`; }
    const rows = (await pool.query(
      `SELECT e.id AS entry_id, e.date, e.narration, e.source_type, e.source_id, l.debit, l.credit, l.party_id
       FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE ${where} ORDER BY e.date, e.id, l.id`, args)).rows;
    let run = opening;
    const sign = a.normal === 'debit' ? 1 : -1;
    const lines = rows.map((x) => {
      run += sign * (paise(x.debit) - paise(x.credit));
      return { ...x, date: ymd(x.date), balance: rupees(run) };
    });
    res.json({ account: a, opening: rupees(opening), lines, closing: rupees(run) });
  }));

  // Customer / vendor statement built from the Debtors / Creditors lines tagged with the party.
  r.get('/parties/:id/ledger', h(async (req, res) => {
    const p = (await pool.query('SELECT * FROM parties WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!p) throw httpError(404, 'Not found');
    const rows = (await pool.query(
      `SELECT e.id AS entry_id, e.date, e.narration, e.source_type, l.debit, l.credit
       FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
       WHERE l.party_id=$1 AND e.company_id=$2 ORDER BY e.date, e.id, l.id`, [p.id, req.user.companyId])).rows;
    // Customer owes us when debits exceed credits; vendor: we owe them when credits exceed debits.
    const sign = p.type === 'customer' ? 1 : -1;
    let run = 0;
    const lines = rows.map((x) => {
      run += sign * (paise(x.debit) - paise(x.credit));
      return { ...x, date: ymd(x.date), balance: rupees(run) };
    });
    res.json({ party: p, lines, closing: rupees(run), label: p.type === 'customer' ? 'Receivable' : 'Payable' });
  }));

  r.get('/trial-balance', h(async (req, res) => {
    const accts = (await pool.query('SELECT * FROM accounts WHERE company_id=$1 ORDER BY code', [req.user.companyId])).rows;
    const t = await totals(pool, req.user.companyId, { asOf: req.query.asOf });
    let dr = 0, cr = 0;
    const rows = accts.map((a) => {
      const net = (t.get(a.id)?.d ?? 0) - (t.get(a.id)?.c ?? 0);
      const debit = net > 0 ? net : 0, credit = net < 0 ? -net : 0;
      dr += debit; cr += credit;
      return { id: a.id, code: a.code, name: a.name, type: a.type, debit: rupees(debit), credit: rupees(credit) };
    }).filter((x) => x.debit || x.credit);
    res.json({ rows, total_debit: rupees(dr), total_credit: rupees(cr), balanced: dr === cr });
  }));

  r.get('/journal', h(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200), offset = Number(req.query.offset) || 0;
    const entries = (await pool.query(
      'SELECT * FROM journal_entries WHERE company_id=$1 ORDER BY date DESC, id DESC LIMIT $2 OFFSET $3',
      [req.user.companyId, limit, offset])).rows;
    if (!entries.length) return res.json([]);
    const ph = entries.map((_, i) => `$${i + 1}`).join(',');
    const lines = (await pool.query(
      `SELECT l.*, a.code, a.name AS account_name FROM journal_lines l JOIN accounts a ON a.id=l.account_id
       WHERE l.entry_id IN (${ph}) ORDER BY l.id`, entries.map((e) => e.id))).rows;
    res.json(entries.map((e) => ({ ...e, date: ymd(e.date), lines: lines.filter((l) => l.entry_id === e.id) })));
  }));

  // Manual journal (opening balances, expenses, adjustments). Must balance.
  r.post('/journal', h(async (req, res) => {
    const b = z.object({
      date, narration: z.string().max(200).optional(),
      lines: z.array(z.object({
        accountId: z.number().int(), partyId: z.number().int().optional(),
        debit: z.number().nonnegative().default(0), credit: z.number().nonnegative().default(0),
      }).refine((l) => (l.debit > 0) !== (l.credit > 0), 'Each line needs exactly one of debit or credit')).min(2),
    }).parse(req.body);
    const cid = req.user.companyId;

    const ids = b.lines.map((l) => l.accountId);
    const found = (await pool.query(`SELECT id FROM accounts WHERE company_id=$1 AND id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})`, [cid, ...ids])).rows;
    if (new Set(found.map((x) => x.id)).size !== new Set(ids).size) throw httpError(400, 'Unknown account in journal');
    const dr = b.lines.reduce((s, l) => s + paise(l.debit), 0), cr = b.lines.reduce((s, l) => s + paise(l.credit), 0);
    if (dr !== cr) throw httpError(400, `Journal does not balance: debit ${rupees(dr)} vs credit ${rupees(cr)}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = await post(client, { companyId: cid, date: b.date, narration: b.narration, sourceType: 'manual', lines: b.lines });
      await client.query('COMMIT');
      res.status(201).json({ id });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  return r;
}
