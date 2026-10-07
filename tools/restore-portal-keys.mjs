// One-off: portal (GSTN / IRP) field names must stay as the portal defines them; undo the camel codemod for those in tests.
import fs from 'node:fs';
const keys = 'itm_det inv_typ sply_ty nt_num nt_dt expt_amt nil_amt ngsup_amt hsn_sc doc_num net_issue cur_gt doc_issue doc_det ret_period sup_details osup_det osup_zero osup_nil_exmp isup_rev osup_nongst inter_sup unreg_details comp_details uin_details itc_elg itc_avl itc_rev itc_inelg inward_sup isup_details intr_ltfee intr_details'.split(' ');
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const map = new Map(keys.map((k) => [camel(k), k]));
const re = new RegExp(String.raw`(?<=[\w)\]?]\.|[{,]\s*)\b(${[...map.keys()].join('|')})\b(?!\s*\()`, 'g');
for (const f of process.argv.slice(2)) {
  const s = fs.readFileSync(f, 'utf8');
  const out = s.split('\n').map((l) => (/\b(SELECT|INSERT|UPDATE)\b/.test(l) ? l : l.replace(re, (m) => map.get(m)))).join('\n');
  if (out !== s) { fs.writeFileSync(f, out); console.log('restored in', f); }
}
