import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { CHANNEL_LABEL, EMAIL_RE, NEEDS_CONSENT, buildMessage, daysText, loadSettings, maskAddress, normalisePhone, parseDays, runForCompany } from '../reminders.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const code = (err, c) => Object.assign(err, { code: c });

/** Reminder settings, recipients and history for the active company, and a manual run. The daily job itself lives in server.js. */
export function reminderRoutes(pool, { channels, openItems, appUrl = null }) {
  const r = Router();
  const needOwner = (req) => { if (req.user.role !== 'owner') throw code(httpError(403, 'Only the account owner can change reminders.'), 'OWNER_ONLY'); };
  const chInfo = (c) => (c ? { configured: true, provider: c.name, simulated: c.mode === 'simulated' } : { configured: false, provider: null, simulated: false });

  const view = async (cid) => {
    const s = await loadSettings(pool, cid);
    const recipients = (await pool.query('SELECT * FROM reminder_recipients WHERE company_id=$1 ORDER BY id', [cid])).rows;
    return {
      emailEnabled: s.emailEnabled, whatsappEnabled: s.whatsappEnabled, smsEnabled: s.smsEnabled, leadDays: s.lead, overdueDays: s.overdue, enabledSince: s.since,
      channels: { email: chInfo(channels.email), whatsapp: { ...chInfo(channels.whatsapp), template: channels.templateName }, sms: { ...chInfo(channels.sms), template: channels.smsTemplate, variableMax: channels.smsVarMax } },
      recipients: recipients.map((x) => ({ id: x.id, channel: x.channel, address: x.address, masked: maskAddress(x.channel, x.address), name: x.name, active: x.active, consent: !!x.consent_at })),
    };
  };

  r.get('/reminders/settings', h(async (req, res) => res.json(await view(req.user.companyId))));

  r.put('/reminders/settings', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ emailEnabled: z.boolean(), whatsappEnabled: z.boolean(), smsEnabled: z.boolean(), leadDays: z.array(z.number()).max(10), overdueDays: z.array(z.number()).max(10) }).partial().parse(req.body);
    const cid = req.user.companyId;
    const cur = await loadSettings(pool, cid);
    const lead = b.leadDays ? parseDays(b.leadDays.join(','), { min: 0, max: 30 }) : cur.lead;
    const overdue = b.overdueDays ? parseDays(b.overdueDays.join(','), { min: 1, max: 60, order: 'asc' }) : cur.overdue;
    if (!lead || !lead.length) throw httpError(400, 'Lead days must be whole numbers from 0 to 30 (0 means on the due date).');
    if (!overdue) throw httpError(400, 'Overdue days must be whole numbers from 1 to 60.');
    const email = b.emailEnabled ?? cur.emailEnabled, wa = b.whatsappEnabled ?? cur.whatsappEnabled, sms = b.smsEnabled ?? cur.smsEnabled;
    // Reminders only ever cover moments from the day they were switched on, so enabling never sends a backlog.
    const since = (email || wa || sms) ? (cur.emailEnabled || cur.whatsappEnabled || cur.smsEnabled ? cur.since : todayFn()) : null;
    const vals = [email, wa, sms, daysText(lead), daysText(overdue), since, cid];
    if ((await pool.query('SELECT 1 FROM reminder_settings WHERE company_id=$1', [cid])).rowCount)
      await pool.query('UPDATE reminder_settings SET email_enabled=$1, whatsapp_enabled=$2, sms_enabled=$3, lead_days=$4, overdue_days=$5, enabled_since=$6, updated_at=now() WHERE company_id=$7', vals);
    else await pool.query('INSERT INTO reminder_settings (email_enabled, whatsapp_enabled, sms_enabled, lead_days, overdue_days, enabled_since, company_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', vals);
    res.json(await view(cid));
  }));

  r.post('/reminders/recipients', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ channel: z.enum(['email', 'whatsapp', 'sms']), address: z.string().min(3).max(120), name: z.string().max(80).optional(), consent: z.boolean().optional() }).parse(req.body);
    let address;
    if (b.channel === 'email') {
      address = b.address.trim().toLowerCase();
      if (!EMAIL_RE.test(address)) throw httpError(400, 'That is not a valid email address.');
    } else {
      address = normalisePhone(b.address);
      if (!address) throw httpError(400, 'Enter a mobile number: 10 digits for India, or with + and the country code.');
      if (!b.consent) throw code(httpError(400, `Confirm that this person agreed to receive ${CHANNEL_LABEL[b.channel]} messages from you.${b.channel === 'whatsapp' ? ' WhatsApp requires it.' : ' Indian SMS rules expect it.'}`), 'CONSENT_REQUIRED');
    }
    const cid = req.user.companyId;
    if ((await pool.query('SELECT 1 FROM reminder_recipients WHERE company_id=$1 AND channel=$2 AND address=$3', [cid, b.channel, address])).rowCount) throw httpError(409, 'This recipient is already on the list.');
    if ((await pool.query('SELECT COUNT(*) AS n FROM reminder_recipients WHERE company_id=$1', [cid])).rows[0].n >= 20) throw httpError(400, 'A company can have at most 20 reminder recipients.');
    const row = (await pool.query(
      'INSERT INTO reminder_recipients (company_id, channel, address, name, consent_at, consent_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [cid, b.channel, address, b.name || null, NEEDS_CONSENT.has(b.channel) ? new Date() : null, NEEDS_CONSENT.has(b.channel) ? req.user.id : null])).rows[0];
    res.status(201).json({ id: row.id, channel: b.channel, masked: maskAddress(b.channel, address) });
  }));

  r.put('/reminders/recipients/:id', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    const x = await pool.query('UPDATE reminder_recipients SET active=$1 WHERE id=$2 AND company_id=$3', [b.active, req.params.id, req.user.companyId]);
    if (!x.rowCount) throw httpError(404, 'Not found');
    res.json({ ok: true });
  }));

  r.delete('/reminders/recipients/:id', h(async (req, res) => {
    needOwner(req);
    const x = await pool.query('DELETE FROM reminder_recipients WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId]);
    if (!x.rowCount) throw httpError(404, 'Not found');
    res.json({ ok: true });
  }));

  // A test message to one recipient, so the owner can see the channel works before relying on it. Not counted as a reminder.
  r.post('/reminders/recipients/:id/test', h(async (req, res) => {
    needOwner(req);
    const cid = req.user.companyId;
    const rc = (await pool.query('SELECT * FROM reminder_recipients WHERE id=$1 AND company_id=$2', [req.params.id, cid])).rows[0];
    if (!rc) throw httpError(404, 'Not found');
    const provider = channels[rc.channel];
    if (!provider) throw code(httpError(503, `${CHANNEL_LABEL[rc.channel]} sending is not configured on this server.`), 'CHANNEL_NOT_CONFIGURED');
    const co = (await pool.query('SELECT name, legal_name FROM companies WHERE id=$1', [cid])).rows[0];
    const name = co.legal_name || co.name;
    const sample = [{ name: 'Test reminder (no action needed)', due: todayFn(), days: 0 }];
    const msg = buildMessage({ company: name, items: sample, channel: rc.channel, appUrl, templateName: channels.templateName, templateLang: channels.templateLang, smsTemplate: channels.smsTemplate, smsVarMax: channels.smsVarMax });
    const entry = { companyId: cid, recipientId: rc.id, channel: rc.channel, address: rc.address, kind: 'test', provider: provider.name };
    try {
      const out = await provider.send({ to: rc.address, ...msg });
      await pool.query('INSERT INTO reminder_log (company_id, recipient_id, channel, address, kind, status, provider, provider_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [cid, rc.id, rc.channel, rc.address, 'test', 'sent', provider.name, out?.id ?? null]);
      res.json({ sent: true, provider: provider.name, simulated: provider.mode === 'simulated' });
    } catch (e) {
      await pool.query('INSERT INTO reminder_log (company_id, recipient_id, channel, address, kind, status, provider, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [entry.companyId, entry.recipientId, entry.channel, entry.address, 'test', 'failed', provider.name, String(e.message).slice(0, 300)]);
      throw code(httpError(502, `The ${CHANNEL_LABEL[rc.channel]} provider rejected the test message: ${e.message}`), 'DELIVERY_FAILED');
    }
  }));

  const asOf = (req, src) => {
    const v = src.asOf;
    if (v === undefined) return todayFn();
    if (!isoDate.safeParse(v).success) throw httpError(400, 'asOf must be YYYY-MM-DD');
    return v;
  };

  // What would go out right now, without sending.
  r.get('/reminders/preview', h(async (req, res) => {
    const out = await runForCompany(pool, { companyId: req.user.companyId, today: asOf(req, req.query), channels, openItems, dryRun: true, appUrl });
    res.json(out);
  }));

  // Send what is due now (the daily job does this too; sending twice is harmless because every item is logged).
  r.post('/reminders/run', h(async (req, res) => {
    needOwner(req);
    res.json(await runForCompany(pool, { companyId: req.user.companyId, today: asOf(req, req.body ?? {}), channels, openItems, appUrl }));
  }));

  r.get('/reminders/log', h(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM reminder_log WHERE company_id=$1 ORDER BY id DESC LIMIT 100', [req.user.companyId]);
    res.json(rows.map((x) => ({ id: x.id, channel: x.channel, to: maskAddress(x.channel, x.address), kind: x.kind, ruleCode: x.rule_code, periodKey: x.period_key, stage: x.stage, due: x.due ? ymd(x.due) : null, status: x.status, provider: x.provider, error: x.error, at: x.created_at })));
  }));

  return r;
}
