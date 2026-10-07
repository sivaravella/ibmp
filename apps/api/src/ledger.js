import { httpError } from './util.js';

const paise = (n) => Math.round(Number(n) * 100);

// System chart of accounts, seeded per company. Codes are stable and used by the posting rules below.
export const A = {
  CASH: '1000', BANK: '1010', DEBTORS: '1100', IN_CGST: '1200', IN_SGST: '1210', IN_IGST: '1220',
  CREDITORS: '2000', OUT_CGST: '2100', OUT_SGST: '2110', OUT_IGST: '2120',
  CAPITAL: '3000', SALES: '4000', SALES_RET: '4100', PURCHASES: '5000', PURCH_RET: '5100',
  // payroll
  EMP_ADVANCES: '1300', SALARY_PAYABLE: '2200', PF_PAYABLE: '2210', ESI_PAYABLE: '2220', TDS_PAYABLE: '2230', PT_PAYABLE: '2240',
  SALARY_EXP: '5300', EMPR_CONTRIB_EXP: '5310',
  // TDS on payments other than salary
  TDS_NS_PAYABLE: '2250', INT_PEN_EXP: '5400', RENT_EXP: '5410', PROF_FEES_EXP: '5420', CONTRACT_EXP: '5430', COMMISSION_EXP: '5440', INTEREST_EXP: '5450',
};

const SYSTEM_ACCOUNTS = [
  [A.CASH, 'Cash in Hand', 'asset', 'debit'],
  [A.BANK, 'Bank Account', 'asset', 'debit'],
  [A.DEBTORS, 'Sundry Debtors', 'asset', 'debit'],
  [A.IN_CGST, 'Input CGST', 'asset', 'debit'],
  [A.IN_SGST, 'Input SGST', 'asset', 'debit'],
  [A.IN_IGST, 'Input IGST', 'asset', 'debit'],
  [A.CREDITORS, 'Sundry Creditors', 'liability', 'credit'],
  [A.OUT_CGST, 'Output CGST', 'liability', 'credit'],
  [A.OUT_SGST, 'Output SGST', 'liability', 'credit'],
  [A.OUT_IGST, 'Output IGST', 'liability', 'credit'],
  [A.CAPITAL, "Owner's Capital", 'equity', 'credit'],
  [A.SALES, 'Sales', 'income', 'credit'],
  [A.SALES_RET, 'Sales Returns', 'income', 'debit'],          // contra-income
  [A.PURCHASES, 'Purchases', 'expense', 'debit'],
  [A.PURCH_RET, 'Purchase Returns', 'expense', 'credit'],     // contra-expense
  [A.EMP_ADVANCES, 'Employee Advances', 'asset', 'debit'],
  [A.SALARY_PAYABLE, 'Salary Payable', 'liability', 'credit'],
  [A.PF_PAYABLE, 'PF Payable', 'liability', 'credit'],
  [A.ESI_PAYABLE, 'ESI Payable', 'liability', 'credit'],
  [A.TDS_PAYABLE, 'TDS on Salary Payable', 'liability', 'credit'],
  [A.PT_PAYABLE, 'Professional Tax Payable', 'liability', 'credit'],
  [A.SALARY_EXP, 'Salaries & Wages', 'expense', 'debit'],
  [A.EMPR_CONTRIB_EXP, 'Employer PF/ESI Contributions', 'expense', 'debit'],
  [A.TDS_NS_PAYABLE, 'TDS Payable (non-salary)', 'liability', 'credit'],
  [A.INT_PEN_EXP, 'Interest & Penalties (statutory)', 'expense', 'debit'],
  [A.RENT_EXP, 'Rent', 'expense', 'debit'],
  [A.PROF_FEES_EXP, 'Professional & Technical Fees', 'expense', 'debit'],
  [A.CONTRACT_EXP, 'Contractor Payments', 'expense', 'debit'],
  [A.COMMISSION_EXP, 'Commission & Brokerage', 'expense', 'debit'],
  [A.INTEREST_EXP, 'Interest Paid', 'expense', 'debit'],
];

export const NORMAL_BY_TYPE = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', income: 'credit' };

export async function seedAccounts(q, companyId) {
  const have = new Set((await q.query('SELECT code FROM accounts WHERE company_id=$1', [companyId])).rows.map((r) => r.code));
  for (const [code, name, type, normal] of SYSTEM_ACCOUNTS) {
    if (have.has(code)) continue;
    await q.query('INSERT INTO accounts (company_id,code,name,type,normal,is_system) VALUES ($1,$2,$3,$4,$5,true)',
      [companyId, code, name, type, normal]);
  }
}

/**
 * Post one balanced journal entry inside the caller's transaction.
 * lines: [{ code, debit?, credit?, partyId? }] in rupees; zero-value lines are dropped.
 */
export async function post(q, { companyId, date, narration, sourceType, sourceId, lines }) {
  const live = lines.filter((l) => paise(l.debit || 0) > 0 || paise(l.credit || 0) > 0);
  const dr = live.reduce((s, l) => s + paise(l.debit || 0), 0);
  const cr = live.reduce((s, l) => s + paise(l.credit || 0), 0);
  if (dr !== cr || dr === 0) throw new Error(`Unbalanced journal (${sourceType} ${sourceId}): Dr ${dr} Cr ${cr}`);

  let ids = await accountIds(q, companyId);
  // Create any missing system account (new companies, or accounts added by a later release) before resolving codes.
  if (live.some((l) => l.code && !ids.has(l.code))) { await seedAccounts(q, companyId); ids = await accountIds(q, companyId); }

  const e = (await q.query(
    'INSERT INTO journal_entries (company_id,date,narration,source_type,source_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [companyId, date, narration || null, sourceType, sourceId ?? null])).rows[0];
  for (const l of live) {
    const accountId = l.accountId ?? ids.get(l.code);
    if (!accountId) throw httpError(400, `Unknown account ${l.code ?? l.accountId}`);
    await q.query('INSERT INTO journal_lines (entry_id,account_id,party_id,debit,credit) VALUES ($1,$2,$3,$4,$5)',
      [e.id, accountId, l.partyId ?? null, l.debit || 0, l.credit || 0]);
  }
  return e.id;
}

async function accountIds(q, companyId) {
  const rows = (await q.query('SELECT id, code FROM accounts WHERE company_id=$1', [companyId])).rows;
  return new Map(rows.map((r) => [r.code, r.id]));
}

/** GST legs of a document. side 'out' = output tax (sales), 'in' = input credit (purchases). */
export const taxLines = (doc, side, dir) => {
  const [c, s, i] = side === 'out' ? [A.OUT_CGST, A.OUT_SGST, A.OUT_IGST] : [A.IN_CGST, A.IN_SGST, A.IN_IGST];
  return [[c, doc.cgst], [s, doc.sgst], [i, doc.igst]].map(([code, v]) => ({ code, [dir]: Number(v) }));
};
