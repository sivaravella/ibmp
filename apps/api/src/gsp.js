// GST Suvidha Provider (GSP) gateway: one interface so the filing workflow never mentions a specific provider.
//
//   sendOtp({ gstin, username })                      -> { requestId }              GSP asks the portal to send an OTP
//   verifyOtp({ gstin, username, otp, requestId })    -> { token, expiresAt }       exchanges the OTP for a portal session
//   searchGstin({ gstin })                            -> taxpayer details           public GSTIN search
//   saveReturn({ type, gstin, period, payload, session })    -> { referenceId }     uploads the return (GSTR1 / GSTR3B)
//   returnStatus({ type, gstin, period, referenceId, session }) -> { status, errors } 'P' processed, 'ER' errors, 'IP' in progress
//   submitReturn({ type, gstin, period, session })    -> {}                         freezes the return for filing
//   fileReturn({ type, gstin, period, pan, evcOtp, session, paymentRef, liability }) -> { arn, filedOn }
//   generateIrn({ gstin, payload, session })          -> { irn, ackNo, ackDate, signedQr }   e-invoice (IRP)
//   cancelIrn({ gstin, irn, reason, remarks, session })    -> { cancelledOn }                within 24 hours of generation
//   generateEwb({ gstin, payload, session })          -> { ewbNo, ewbDate, validUpto }       e-way bill
//   updateVehicle({ gstin, ewbNo, vehicleNo, reason, remarks, session }) -> { vehUpdDate, validUpto }
//   cancelEwb({ gstin, ewbNo, reason, remarks, session })  -> { cancelledOn }                within 24 hours
//
// Only the SIMULATED provider exists. Masters India and Tera Software are named in the product plan but no adapter has been
// written: that needs each provider's API documentation and sandbox credentials. To add one, implement the methods above
// against its API and return it from resolveGsp(). Nothing else in the application needs to change.
import crypto from 'node:crypto';
import { gstinValid, panOfGstin } from './gstin.js';
import { EWB_MAX_KM, PIN_RE, VEHICLE_RE, ewbDays } from './einvoice.js';

export const gspError = (status, message, errors = []) => Object.assign(new Error(message), { status, code: 'GSP_ERROR', errors });

export const SIM_OTP = '123456';

/**
 * A stand-in for a GSP that behaves like one without touching any real system. It has no data about real taxpayers:
 * everything it returns is derived from the GSTIN or the payload and labelled SIMULATED. Use it to develop and test the
 * filing flow; it proves nothing about what the real portal will accept.
 *   - OTP is always 123456 (for the portal login and for filing).
 *   - A GSTIN whose 13th character is 9 is reported as cancelled.
 *   - Saving rejects recipients whose GSTIN fails the check-digit test, and invoices whose value is below their taxable value.
 */
