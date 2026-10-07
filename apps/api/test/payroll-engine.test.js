import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualTax, computePayslip, employedDays, monthsLeft, runTotals } from '../src/payroll.js';

const emp = (o = {}) => ({
  doj: '2020-01-01', exit_date: null, basic: 0, hra: 0, special: 0, travel: 0, medical: 0,
  pf_applicable: true, pf_on_actual: false, esi_applicable: true, pt_monthly: 0, tax_regime: 'new', declared_deductions: 0, ...o,
});
const slip = (e, month = '2026-04', o = {}) => computePayslip(e, month, o);

test('month and employment helpers', () => {
  assert.equal(employedDays(emp(), '2026-04'), 30);
  assert.equal(employedDays(emp({ doj: '2026-04-16' }), '2026-04'), 15, 'joined on the 16th: days 16-30');
  assert.equal(employedDays(emp({ exit_date: '2026-04-10' }), '2026-04'), 10);
  assert.equal(employedDays(emp({ doj: '2026-05-01' }), '2026-04'), 0);
  assert.equal(employedDays(emp({ exit_date: '2026-03-31' }), '2026-04'), 0);
  assert.equal(employedDays(emp(), '2028-02'), 29, 'leap February');
  assert.deepEqual(['2026-04', '2026-10', '2027-01', '2027-03'].map((m) => monthsLeft(m)), [12, 6, 3, 1]);
  assert.equal(monthsLeft('2026-04', '2026-08-15'), 5, 'leaving in August: Apr..Aug');
  assert.equal(monthsLeft('2026-10', '2028-01-01'), 6, 'exit in a later FY does not shorten this one');
});

test('PF: capped at ₹15,000 wages, EPS/EPF split, EDLI; higher-wage option', () => {
  const s = slip(emp({ basic: 30000, hra: 12000, special: 8000 }));
  assert.deepEqual([s.gross, s.pf_wages, s.pf_employee, s.pf_eps, s.pf_epf, s.edli, s.esi_employee], [50000, 15000, 1800, 1250, 550, 75, 0]);

  const hi = slip(emp({ basic: 40000, pf_on_actual: true }));
  assert.deepEqual([hi.pf_wages, hi.pf_employee, hi.pf_eps, hi.pf_epf, hi.edli], [40000, 4800, 1250, 3550, 75], 'pension share stays capped');

  const lowBasic = slip(emp({ basic: 12000, hra: 4000, special: 3000 }));
  assert.deepEqual([lowBasic.pf_wages, lowBasic.pf_employee, lowBasic.pf_eps, lowBasic.pf_epf, lowBasic.edli], [12000, 1440, 1000, 440, 60]);
  assert.equal(slip(emp({ basic: 30000, pf_applicable: false })).pf_employee, 0);
});

test('ESI: covered up to ₹21,000 monthly gross, rounded up; ceiling tested on the full structure', () => {
  const s = slip(emp({ basic: 12000, hra: 4000, special: 3000 }));
  assert.deepEqual([s.esi_covered, s.esi_employee, s.esi_employer], [true, 143, 618], '142.5 -> 143, 617.5 -> 618');
  assert.equal(slip(emp({ basic: 21000 })).esi_covered, true);
  assert.equal(slip(emp({ basic: 21001 })).esi_covered, false);
  // Loss of pay lowers earned wages but does not change coverage (decided on the full structure).
  const lop = slip(emp({ basic: 21000 }), '2026-04', { lopDays: 15 });
  assert.deepEqual([lop.esi_covered, lop.gross, lop.esi_employee, lop.esi_employer], [true, 10500, 79, 342]);
  assert.equal(slip(emp({ basic: 15000, esi_applicable: false })).esi_covered, false);
});

test('loss of pay and part-month employment prorate on calendar days', () => {
  const e = emp({ basic: 30000, hra: 12000, special: 8000 });
  const lop = slip(e, '2026-04', { lopDays: 3 });
  assert.deepEqual([lop.paid_days, lop.earned_basic, lop.earned_hra, lop.earned_special, lop.gross], [27, 27000, 10800, 7200, 45000]);
  const joiner = slip({ ...e, doj: '2026-04-16' });
  assert.deepEqual([joiner.employed_days, joiner.paid_days, joiner.gross], [15, 15, 25000]);
  const both = slip({ ...e, doj: '2026-04-16' }, '2026-04', { lopDays: 5 });
  // 15 days employed less 5 LOP = 10 paid days of 30: 10,000 + 4,000 + 2,666.67 (rounded to 2,667)
  assert.deepEqual([both.paid_days, both.gross], [10, 16667]);
  assert.throws(() => slip(e, '2026-04', { lopDays: 31 }), /between 0 and 30/);
  assert.throws(() => slip({ ...e, doj: '2026-04-16' }, '2026-04', { lopDays: 16 }), /between 0 and 15/);
  const none = slip({ ...e, doj: '2026-04-16' }, '2026-04', { lopDays: 15 });
  assert.deepEqual([none.paid_days, none.gross, none.tds, none.pf_employee, none.net], [0, 0, 0, 0, 0], 'a month with no paid days costs nothing');
});

