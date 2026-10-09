import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setToken } from '../api.js';
import { Badge } from '../ui/kit.jsx';
import { Field, Notice } from '../ui/forms.jsx';
import { openGstPortal } from '../ui/gst.js';
import { inr } from '../ui/format.js';

/**
 * Sign-up wizard for a new business owner: 1 Verify, 2 Entity & Nature, 3 Industry, 4 Details, 5 Plan, 6 Done.
 * With `pending` (a first-time Google/LinkedIn sign-in) step 1 is skipped and the account is finished through /auth/social/complete.
 */
const STEPS = ['Verify', 'Entity & Nature', 'Industry', 'Details', 'Plan', 'Done'];
const MAX_FILE = 3 * 1024 * 1024;
const DOCS = [
  ['gst', 'GST certificate', 'GST registration certificate (REG-06)'],
  ['coi', 'Certificate of Incorporation', 'From the Registrar of Companies'],
  ['mca', 'MCA master data', 'Company master data from the MCA website'],
];
const DOC_NAME = { gst: 'GST certificate', coi: 'Certificate of Incorporation', mca: 'MCA master data' };

const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

// The same check-character rule the server uses (see apps/api/src/gstin.js).
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
function checkChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}
function gstinProblem(g) {
  if (!g) return '';
  if (g.length < 15) return `${15 - g.length} more character${15 - g.length === 1 ? '' : 's'} to go (a GSTIN has 15).`;
  if (g.length > 15) return 'A GSTIN has exactly 15 characters.';
  if (!GSTIN_RE.test(g)) return 'This does not look like a GSTIN. Check the letters and digits.';
  if (!STATES[g.slice(0, 2)]) return 'The first two digits are not a valid state code.';
  if (checkChar(g.slice(0, 14)) !== g[14]) return 'The last character does not match, so one of the characters is probably mistyped.';
  return '';
}

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanMobile = (v) => String(v ?? '').replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
const mobileOk = (v) => /^[6-9]\d{9}$/.test(cleanMobile(v));
const isCompanyType = (t) => !!t && /llp|company|limited|pvt|private|corporation/i.test(`${t.value} ${t.label}`);

/** Shrink a chosen image to fit 320 x 160 and return it as a data URL (same rule as the invoice logo picker). */
function shrinkLogo(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a PNG, JPEG or WebP image.'));
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, 320 / img.width, 160 / img.height), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const out = c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.88);
      if (out.length > 270000) reject(new Error('That logo is too detailed to store. Try a simpler or smaller image.')); else resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); };
    img.src = url;
  });
}

const EMPTY = {
  email: '', emailToken: '', name: '', password: '', mobile: '',
  entityType: '', nature: '', industry: null, sector: '', sectorTouched: false,
  gstin: '', noGst: false, stateCode: '', pan: '', legalName: '', tradeName: '', company: '', companyTouched: false,
  addr1: '', addr2: '', loc: '', pin: '', phone: '', website: '', contactPerson: '', secondaryMobile: '', secondaryEmail: '',
  cin: '', incorporatedOn: '', udyam: '', turnoverSlab: '', employeeRange: '', logo: '', preferredPlan: 'trial',
};

const LABELS = {
  gstin: 'GSTIN', legalName: 'legal name', tradeName: 'trade name', pan: 'PAN', entityType: 'type of entity', addr1: 'address', addr2: 'address', loc: 'city', pin: 'PIN code',
  stateCode: 'state', cin: 'CIN', incorporatedOn: 'incorporation date', phone: 'phone',
};