export function simulatedGsp() {
  const irns = new Map(), byIrn = new Map(), ewbs = new Map();       // e-invoices (by document key and by IRN) and e-way bills
  const returns = new Map();          // `${gstin}|${type}|${period}` -> { status, errors, referenceId, submitted, filed }
  const k = (a) => `${a.gstin}|${a.type}|${a.period}`;
  const rand = () => crypto.randomBytes(5).toString('hex').toUpperCase();
  const needSession = (s) => { if (!s?.token?.startsWith('sim_')) throw gspError(401, 'The GST portal session is not valid. Connect again.'); };

  return {
    name: 'simulated',
    mode: 'simulated',
    async sendOtp({ gstin }) {
      if (!gstinValid(gstin)) throw gspError(400, 'This company\'s GSTIN is not valid.');
      return { requestId: `req_${rand()}`, hint: `SIMULATED GSP: no OTP is really sent. Enter ${SIM_OTP}.` };
    },
    async verifyOtp({ otp }) {
      if (otp !== SIM_OTP) throw gspError(400, 'The OTP is incorrect or has expired.');
      return { token: `sim_${rand()}`, expiresAt: new Date(Date.now() + 6 * 3600 * 1000) };
    },
    async searchGstin({ gstin }) {
      const pan = panOfGstin(gstin);
      return {
        gstin, state_code: gstin.slice(0, 2), pan,
        legal_name: `SIMULATED TAXPAYER ${pan}`, trade_name: `SIMULATED TRADERS ${pan.slice(0, 5)}`,
        status: gstin[12] === '9' ? 'Cancelled' : 'Active', taxpayer_type: 'Regular', registration_date: '2020-01-01',
        address: 'SIMULATED ADDRESS: not real data', simulated: true,
      };
    },
    async saveReturn({ type, gstin, period, payload, session }) {
      needSession(session);
      const errors = [];
      if (payload.gstin !== gstin) errors.push({ code: 'RET-001', message: 'GSTIN in the return does not match the logged-in GSTIN.' });
      if (type === 'GSTR1') {
        const seen = new Set();
        for (const g of payload.b2b ?? []) {
          if (!gstinValid(g.ctin)) errors.push({ code: 'RET-B2B-GSTIN', message: `Invalid recipient GSTIN ${g.ctin}.` });
          for (const i of g.inv) {
            if (seen.has(i.inum)) errors.push({ code: 'RET-DUP', message: `Duplicate invoice number ${i.inum}.` });
            seen.add(i.inum);
            const taxable = i.itms.reduce((s, x) => s + x.itm_det.txval, 0);
            if (i.val + 0.01 < taxable) errors.push({ code: 'RET-VAL', message: `Invoice ${i.inum}: value is less than its taxable value.` });
          }
        }
        for (const g of payload.cdnr ?? []) if (!gstinValid(g.ctin)) errors.push({ code: 'RET-CDN-GSTIN', message: `Invalid recipient GSTIN ${g.ctin} on a credit note.` });
      }
      const referenceId = `SIMREF${rand()}`;
      returns.set(k({ gstin, type, period }), { status: errors.length ? 'ER' : 'P', errors, referenceId, submitted: false, filed: false });
      return { referenceId };
    },
    async returnStatus({ type, gstin, period, session }) {
      needSession(session);
      const r = returns.get(k({ gstin, type, period }));
      if (!r) throw gspError(404, 'Nothing has been saved for this return.');
      return { status: r.status, errors: r.errors };
    },
    async submitReturn({ type, gstin, period, session }) {
      needSession(session);
      const r = returns.get(k({ gstin, type, period }));
      if (!r) throw gspError(409, 'Save the return before submitting it.');
      if (r.status !== 'P') throw gspError(409, 'The return has errors and cannot be submitted.', r.errors);
      r.submitted = true;
      return {};
    },
    async fileReturn({ type, gstin, period, evcOtp, session, paymentRef, liability }) {
      needSession(session);
      const r = returns.get(k({ gstin, type, period }));
      if (!r?.submitted) throw gspError(409, 'Submit the return before filing it.');
      if (r.filed) throw gspError(409, 'This return is already filed.');
      if (evcOtp !== SIM_OTP) throw gspError(400, 'The EVC OTP is incorrect or has expired.');
      if (type === 'GSTR3B' && liability > 0 && !paymentRef)
        throw gspError(409, `Tax of ₹${liability} must be paid in cash (challan) before GSTR-3B can be filed.`);
      r.filed = true;
      return { arn: `SIM${gstin.slice(0, 2)}${period.slice(5, 7)}${period.slice(2, 4)}${rand()}`, filedOn: new Date().toISOString().slice(0, 10) };
    },
    // ---- e-invoice (IRP) ----
    async generateIrn({ gstin, payload, session }) {
      needSession(session);
      const errors = [];
      const s = payload.SellerDtls, b = payload.BuyerDtls, d = payload.DocDtls, v = payload.ValDtls;
      if (s.Gstin !== gstin) errors.push({ code: '2189', message: 'The seller GSTIN does not match the logged-in GSTIN.' });
      if (!gstinValid(b.Gstin)) errors.push({ code: '3028', message: `Invalid buyer GSTIN ${b.Gstin}.` });
      for (const [who, p] of [['seller', s], ['buyer', b]]) if (!PIN_RE.test(String(p.Pin))) errors.push({ code: '3037', message: `The ${who} PIN code is not valid.` });
      const itemTotal = payload.ItemList.reduce((x, i) => x + i.TotItemVal, 0);
      if (Math.abs(itemTotal + v.RndOffAmt - v.TotInvVal) > 1) errors.push({ code: '2172', message: 'The invoice value does not match the sum of its items.' });
      for (const i of payload.ItemList) if (Math.abs(i.AssAmt * i.GstRt / 100 - (i.IgstAmt + i.CgstAmt + i.SgstAmt)) > 1) errors.push({ code: '2178', message: `Item ${i.SlNo}: tax does not match the GST rate.` });
      if (errors.length) throw gspError(400, 'The IRP rejected the invoice.', errors);

      const [dd, mm, yy] = d.Dt.split('/').map(Number);
      const fy = mm >= 4 ? `${yy}-${String((yy + 1) % 100).padStart(2, '0')}` : `${yy - 1}-${String(yy % 100).padStart(2, '0')}`;
      const key = `${gstin}|${d.Typ}|${d.No}|${fy}`;
      const prior = irns.get(key);
      if (prior && !prior.cancelled) throw gspError(409, 'Duplicate IRN: this document has already been reported.', [{ code: '2150', message: 'Duplicate IRN', irn: prior.irn }]);
      const irn = crypto.createHash('sha256').update(key).digest('hex');        // SIMULATED algorithm: the real IRN is issued by the IRP
      const rec = { irn, ackNo: String(112000000000000 + irns.size + 1), ackAt: Date.now(), cancelled: false, key };
      irns.set(key, rec);
      byIrn.set(irn, rec);
      const qr = Buffer.from(JSON.stringify({ iss: 'SIMULATED', SellerGstin: gstin, BuyerGstin: b.Gstin, DocNo: d.No, DocTyp: d.Typ, DocDt: d.Dt, TotInvVal: v.TotInvVal, ItemCnt: payload.ItemList.length, MainHsnCode: payload.ItemList[0].HsnCd, Irn: irn })).toString('base64url');
      return { irn, ackNo: rec.ackNo, ackDate: new Date(rec.ackAt), signedQr: `SIMULATED.${qr}`, simulated: true };
    },
    async cancelIrn({ irn, reason, session }) {
      needSession(session);
      const rec = byIrn.get(irn);
      if (!rec) throw gspError(404, 'No such IRN.');
      if (rec.cancelled) throw gspError(409, 'This IRN is already cancelled.');
      if (![1, 2, 3, 4].includes(reason)) throw gspError(400, 'Choose a cancellation reason.');
      if (Date.now() - rec.ackAt > 24 * 3600 * 1000) throw gspError(409, 'An IRN can only be cancelled within 24 hours of generation.', [{ code: '9999', message: 'Cancellation window over' }]);
      rec.cancelled = true;
      return { cancelledOn: new Date() };
    },

    // ---- e-way bill ----
    async generateEwb({ gstin, payload, session }) {
      needSession(session);
      const errors = [];
      if (payload.fromGstin !== gstin) errors.push({ code: '304', message: 'The supplier GSTIN does not match the logged-in GSTIN.' });
      for (const k of ['fromPincode', 'toPincode']) if (!PIN_RE.test(String(payload[k]))) errors.push({ code: '312', message: `${k} is not a valid PIN code.` });
      if (!(payload.totalValue > 0)) errors.push({ code: '320', message: 'The goods value must be above zero.' });
      if (payload.transDistance > EWB_MAX_KM) errors.push({ code: '330', message: `Distance cannot exceed ${EWB_MAX_KM} km.` });
      if (payload.vehicleNo && !VEHICLE_RE.test(payload.vehicleNo)) errors.push({ code: '338', message: 'Invalid vehicle number.' });
      if (errors.length) throw gspError(400, 'The e-way bill portal rejected the request.', errors);
      const key = `${payload.fromGstin}|${payload.docNo}`;
      const prior = [...ewbs.values()].find((e) => e.key === key && !e.cancelled);
      if (prior) throw gspError(409, 'An e-way bill already exists for this document.', [{ code: '604', message: 'E-way bill already generated for this document', ewbNo: prior.ewbNo }]);

      const km = payload.transDistance || 100;                         // 0 asks the portal to work it out from the PIN codes: the simulator assumes 100 km
      const days = ewbDays(km, payload.vehicleType === 'O');
      const now = new Date();
      const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 23, 59, 0));
      const ewbNo = String(331000000000 + ewbs.size + 1);
      ewbs.set(ewbNo, { ewbNo, key, createdAt: now.getTime(), validUpto: until, vehicleNo: payload.vehicleNo ?? null, cancelled: false });
      return { ewbNo, ewbDate: now, validUpto: until, simulated: true };
    },
    async updateVehicle({ ewbNo, vehicleNo, reason, session }) {
      needSession(session);
      const e = ewbs.get(ewbNo);
      if (!e || e.cancelled) throw gspError(404, 'No active e-way bill with that number.');
      if (!VEHICLE_RE.test(vehicleNo)) throw gspError(400, 'Invalid vehicle number.', [{ code: '338', message: 'Invalid vehicle number.' }]);
      if (![1, 2, 3, 4].includes(reason)) throw gspError(400, 'Choose a reason for the change.');
      e.vehicleNo = vehicleNo;
      return { vehUpdDate: new Date(), validUpto: e.validUpto };
    },
    async cancelEwb({ ewbNo, reason, session }) {
      needSession(session);
      const e = ewbs.get(ewbNo);
      if (!e) throw gspError(404, 'No such e-way bill.');
      if (e.cancelled) throw gspError(409, 'This e-way bill is already cancelled.');
      if (![1, 2, 3, 4].includes(reason)) throw gspError(400, 'Choose a cancellation reason.');
      if (Date.now() - e.createdAt > 24 * 3600 * 1000) throw gspError(409, 'An e-way bill can only be cancelled within 24 hours of generation.');
      e.cancelled = true;
      return { cancelledOn: new Date() };
    },

    /** Test-only: pretend a record was created `hours` ago, to exercise the 24-hour cancellation window. */
    _backdate(kind, id, hours) {
      const rec = kind === 'irn' ? byIrn.get(id) : ewbs.get(id);
      if (kind === 'irn') rec.ackAt -= hours * 3600 * 1000; else rec.createdAt -= hours * 3600 * 1000;
    },
  };
}

/** A placeholder for a GSP the product plans to use but that has no adapter yet: every call explains what is missing. */
function notImplemented(name) {
  const fail = async () => { throw gspError(501, `The ${name} integration is not built yet: it needs ${name}'s API documentation and sandbox credentials.`); };
  return { name, mode: 'not_implemented', sendOtp: fail, verifyOtp: fail, searchGstin: fail, saveReturn: fail, returnStatus: fail, submitReturn: fail, fileReturn: fail,
    generateIrn: fail, cancelIrn: fail, generateEwb: fail, updateVehicle: fail, cancelEwb: fail };
}

/** GSP_PROVIDER=simulated (the default outside production), masters_india or tera (not implemented yet). Nothing in production. */
export function resolveGsp(env = process.env) {
  const p = env.GSP_PROVIDER;
  if (p === 'masters_india' || p === 'tera') return notImplemented(p);
  if (p === 'simulated' || (!p && (env.NODE_ENV !== 'production' || env.ENABLE_SIMULATORS === 'true'))) return simulatedGsp();
  return null;
}