test('TDS new regime: rebate makes ₹12 lakh salary nil; ₹18 lakh slabs; marginal relief just above ₹12 lakh', () => {
  const fy = '2026-27';
  assert.equal(annualTax({ fy, regime: 'new', projectedGross: 1200000 }).annual_tax, 0, 'taxable 11.25L is within the 12L rebate');
  // 18,00,000 - 75,000 = 17,25,000 -> 20,000 + 40,000 + 60,000 + 25,000 = 1,45,000; +4% cess = 1,50,800
  const t = annualTax({ fy, regime: 'new', projectedGross: 1800000 });
  assert.deepEqual([t.taxable, t.annual_tax], [1725000, 150800]);
  // 12,90,000 - 75,000 = 12,15,000: slab tax 62,250 but marginal relief caps it at 15,000; +4% = 15,600
  const m = annualTax({ fy, regime: 'new', projectedGross: 1290000 });
  assert.deepEqual([m.taxable, m.annual_tax], [1215000, 15600]);

  const s = slip(emp({ basic: 75000, hra: 30000, special: 45000 }));
  assert.equal(s.gross, 150000);
  assert.equal(s.tds, 12567, '1,50,800 / 12 = 12,566.67');
  assert.equal(slip(emp({ basic: 53750, hra: 21500, special: 32250 })).tds, 1300, 'marginal-relief case: 15,600 / 12');
});

test('TDS old regime: standard deduction, PT and declared deductions', () => {
  // 8,40,000 - 50,000 - 2,400 (PT) - 1,50,000 = 6,37,600 -> 12,500 + 27,520 = 40,020; +4% = 41,621
  const t = annualTax({ fy: '2026-27', regime: 'old', projectedGross: 840000, ptAnnual: 2400, declared: 150000 });
  assert.deepEqual([t.taxable, t.annual_tax], [637600, 41621]);
  const s = slip(emp({ basic: 35000, hra: 14000, special: 21000, tax_regime: 'old', pt_monthly: 200, declared_deductions: 150000 }));
  assert.equal(s.gross, 70000);
  assert.equal(s.tds, 3468);
  assert.equal(annualTax({ fy: '2026-27', regime: 'old', projectedGross: 500000 }).annual_tax, 0, 'old regime rebate: taxable 4.5L');
});

test('TDS catches up: later months spread the remaining tax; a mid-year change is absorbed', () => {
  const e = emp({ basic: 75000, hra: 30000, special: 45000 });
  // Month 2 after April's 12,567 was deducted on 1,50,000: (1,50,800 - 12,567) / 11 = 12,566.6
  assert.equal(slip(e, '2026-05', { ytd: { gross: 150000, tds: 12567 } }).tds, 12567);
  // Last month of the year deducts whatever is left.
  assert.equal(slip(e, '2027-03', { ytd: { gross: 1650000, tds: 138233 } }).tds, 12567);
  // Raise mid-year: projection uses the new structure for the remaining months.
  const raised = slip({ ...e, basic: 100000, hra: 40000, special: 60000 }, '2026-10', { ytd: { gross: 900000, tds: 75400 } });
  // projected = 9,00,000 + 2,00,000 + 5 x 2,00,000 = 21,00,000; taxable 20,25,000
  // tax = 20,000 + 40,000 + 60,000 + 80,000 + 25,000 x 25% (6,250) = 2,06,250; +4% = 2,14,500 -> (2,14,500 - 75,400) / 6
  assert.equal(raised.annual_tax, 214500);
  assert.equal(raised.tds, Math.round((214500 - 75400) / 6));
  const leaver = slip({ ...e, exit_date: '2026-08-31' }, '2026-06', { ytd: { gross: 300000, tds: 25134 } });
  // leaves end of August: months Jun, Jul, Aug = 3 -> projected 3,00,000 + 1,50,000 + 2 x 1,50,000 = 7,50,000 -> within rebate
  assert.equal(leaver.annual_tax, 0);
  assert.equal(leaver.tds, 0);
});

test('guards: TDS never makes net pay negative; negative net is flagged; surcharge and tax-table warnings', () => {
  const low = slip(emp({ basic: 100000, hra: 40000, special: 60000, pf_applicable: false }), '2026-04', { otherDeductions: 300000 });
  assert.ok(low.net < 0);
  assert.match(low.warnings.join(' '), /negative/);

  const capped = computePayslip(emp({ basic: 5000, pf_applicable: false }), '2026-04', { ytd: { gross: 0, tds: 0 }, otherEarnings: 0 });
  assert.equal(capped.tds, 0);

  const rich = slip(emp({ basic: 600000, pf_applicable: false }));
  assert.match(rich.warnings.join(' '), /surcharge/);
  assert.match(slip(emp({ basic: 10000 }), '2031-04').warnings.join(' '), /No tax table/);
  assert.equal(slip(emp({ basic: 10000 }), '2025-06').warnings.length, 0, 'a verified year carries no table warning');
});

test('run totals: PF admin is per establishment with a ₹500 minimum', () => {
  const a = slip(emp({ basic: 75000, hra: 30000, special: 45000, pt_monthly: 200 }));
  const b = slip(emp({ basic: 12000, hra: 4000, special: 3000 }));
  const t = runTotals([a, b]);
  assert.deepEqual([t.gross, t.pf_employee, t.pf_employer, t.edli, t.pf_admin, t.esi_employee, t.esi_employer, t.tds, t.professional_tax],
    [169000, 3240, 3240, 135, 500, 143, 618, 12567, 200]);
  assert.equal(t.net, 135433 + 17417);
  assert.equal(t.employer_contributions, 3240 + 135 + 500 + 618);
  assert.equal(t.employer_cost, 169000 + 4493);
  assert.equal(t.pf_payable, 3240 + 3240 + 135 + 500);
  assert.equal(runTotals([slip(emp({ basic: 40000, pf_on_actual: true }))]).pf_admin, 500, '0.5% of 40,000 = 200, so the minimum applies');
  assert.equal(runTotals([slip(emp({ basic: 4000000, pf_on_actual: true, hra: 0 }))]).pf_admin, 20000);
  assert.equal(runTotals([slip(emp({ basic: 30000, pf_applicable: false }))]).pf_admin, 0, 'no PF members, no admin charge');
});
