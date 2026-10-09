import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { Badge, PageHeader, Panel, Skeleton } from '../ui/kit.jsx';
import { Field, Notice } from '../ui/forms.jsx';
import { useStates } from './Parties.jsx';

const ENTITY_TYPES = [['proprietorship', 'Proprietorship'], ['partnership', 'Partnership firm'], ['llp', 'Limited liability partnership (LLP)'], ['private_limited', 'Private limited company'],
  ['public_limited', 'Public limited company'], ['opc', 'One person company'], ['huf', 'Hindu undivided family'], ['trust', 'Trust'], ['society', 'Society or association'], ['other', 'Other']];

const FIELDS = ['legalName', 'tradeName', 'entityType', 'incorporatedOn', 'cin', 'gstin', 'pan', 'tan', 'udyam', 'stateCode', 'addr1', 'addr2', 'loc', 'pin', 'contactPerson', 'phone', 'email', 'website', 'bankName', 'bankBranch', 'bankAccount', 'bankIfsc', 'upiId'];
const fromRow = (p) => Object.fromEntries(FIELDS.map((k) => [k, p?.[k] ?? '']));

/**
 * The business profile: who the enterprise is. The GSTIN can be added here at any time (it was only asked at sign-up before), and it sets the
 * state and the PAN. What is printed on invoices (logo, numbering, terms) stays in Invoice settings on the new invoice screen.
 */