export default function Onboarding({ pending, socialSlot, onAuth, onSignIn }) {
  const social = !!pending;
  const [meta, setMeta] = useState(null);
  const [metaErr, setMetaErr] = useState('');
  const [step, setStep] = useState(social ? 2 : 1);
  const [d, setD] = useState(() => ({ ...EMPTY, name: pending?.name ?? '', email: pending?.email ?? '' }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [filled, setFilled] = useState([]);       // [{ doc, labels }]
  const [used, setUsed] = useState([]);           // documents whose details were used
  const head = useRef(null);
  const set = (patch) => setD((p) => ({ ...p, ...patch }));
  const on = (k) => (e) => set({ [k]: e.target.value });

  const loadMeta = useCallback(() => {
    setMetaErr('');
    api('GET', '/onboarding/meta').then(setMeta).catch((e) => setMetaErr(e.message));
  }, []);
  useEffect(loadMeta, [loadMeta]);

  useEffect(() => { // new step: back to the top, focus on its heading
    head.current?.focus({ preventScroll: true });
    head.current?.scrollIntoView({ block: 'start' });
    setErr('');
  }, [step]);

  const entity = meta?.entityTypes.find((t) => t.value === d.entityType);

  /** Put what a document revealed into the form without overwriting anything already typed. */
  function merge(kind, found) {
    const labels = [];
    setD((p) => {
      const n = { ...p };
      const take = (k, v, label = LABELS[k]) => { if (v && !n[k]) { n[k] = String(v); if (label && !labels.includes(label)) labels.push(label); } };
      if (!n.noGst) take('gstin', String(found.gstin ?? '').toUpperCase());
      take('legalName', found.legalName); take('tradeName', found.tradeName);
      take('pan', String(found.pan ?? '').toUpperCase());
      if (found.entityType && meta?.entityTypes.some((t) => t.value === found.entityType)) take('entityType', found.entityType);
      take('addr1', found.addr1); take('addr2', found.addr2); take('loc', found.loc); take('pin', found.pin);
      if (found.stateCode && STATES[String(found.stateCode).padStart(2, '0')]) take('stateCode', String(found.stateCode).padStart(2, '0'));
      take('cin', found.cin); take('incorporatedOn', found.incorporatedOn); take('phone', found.phone);
      if (!n.companyTouched && !n.company && (found.tradeName || found.legalName)) n.company = found.tradeName || found.legalName;
      if (!n.contactPerson && found.directors?.[0]?.name) n.contactPerson = found.directors[0].name;
      return n;
    });
    if (labels.length) {
      setFilled((p) => [...p.filter((x) => x.doc !== kind), { doc: kind, labels }]);
      setUsed((p) => (p.includes(kind) ? p : [...p, kind]));
    }
    return labels;
  }

  // ----- validation per step; returns a plain-English message or ''
  function problem(s) {
    if (s === 1) {
      if (!d.emailToken) return 'Verify your email address first. Enter it, ask for a code and type the code here.';
      if (d.name.trim().length < 2) return 'Enter your name.';
      if (d.password.length < 8) return 'Choose a password of at least 8 characters.';
      if (d.mobile && !mobileOk(d.mobile)) return 'Enter a 10-digit Indian mobile number, or leave it empty.';
    }
    if (s === 2) {
      if (!d.entityType) return 'Choose the type of your business entity.';
      if (!d.nature) return 'Choose the nature of your business.';
    }
    if (s === 3) {
      if (!d.industry?.name) return 'Choose your industry, or add it if it is not in the list.';
    }
    if (s === 4) {
      if (d.company.trim().length < 2) return 'Enter the name your company should appear under in IBMP.';
      if (!d.noGst && d.gstin) { const p = gstinProblem(d.gstin); if (p) return `GSTIN: ${p}`; }
      if ((d.noGst || !d.gstin) && !d.stateCode) return 'Choose your state, or enter your GSTIN.';
      if (d.pan && !PAN_RE.test(d.pan)) return 'PAN has 10 characters, like ABCDE1234F.';
      if (d.pin && !/^\d{6}$/.test(d.pin)) return 'PIN code has 6 digits.';
      if (d.phone && !/^[0-9+\-\s()]{7,18}$/.test(d.phone)) return 'Check the business phone number.';
      if (d.secondaryMobile && !mobileOk(d.secondaryMobile)) return 'Secondary mobile must be a 10-digit Indian number.';
      if (d.secondaryEmail && !EMAIL_RE.test(d.secondaryEmail)) return 'Check the secondary email address.';
      if (d.website && d.website.length > 200) return 'The website address is too long.';
    }
    return '';
  }

  function next() {
    const p = problem(step);
    if (p) { setErr(p); return; }
    if (step === 5) return complete();
    setStep(step + 1);
  }
  const back = () => setStep(Math.max(social ? 2 : 1, step - 1));

  async function complete() {
    setErr(''); setBusy(true);
    const gstin = !d.noGst && d.gstin ? d.gstin : '';
    const body = {
      company: d.company.trim(), entityType: d.entityType, nature: d.nature,
      sector: d.sector || undefined,
      industry: d.industry.code ? { code: d.industry.code, name: d.industry.name } : { name: d.industry.name },
      ...(gstin ? { gstin } : { stateCode: d.stateCode }),
      pan: d.pan || (gstin ? gstin.slice(2, 12) : ''),
      legalName: d.legalName.trim(), tradeName: d.tradeName.trim(), addr1: d.addr1.trim(), addr2: d.addr2.trim(), loc: d.loc.trim(), pin: d.pin,
      phone: d.phone.trim(), website: d.website.trim(), contactPerson: d.contactPerson.trim(),
      secondaryMobile: d.secondaryMobile ? cleanMobile(d.secondaryMobile) : '', secondaryEmail: d.secondaryEmail.trim(),
      cin: d.cin.trim(), incorporatedOn: d.incorporatedOn, udyam: d.udyam.trim(),
      turnoverSlab: d.turnoverSlab, employeeRange: d.employeeRange, logo: d.logo,
      preferredPlan: d.preferredPlan === 'trial' ? '' : d.preferredPlan,
      documentsUsed: used,
    };
    for (const k of Object.keys(body)) if (body[k] === '' || body[k] === undefined || (Array.isArray(body[k]) && !body[k].length)) delete body[k];
    try {
      const res = social
        ? await api('POST', '/auth/social/complete', { token: pending.token, ...body })
        : await api('POST', '/onboarding/complete', { emailToken: d.emailToken, name: d.name.trim(), password: d.password, ...(d.mobile ? { mobile: cleanMobile(d.mobile) } : {}), ...body });
      setToken(res.token);
      setDone(res);
      setStep(6);
    } catch (e) {
      setErr(e.issues?.map((i) => i.message).join(' ') || e.message);
    } finally { setBusy(false); }
  }

  if (metaErr) return <div className="onb"><Notice>{metaErr}</Notice><button type="button" onClick={loadMeta}>Try again</button></div>;
  if (!meta) return <div className="onb" aria-busy="true"><p className="muted">Loading the sign-up form…</p></div>;

  return (
    <div className="onb">
      <ol className="onb-steps" aria-label="Sign-up progress">
        {STEPS.map((s, i) => {
          const n = i + 1, state = n < step ? 'done' : n === step ? 'active' : 'todo';
          return (
            <li key={s} className={`onb-step ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
              <span className="onb-dot" aria-hidden="true">{state === 'done' ? '✓' : n}</span>
              <span className="onb-step-label">{s}<span className="sr-only">{state === 'done' ? ' (completed)' : state === 'active' ? ' (current step)' : ''}</span></span>
            </li>
          );
        })}
      </ol>

      {step === 1 && <StepVerify {...{ d, set, on, meta, err, setErr, socialSlot, onSignIn, merge, filled, head, onNext: next }} />}
      {step > 1 && step < 6 && (
        <form className="onb-card" onSubmit={(e) => { e.preventDefault(); if (!busy) next(); }} noValidate>
          {step === 2 && <StepEntity {...{ d, set, meta, entity, head, social }} />}
          {step === 3 && <StepIndustry {...{ d, set, meta, head }} />}
          {step === 4 && <StepDetails {...{ d, set, on, meta, head, filled, setErr, entity }} />}
          {step === 5 && <StepPlan {...{ d, set, meta, head }} />}
          <div aria-live="polite">{err && <Notice>{err}</Notice>}</div>
          <div className="onb-nav">
            {step > (social ? 2 : 1) ? <button type="button" onClick={back} disabled={busy}>Back</button> : <span />}
            <button className="primary" disabled={busy}>{busy ? 'Setting up your workspace…' : step === 5 ? (social ? 'Finish and start my trial' : 'Create my workspace') : 'Continue'}</button>
          </div>
        </form>
      )}
      {step === 6 && done && <StepDone {...{ done, d, meta, head, onAuth }} />}
    </div>
  );
}

// ---------------------------------------------------------------- step 1
function StepVerify({ d, set, on, err, setErr, socialSlot, onSignIn, merge, filled, head, onNext }) {
  const [phase, setPhase] = useState('email');       // email | code
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);            // { devCode, expiresInMinutes }
  const [wait, setWait] = useState(0);
  const [taken, setTaken] = useState(false);
  const [show, setShow] = useState(false);
  const boxes = useRef([]);
  const verified = !!d.emailToken;

  useEffect(() => { if (wait <= 0) return undefined; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);

  async function sendCode() {
    setErr(''); setTaken(false);
    const email = d.email.trim();
    if (!EMAIL_RE.test(email)) { setErr('Enter a valid email address.'); return; }
    setBusy(true);
    try {
      const r = await api('POST', '/onboarding/email-otp', { email });
      setInfo(r); setPhase('code'); setDigits(['', '', '', '', '', '']); setWait(r.resendAfterSeconds ?? 30);
      setTimeout(() => boxes.current[0]?.focus(), 0);
    } catch (e) {
      if (e.code === 'EMAIL_TAKEN') { setTaken(true); setErr('An account with this email already exists.'); }
      else if (e.code === 'EMAIL_OFF') setErr('Email sending is not set up on this site yet, so we cannot send a code. Please try again later, or sign up with Google or LinkedIn.');
      else setErr(e.message);
    } finally { setBusy(false); }
  }

  async function verify(code) {
    setErr('');
    if (code.length !== 6) { setErr('Enter the 6-digit code from your email.'); return; }
    setBusy(true);
    try {
      const r = await api('POST', '/onboarding/verify-email', { email: d.email.trim(), code });
      set({ emailToken: r.emailToken });
    } catch (e) {
      setErr(e.message); setDigits(['', '', '', '', '', '']); setTimeout(() => boxes.current[0]?.focus(), 0);
    } finally { setBusy(false); }
  }

  function typeDigit(i, v) {
    const clean = v.replace(/\D/g, '');
    if (!clean) { setDigits((p) => p.map((x, j) => (j === i ? '' : x))); return; }
    if (clean.length > 1) return pasteCode(clean);
    const nd = digits.map((x, j) => (j === i ? clean : x));
    setDigits(nd);
    if (i < 5) boxes.current[i + 1]?.focus();
    if (nd.every(Boolean)) verify(nd.join(''));
  }
  function pasteCode(text) {
    const s = text.replace(/\D/g, '').slice(0, 6);
    if (!s) return;
    const nd = ['', '', '', '', '', ''].map((_, j) => s[j] ?? '');
    setDigits(nd);
    boxes.current[Math.min(s.length, 5)]?.focus();
    if (s.length === 6) verify(s);
  }
  function keyDown(i, e) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) { e.preventDefault(); setDigits((p) => p.map((x, j) => (j === i - 1 ? '' : x))); boxes.current[i - 1]?.focus(); }
    if (e.key === 'ArrowLeft' && i > 0) boxes.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < 5) boxes.current[i + 1]?.focus();
  }

  function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (verified) onNext();
    else if (phase === 'email') sendCode();
    else verify(digits.join(''));
  }

  return (
    <form className="onb-card" onSubmit={submit} noValidate>
      <h3 ref={head} tabIndex={-1}>Create your account</h3>
      <p className="muted">Start a free trial. No card needed. First we confirm your email address.</p>
      {!verified && socialSlot}

      <Field label="Email address" hint={verified ? undefined : 'We will send a 6-digit code to this address.'}>
        <input type="email" inputMode="email" autoComplete="username" value={d.email} onChange={on('email')} disabled={verified || phase === 'code'} maxLength={254} />
      </Field>
      {verified && <p><Badge tone="ok">Email verified</Badge></p>}

      {!verified && phase === 'email' && <button type="button" className="primary" onClick={sendCode} disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>}

      {!verified && phase === 'code' && (
        <div className="onb-otp-wrap">
          <div role="group" aria-labelledby="otp-label">
            <span id="otp-label" className="field-label">Enter the 6-digit code we sent to {d.email}</span>
            <div className="onb-otp">
              {digits.map((v, i) => (
                <input key={i} ref={(el) => { boxes.current[i] = el; }} value={v} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={6}
                  aria-label={`Digit ${i + 1} of 6`} onChange={(e) => typeDigit(i, e.target.value)} onKeyDown={(e) => keyDown(i, e)}
                  onPaste={(e) => { e.preventDefault(); pasteCode(e.clipboardData.getData('text')); }} onFocus={(e) => e.target.select()} />
              ))}
            </div>
          </div>
          {info?.devCode && <p className="onb-test">Test mode: code is <b>{info.devCode}</b></p>}
          <div className="onb-row">
            <button type="button" className="primary" onClick={() => verify(digits.join(''))} disabled={busy}>{busy ? 'Checking…' : 'Verify email'}</button>
            <button type="button" onClick={sendCode} disabled={busy || wait > 0}>{wait > 0 ? `Resend in ${wait}s` : 'Resend code'}</button>
            <button type="button" className="linklike" onClick={() => { setPhase('email'); setErr(''); }}>Change email</button>
          </div>
          <p className="field-hint">The code works for {info?.expiresInMinutes ?? 10} minutes. Check your spam folder if you cannot find it.</p>
        </div>
      )}

      <div aria-live="polite">
        {err && <Notice>{err}{taken && <> <button type="button" className="linklike" onClick={onSignIn}>Sign in instead</button></>}</Notice>}
      </div>

      {verified && <>
        <Field label="Your name"><input autoComplete="name" value={d.name} onChange={on('name')} maxLength={120} /></Field>
        <Field label="Password" hint="At least 8 characters.">
          <div className="onb-pass">
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={d.password} onChange={on('password')} maxLength={128} />
            <button type="button" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </Field>
        <Field label="Mobile number (optional)" hint="We will verify your mobile by SMS once it is available. For now it is only saved to your account.">
          <input type="tel" inputMode="tel" autoComplete="tel-national" placeholder="10-digit mobile, with or without +91" value={d.mobile} onChange={on('mobile')} maxLength={16} />
        </Field>
        <UploadPanel d={d} merge={merge} filled={filled} />
        <div aria-live="polite">{err && verified && <Notice>{err}</Notice>}</div>
        <div className="onb-nav"><span /><button className="primary">Continue</button></div>
      </>}
    </form>
  );
}

function UploadPanel({ d, merge, filled }) {
  const [res, setRes] = useState({});     // kind -> { tone, text } | { busy: true }
  const [over, setOver] = useState('');
  const [skipped, setSkipped] = useState(false);

  async function upload(kind, file) {
    if (!file) return;
    if (file.size > MAX_FILE) { setRes((p) => ({ ...p, [kind]: { tone: 'bad', text: 'That file is larger than 3 MB. Upload a smaller copy, or type the details yourself.' } })); return; }
    setRes((p) => ({ ...p, [kind]: { busy: true } }));
    try {
      const r = await fetch('/v1/onboarding/extract', {
        method: 'POST',
        headers: { 'x-onboarding-token': d.emailToken, 'x-kind': kind, 'x-filename': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || (r.status >= 500 ? 'Something went wrong on our side. Try again, or type the details yourself.' : `The file could not be read (${r.status}).`));
      if (!data.supported) { setRes((p) => ({ ...p, [kind]: { tone: 'warn', text: data.message || 'We can only read text PDFs, not photos or scans. Please type the details in the next steps.' } })); return; }
      const labels = merge(kind, data.found ?? {});
      setRes((p) => ({ ...p, [kind]: labels.length ? { tone: 'ok', text: `Read ${labels.join(', ')} from your ${DOC_NAME[kind]}.` } : { tone: 'warn', text: data.message || 'We could not find any details in this file. Please type them in the next steps.' } }));
    } catch (e) {
      setRes((p) => ({ ...p, [kind]: { tone: 'bad', text: e instanceof TypeError ? 'Cannot reach the server. Check your connection and try again.' : e.message } }));
    }
  }

  if (skipped) return <p className="muted">You will enter the business details yourself in the next steps. <button type="button" className="linklike" onClick={() => setSkipped(false)}>Upload a document instead</button></p>;
  return (
    <section className="onb-upload" aria-labelledby="up-h">
      <h4 id="up-h">Upload your registration copy (optional)</h4>
      <p className="field-hint">We read a text PDF and fill in your business details for you. You can change everything afterwards. Photos and scans cannot be read yet.</p>
      <div className="onb-drops">
        {DOCS.map(([kind, title, sub]) => {
          const r = res[kind];
          return (
            <div key={kind} className={`onb-drop${over === kind ? ' over' : ''}${r?.tone === 'ok' ? ' ok' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(kind); }} onDragLeave={() => setOver('')}
              onDrop={(e) => { e.preventDefault(); setOver(''); upload(kind, e.dataTransfer.files?.[0]); }}>
              <b>{title}</b><span>{sub}</span>
              <label className="row-btn" style={{ cursor: r?.busy ? 'wait' : 'pointer' }}>
                {r?.busy ? 'Reading…' : r?.tone === 'ok' ? 'Replace PDF' : 'Choose PDF'}
                <input type="file" accept="application/pdf,.pdf" hidden disabled={!!r?.busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; upload(kind, f); }} />
              </label>
              <small>or drop it here · PDF, up to 3 MB</small>
              <div aria-live="polite">{r && !r.busy && <span className={`onb-res ${r.tone}`}>{r.text}</span>}</div>
            </div>
          );
        })}
      </div>
      {filled.length > 0 && <Notice tone="ok">Auto-filled from your {filled.map((f) => DOC_NAME[f.doc]).join(' and ')}. You can review and edit everything in the next steps.</Notice>}
      <button type="button" className="linklike" onClick={() => setSkipped(true)}>Skip upload — I will enter the details myself</button>
    </section>
  );
}

// ---------------------------------------------------------------- step 2
function StepEntity({ d, set, meta, entity, head, social }) {
  return <>
    <h3 ref={head} tabIndex={-1}>{social ? `Welcome, ${d.name.split(' ')[0] || 'there'}. ` : ''}What kind of business is it?</h3>
    <Field label="Type of entity">
      <select value={d.entityType} onChange={(e) => set({ entityType: e.target.value })}>
        <option value="">Choose…</option>
        {meta.entityTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
    </Field>
    <div className="onb-desc" aria-live="polite">{entity ? <><b>{entity.label}</b><span>{entity.description}</span></> : <span>Pick the legal form of your business. Its description appears here.</span>}</div>
    <fieldset className="onb-fs">
      <legend className="field-label">Nature of business</legend>
      <div className="onb-chips">
        {meta.natures.map((n) => (
          <button key={n.value} type="button" className={`chip${d.nature === n.value ? ' on' : ''}`} aria-pressed={d.nature === n.value} onClick={() => set({ nature: n.value })} title={n.description}>{n.label}</button>
        ))}
      </div>
      {d.nature && <p className="field-hint">{meta.natures.find((n) => n.value === d.nature)?.description}</p>}
    </fieldset>
  </>;
}

// ---------------------------------------------------------------- step 3
function StepIndustry({ d, set, meta, head }) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState(d.industry && !d.industry.code ? d.industry.name : '');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? meta.industries.filter((i) => `${i.name} ${i.sector ?? ''}`.toLowerCase().includes(s)) : meta.industries;
  }, [q, meta]);
  const pick = (i) => set({ industry: { code: i.code, name: i.name } });
  const addCustom = () => { const n = custom.trim().slice(0, 80); if (n.length < 2) return; set({ industry: { name: n } }); setAdding(false); };
  return <>
    <h3 ref={head} tabIndex={-1}>Which industry are you in?</h3>
    <Field label="Search industries"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search, e.g. textiles, software, restaurant" /></Field>
    <p className="field-hint" aria-live="polite">{list.length} {list.length === 1 ? 'industry' : 'industries'}{q ? ' match' : ''}</p>
    <div className="onb-grid" role="group" aria-label="Industries">
      {list.map((i) => (
        <button key={i.code} type="button" className={`onb-ind${d.industry?.code === i.code ? ' on' : ''}`} aria-pressed={d.industry?.code === i.code} onClick={() => pick(i)}>{i.name}</button>
      ))}
      {!list.length && <p className="muted">Nothing matches. Add your industry below.</p>}
    </div>
    {d.industry && <p><Badge tone="brand">Selected: {d.industry.name}</Badge></p>}
    {!adding ? <button type="button" className="linklike" onClick={() => setAdding(true)}>Cannot find yours? Add your industry</button> : (
      <div className="onb-row">
        <input aria-label="Your industry" value={custom} maxLength={80} onChange={(e) => setCustom(e.target.value)} placeholder="Your industry" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
        <button type="button" onClick={addCustom} disabled={custom.trim().length < 2}>Use this</button>
        <button type="button" className="linklike" onClick={() => setAdding(false)}>Cancel</button>
      </div>
    )}
    <Field label="Business type" hint="We pick this from your industry and nature of business. Change it only if it is not right.">
      <select value={d.sector} onChange={(e) => set({ sector: e.target.value, sectorTouched: true })}>
        <option value="">Detect automatically</option>
        {meta.sectors.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </Field>
  </>;
}