export default function Profile() {
  const [profile, setProfile] = useState(null);
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);       // a state change the server wants confirmed
  const [check, setCheck] = useState(null);           // the answer to "Check GSTIN"
  const [checking, setChecking] = useState(false);
  const states = useStates();

  const load = () => api('GET', '/company/profile').then((p) => { setProfile(p); setF(fromRow(p)); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (!f) return <><PageHeader title="Business profile" subtitle="The details of your enterprise" /><Notice>{err}</Notice>{!err && <Skeleton rows={6} height={44} />}</>;

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const gstin = f.gstin.trim().toUpperCase();
  const stateName = (code) => states.find((s) => s.code === code)?.name ?? (code ? `State ${code}` : '');
  const shownState = gstin.length === 15 ? stateName(gstin.slice(0, 2)) : stateName(f.stateCode);
  const changed = FIELDS.filter((k) => String(f[k] ?? '') !== String(profile[k] ?? ''));
  const { percent, missing } = profile.completeness ?? { percent: 0, missing: [] };

  async function checkGstin() {
    setErr(''); setCheck(null); setChecking(true);
    try { setCheck(await api('GET', `/gstin/${gstin}`)); } catch (e) { setErr(e.message); } finally { setChecking(false); }
  }
  const useDetails = () => setF((x) => ({ ...x, legalName: x.legalName || check.legalName || '', tradeName: x.tradeName || (check.tradeName !== check.legalName ? check.tradeName : '') || '', addr1: x.addr1 || check.addr1 || '', addr2: x.addr2 || check.addr2 || '', loc: x.loc || check.loc || '', pin: x.pin || check.pin || '', pan: x.pan || check.pan || '' }));

  async function save(e, confirmed = false) {
    e?.preventDefault(); setErr(''); setSaved(''); setBusy(true);
    try {
      const body = Object.fromEntries(changed.map((k) => [k, k === 'gstin' || k === 'pan' ? f[k].trim().toUpperCase() : f[k]]));
      if (body.gstin) delete body.stateCode;                      // the GSTIN decides the state
      if (confirmed) body.confirmStateChange = true;
      const p = await api('PUT', '/company/profile', body);
      setProfile(p); setF(fromRow(p)); setConfirm(null); setCheck(null); setSaved('Business profile saved.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e2) {
      if (e2.code === 'STATE_CHANGE') setConfirm(e2.message);
      else setErr(e2.issues?.map((i) => i.message).join(' ') || e2.message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Business profile" subtitle="The details of your enterprise. They are used on invoices, returns and e-documents." />
      {saved && <Notice tone="info">{saved}</Notice>}
      <Notice>{err}</Notice>
      {confirm && <Notice tone="warn">{confirm} <button type="button" className="row-btn" onClick={() => save(null, true)} disabled={busy}>Yes, change the state</button> <button type="button" className="row-btn" onClick={() => setConfirm(null)}>Cancel</button></Notice>}

      <Panel title="How complete is your profile?" hint={`${percent}% done`} className="profile-meter">
        <div className="meter" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>
        {missing.length ? <p className="muted" style={{ marginTop: 10 }}>Still to add: {missing.map((m) => m.label).join(', ')}.</p> : <p className="muted" style={{ marginTop: 10 }}>Everything is filled in. Thank you.</p>}
      </Panel>

      <form onSubmit={save}>
        <Panel title="Identity" hint="Who the business is">
          <div className="form-grid">
            <Field label="Legal name" hint="As on your registration or GST certificate"><input value={f.legalName} onChange={set('legalName')} maxLength={100} /></Field>
            <Field label="Trade name" hint="If you trade under another name"><input value={f.tradeName} onChange={set('tradeName')} maxLength={100} /></Field>
            <Field label="Type of business"><select value={f.entityType} onChange={set('entityType')}><option value="">Select…</option>{ENTITY_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Date of incorporation or commencement"><input type="date" value={f.incorporatedOn} onChange={set('incorporatedOn')} /></Field>
            <Field label="CIN or LLPIN" hint="For companies and LLPs" className="span2"><input value={f.cin} onChange={set('cin')} maxLength={25} placeholder="U74999AP2020PTC123456" style={{ textTransform: 'uppercase' }} /></Field>
          </div>
        </Panel>

        <Panel title="Tax registrations" hint="GSTIN, PAN and the rest">
          <div className="form-grid">
            <Field label="GSTIN" hint={profile.gstin ? 'Change it only if it was entered wrongly or the registration changed' : 'Not added yet. Add it here whenever you have it; it sets your state and PAN.'} className="span2">
              <div className="row" style={{ marginBottom: 0, flexWrap: 'nowrap' }}>
                <input value={f.gstin} onChange={(e) => { setF({ ...f, gstin: e.target.value }); setCheck(null); }} maxLength={15} placeholder="37ABCDE1234F1Z5" style={{ textTransform: 'uppercase' }} autoComplete="off" />
                {gstin.length === 15 && <button type="button" onClick={checkGstin} disabled={checking}>{checking ? 'Checking…' : 'Check GSTIN'}</button>}
              </div>
            </Field>
            {check && <div className="span2"><Notice tone={check.found ? 'info' : 'warn'}>
              {check.found ? <><b>{check.legalName}</b> · {check.status ?? 'status not given'} · {check.stateName}. <button type="button" className="row-btn" onClick={useDetails}>Fill the empty fields from this</button></> : <>{check.stateName} · PAN {check.pan}{check.panKind ? ` (${check.panKind.toLowerCase()})` : ''}. </>}
              {check.message ?? ''}
            </Notice></div>}
            <Field label="State" hint={gstin.length === 15 ? 'Taken from the GSTIN' : profile.gstin ? 'Set by your GSTIN' : 'Choose it until you add a GSTIN'}>
              {gstin.length === 15 || profile.gstin ? <input value={shownState} readOnly /> : <select value={f.stateCode} onChange={set('stateCode')}>{states.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}</select>}
            </Field>
            <Field label="PAN" hint="Taken from the GSTIN if you leave it empty"><input value={f.pan} onChange={set('pan')} maxLength={10} style={{ textTransform: 'uppercase' }} /></Field>
            <Field label="TAN" hint="Needed for TDS returns"><input value={f.tan} onChange={set('tan')} maxLength={10} style={{ textTransform: 'uppercase' }} placeholder="HYDA12345B" /></Field>
            <Field label="Udyam registration number" hint="For MSMEs"><input value={f.udyam} onChange={set('udyam')} maxLength={19} style={{ textTransform: 'uppercase' }} placeholder="UDYAM-AP-01-1234567" /></Field>
          </div>
        </Panel>

        <Panel title="Registered address">
          <div className="form-grid">
            <Field label="Address line 1" className="span2"><input value={f.addr1} onChange={set('addr1')} maxLength={100} /></Field>
            <Field label="Address line 2" className="span2"><input value={f.addr2} onChange={set('addr2')} maxLength={100} /></Field>
            <Field label="Town / city"><input value={f.loc} onChange={set('loc')} maxLength={50} /></Field>
            <Field label="PIN code"><input value={f.pin} onChange={set('pin')} maxLength={6} inputMode="numeric" /></Field>
          </div>
        </Panel>

        <Panel title="Contact">
          <div className="form-grid">
            <Field label="Contact person"><input value={f.contactPerson} onChange={set('contactPerson')} maxLength={80} /></Field>
            <Field label="Phone"><input value={f.phone} onChange={set('phone')} inputMode="tel" /></Field>
            <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
            <Field label="Website"><input value={f.website} onChange={set('website')} maxLength={120} placeholder="https://" /></Field>
          </div>
        </Panel>

        <Panel title="Bank details" hint="Printed on your tax invoices so customers know where to pay">
          <div className="form-grid">
            <Field label="Bank"><input value={f.bankName} onChange={set('bankName')} maxLength={80} /></Field>
            <Field label="Branch"><input value={f.bankBranch} onChange={set('bankBranch')} maxLength={80} /></Field>
            <Field label="Account number"><input value={f.bankAccount} onChange={set('bankAccount')} inputMode="numeric" /></Field>
            <Field label="IFSC"><input value={f.bankIfsc} onChange={set('bankIfsc')} maxLength={11} style={{ textTransform: 'uppercase' }} placeholder="HDFC0001234" /></Field>
            <Field label="UPI ID" className="span2"><input value={f.upiId} onChange={set('upiId')} placeholder="name@bank" /></Field>
          </div>
        </Panel>

        <div className="profile-actions">
          <button className="primary" disabled={busy || !changed.length}>{busy ? 'Saving…' : 'Save business profile'}</button>
          {changed.length > 0 && <button type="button" onClick={() => { setF(fromRow(profile)); setCheck(null); setErr(''); }}>Discard changes</button>}
          <span className="muted">{changed.length ? `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}` : 'No changes to save'}</span>
          <span style={{ flex: 1 }} />
          <Badge tone="neutral">Logo, invoice numbering and terms are in Invoice settings on the New invoice screen</Badge>
        </div>
      </form>
    </>
  );
}