// ---------------------------------------------------------------- step 4
function StepDetails({ d, set, on, meta, head, filled, setErr, entity }) {
  const [more, setMore] = useState(!!(d.secondaryMobile || d.secondaryEmail || d.contactPerson));
  const fileRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const g = d.gstin;
  const gProblem = !d.noGst ? gstinProblem(g) : '';
  const gOk = g.length === 15 && !gProblem;
  const derivedState = gOk ? STATES[g.slice(0, 2)] : '';

  async function pickLogo(file) {
    if (!file) return;
    setErr('');
    try { set({ logo: await shrinkLogo(file) }); } catch (e) { setErr(e.message); }
  }
  const onGstin = (e) => {
    const v = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15);
    set({ gstin: v, ...(v.length === 15 && !gstinProblem(v) ? { pan: d.pan || v.slice(2, 12), stateCode: v.slice(0, 2) } : {}) });
  };

  return <>
    <h3 ref={head} tabIndex={-1}>Your business details</h3>
    {filled.length > 0 && <Notice tone="ok">Auto-filled from your {filled.map((f) => `${DOC_NAME[f.doc]} (${f.labels.join(', ')})`).join('; ')}. Please check and edit anything that is not right.</Notice>}

    <fieldset className="onb-fs">
      <legend className="field-label">GST registration</legend>
      {!d.noGst ? <>
        <Field label="GSTIN (optional)" error={g && gProblem} hint={gOk ? undefined : 'The 15-character GST number.'}>
          <input value={g} onChange={onGstin} placeholder="e.g. 29ABCDE1234F1Z5" autoCapitalize="characters" spellCheck={false} maxLength={15} aria-invalid={!!(g && gProblem)} />
        </Field>
        {gOk && <p className="onb-ok" role="status">Valid GSTIN. State: <b>{derivedState}</b>. PAN: <b>{g.slice(2, 12)}</b>.</p>}
        <div className="onb-row">
          <button type="button" onClick={() => openGstPortal(g)} disabled={!gOk}>GST portal ↗</button>
          <button type="button" className="linklike" onClick={() => set({ noGst: true, gstin: '', stateCode: '' })}>Skip — I am not registered for GST</button>
        </div>
        <p className="field-hint">The GST portal opens in a new tab with your GSTIN copied, so you can check the registered name and address and paste them here.</p>
      </> : <>
        <Field label="State"><select value={d.stateCode} onChange={on('stateCode')}><option value="">Choose your state…</option>{Object.entries(STATES).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
        <button type="button" className="linklike" onClick={() => set({ noGst: false })}>I have a GSTIN after all</button>
      </>}
    </fieldset>

    <div className="onb-two">
      <Field label="Legal name" hint="As on your registration."><input value={d.legalName} onChange={on('legalName')} maxLength={200} autoComplete="off" /></Field>
      <Field label="Trade name (optional)"><input value={d.tradeName} onChange={on('tradeName')} maxLength={200} autoComplete="off" /></Field>
    </div>
    <Field label="Company name in IBMP" hint="Shown on your dashboard and invoices.">
      <input value={d.company} onChange={(e) => set({ company: e.target.value, companyTouched: true })} maxLength={200} autoComplete="organization" onFocus={() => { if (!d.company && (d.tradeName || d.legalName)) set({ company: d.tradeName || d.legalName }); }} />
    </Field>
    <Field label="PAN (optional)"><input value={d.pan} onChange={(e) => set({ pan: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10) })} placeholder="ABCDE1234F" maxLength={10} spellCheck={false} /></Field>

    <fieldset className="onb-fs">
      <legend className="field-label">Registered address</legend>
      <Field label="Address line 1"><input value={d.addr1} onChange={on('addr1')} maxLength={120} autoComplete="address-line1" /></Field>
      <Field label="Address line 2"><input value={d.addr2} onChange={on('addr2')} maxLength={120} autoComplete="address-line2" /></Field>
      <div className="onb-two">
        <Field label="City"><input value={d.loc} onChange={on('loc')} maxLength={60} autoComplete="address-level2" /></Field>
        <Field label="PIN code"><input inputMode="numeric" value={d.pin} onChange={(e) => set({ pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} maxLength={6} autoComplete="postal-code" /></Field>
      </div>
      {gOk && <p className="field-hint">State: {derivedState} (from your GSTIN).</p>}
      {!gOk && !d.noGst && <Field label="State" hint="Needed when you do not enter a GSTIN."><select value={d.stateCode} onChange={on('stateCode')}><option value="">Choose your state…</option>{Object.entries(STATES).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>}
    </fieldset>

    <div className="onb-two">
      <Field label="Business phone (optional)"><input type="tel" value={d.phone} onChange={on('phone')} maxLength={18} autoComplete="off" /></Field>
      <Field label="Website (optional)"><input type="url" value={d.website} onChange={on('website')} maxLength={200} placeholder="www.example.com" autoComplete="url" /></Field>
    </div>

    {!more ? <button type="button" className="linklike" onClick={() => setMore(true)}>+ Add secondary contact</button> : (
      <fieldset className="onb-fs">
        <legend className="field-label">Secondary contact</legend>
        <Field label="Contact person"><input value={d.contactPerson} onChange={on('contactPerson')} maxLength={120} /></Field>
        <div className="onb-two">
          <Field label="Mobile"><input type="tel" value={d.secondaryMobile} onChange={on('secondaryMobile')} maxLength={16} /></Field>
          <Field label="Email"><input type="email" value={d.secondaryEmail} onChange={on('secondaryEmail')} maxLength={254} /></Field>
        </div>
      </fieldset>
    )}

    <div className="onb-two">
      <Field label="Annual turnover (optional)"><select value={d.turnoverSlab} onChange={on('turnoverSlab')}><option value="">Choose…</option>{meta.turnoverSlabs.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
      <Field label="Number of employees (optional)"><select value={d.employeeRange} onChange={on('employeeRange')}><option value="">Choose…</option>{meta.employeeRanges.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
    </div>

    {isCompanyType(entity) && (
      <div className="onb-two">
        <Field label="CIN (optional)"><input value={d.cin} onChange={(e) => set({ cin: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 21) })} maxLength={21} spellCheck={false} /></Field>
        <Field label="Date of incorporation (optional)"><input type="date" value={d.incorporatedOn} onChange={on('incorporatedOn')} max={new Date().toISOString().slice(0, 10)} /></Field>
      </div>
    )}

    <div>
      <span className="field-label">Company logo (optional)</span>
      <div className={`onb-logo${drag ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); pickLogo(e.dataTransfer.files?.[0]); }}>
        <div className="logo-box">{d.logo ? <img src={d.logo} alt="Your logo" /> : <span>No logo</span>}</div>
        <div>
          <button type="button" onClick={() => fileRef.current?.click()}>{d.logo ? 'Change logo' : 'Choose logo'}</button>
          {d.logo && <button type="button" className="linklike" onClick={() => set({ logo: '' })}>Remove</button>}
          <p className="field-hint">PNG, JPEG or WebP. It is resized for invoices. You can also drop an image here.</p>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; pickLogo(f); }} />
        </div>
      </div>
    </div>
  </>;
}

// ---------------------------------------------------------------- step 5
function StepPlan({ d, set, meta, head }) {
  return <>
    <h3 ref={head} tabIndex={-1}>Choose your plan</h3>
    <p className="muted">Start with the free {meta.trialDays}-day trial. You will be asked to pay only when your trial ends.</p>
    <div className="onb-plans" role="radiogroup" aria-label="Plan">
      <PlanCard on={d.preferredPlan === 'trial'} onPick={() => set({ preferredPlan: 'trial' })} name={`Free trial`} price="Free" sub={`${meta.trialDays} days, no card needed`} />
      {meta.plans.filter((p) => p.code !== 'trial').map((p) => (
        <PlanCard key={p.code} on={d.preferredPlan === p.code} onPick={() => set({ preferredPlan: p.code })} name={p.name} price={`${inr(p.monthly)}/month`} sub="Preferred plan after your trial" items={p.highlights} />
      ))}
    </div>
    <p className="field-hint">Choosing a paid plan here only records your preference. Nothing is charged now.</p>
  </>;
}
function PlanCard({ on, onPick, name, price, sub, items }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`onb-plan${on ? ' on' : ''}`} onClick={onPick}>
      <b>{name}</b><strong>{price}</strong><small>{sub}</small>
      {items?.length > 0 && <ul>{items.map((h) => <li key={h}>{h}</li>)}</ul>}
    </button>
  );
}

// ---------------------------------------------------------------- step 6
function StepDone({ done, d, meta, head, onAuth }) {
  const s = done.summary ?? {};
  const plan = d.preferredPlan === 'trial' ? null : meta.plans.find((p) => p.code === d.preferredPlan);
  const date = (v) => { if (!v) return ''; const t = new Date(v); return Number.isNaN(+t) ? String(v) : t.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }); };
  const rows = [
    s.accountsCreated != null && ['Chart of accounts', `${s.accountsCreated} accounts created`],
    s.invoiceTemplate && ['Invoice template', s.invoiceTemplate === true ? 'Ready: add your logo and bank details in Business profile' : String(s.invoiceTemplate)],
    s.complianceCalendarFrom && ['Compliance calendar', `Set up from ${date(s.complianceCalendarFrom)}`],
    s.trialEnds && ['Free trial', `Runs until ${date(s.trialEnds)}`],
    ['Preferred plan', plan ? `${plan.name} (${inr(plan.monthly)}/month, only after your trial)` : s.preferredPlan && s.preferredPlan !== 'trial' ? String(s.preferredPlan) : 'Free trial'],
  ].filter(Boolean);
  return (
    <div className="onb-card onb-done" aria-live="polite">
      <div className="onb-check" aria-hidden="true">✓</div>
      <h3 ref={head} tabIndex={-1}>Your workspace is ready</h3>
      <p className="muted">{done.company?.name ? `${done.company.name} is set up.` : 'Your company is set up.'} Here is what we prepared for you.</p>
      <dl className="onb-sum">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <button type="button" className="primary" onClick={onAuth}>Go to my dashboard</button>
    </div>
  );
}
