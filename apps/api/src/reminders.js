// Compliance reminders: which open items to remind about today, the message for each channel, and the runner that sends them.
// The decision logic is pure; the runner reads settings and items, sends through the channels (see notify.js) and logs every message.
import { addDays, daysBetween } from './billing.js';
import { subscriptionStatus } from './billing.js';
import { DEFAULT_SMS_TEMPLATE, renderSmsTemplate } from './notify.js';

export const CHANNEL_LABEL = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };
/** Channels where a message may only go to someone whose agreement the owner has confirmed. */
export const NEEDS_CONSENT = new Set(['whatsapp', 'sms']);
import { loadSubscription } from './subscription.js';

export const DEFAULT_LEAD = [7, 3, 1, 0];
export const DEFAULT_OVERDUE = [1, 3, 7];

const unique = (a) => [...new Set(a)];
/** '7,3,1' -> [7,3,1]; rejects anything that is not a whole number of days in range. */
export function parseDays(text, { min, max, order = 'desc' }) {
  const parts = String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < min || n > max)) return null;
  return unique(nums).sort((a, b) => (order === 'asc' ? a - b : b - a));
}
export const daysText = (a) => a.join(',');

/** Phone numbers are kept as digits with the country code. A bare 10-digit Indian mobile number gets 91. */
export function normalisePhone(raw) {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/[^\d]/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? digits : null;
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  return null;
}
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const maskAddress = (channel, a) => (channel === 'email' ? a.replace(/^(.).*(@.*)$/, '$1***$2') : `${a.slice(0, 2)}******${a.slice(-2)}`);

/** The reminder moments of one item: before the due date, on it, and after it while it stays open. */
export function stagesFor(due, lead = DEFAULT_LEAD, overdue = DEFAULT_OVERDUE) {
  return [
    ...lead.map((n) => ({ stage: n === 0 ? 'due' : `before_${n}`, trigger: addDays(due, -n) })),
    ...overdue.map((n) => ({ stage: `overdue_${n}`, trigger: addDays(due, n) })),
  ].sort((a, b) => a.trigger.localeCompare(b.trigger));
}

export const keyOf = (i, stage) => `${i.rule_code}|${i.period_key}|${stage}|${i.due}`;

/**
 * Items to remind about today. For each open item, the latest reminder moment that has arrived (and is not before `since`, so
 * switching reminders on never floods the recipient with old ones) is used, unless it was already sent: `sent` holds item keys.
 * A server that was down on the exact day still catches up on the next run. Moving the due date starts the sequence again.
 */
export function dueReminders({ items, today, lead = DEFAULT_LEAD, overdue = DEFAULT_OVERDUE, since = null, sent = new Set() }) {
  const out = [];
  for (const i of items) {
    if (i.status === 'completed') continue;
    const arrived = stagesFor(i.due, lead, overdue).filter((s) => s.trigger <= today && (!since || s.trigger >= since));
    const last = arrived[arrived.length - 1];
    if (!last || sent.has(keyOf(i, last.stage))) continue;
    out.push({ ...i, stage: last.stage, key: keyOf(i, last.stage), days: daysBetween(today, i.due) });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));
}

const dmy = (d) => d.split('-').reverse().join('-');
const when = (days) => (days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'due today' : `due in ${days} day${days === 1 ? '' : 's'}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The message for one recipient. Email lists everything; WhatsApp gets the two template variables on a single line (the
 * template parameter may not contain line breaks), kept short.
 */
export function buildMessage({ company, items, channel, appUrl = null, templateName = null, templateLang = 'en', smsTemplate = DEFAULT_SMS_TEMPLATE, smsVarMax = 30 }) {
  const overdue = items.filter((i) => i.days < 0), soon = items.filter((i) => i.days >= 0);
  const line = (i) => `${i.name}: ${dmy(i.due)} (${when(i.days)})`;
  if (channel === 'sms') {
    // Registered SMS templates are fixed text with a few short variables: say how many, and name the most urgent one.
    const first = items[0];
    return { text: renderSmsTemplate(smsTemplate, [company, String(items.length), first.name, dmy(first.due)], smsVarMax) };
  }
  if (channel === 'whatsapp') {
    let summary = items.map(line).join(' | ');
    if (summary.length > 900) summary = `${summary.slice(0, 880).replace(/\s*\|[^|]*$/, '')} | and more`;
    return { text: `Compliance reminder for ${company}: ${summary}`, template: { name: templateName, lang: templateLang, params: [company, summary] } };
  }
  const subject = `${overdue.length ? `${overdue.length} overdue, ` : ''}${items.length} compliance item${items.length === 1 ? '' : 's'} need attention: ${company}`;
  const section = (title, list) => (list.length ? `${title}\n${list.map((i) => `  - ${line(i)}`).join('\n')}\n` : '');
  const foot = `Sent by IBMP for ${company}.${appUrl ? ` Open ${appUrl} to mark items done.` : ''}\nTo stop these emails, ask the account owner to remove your address under Compliance > Reminders.`;
  const text = `${section('OVERDUE', overdue)}${overdue.length && soon.length ? '\n' : ''}${section('COMING UP', soon)}\n${foot}\n`;
  const li = (list, color) => list.map((i) => `<li style="color:${color}">${esc(line(i))}</li>`).join('');
  const html = `<p><strong>${esc(company)}</strong>: compliance items that need attention.</p>${overdue.length ? `<p style="margin-bottom:0"><strong>Overdue</strong></p><ul>${li(overdue, '#b91c1c')}</ul>` : ''}${soon.length ? `<p style="margin-bottom:0"><strong>Coming up</strong></p><ul>${li(soon, '#92400e')}</ul>` : ''}<p style="color:#64748b;font-size:12px">${esc(foot).replace(/\n/g, '<br>')}</p>`;
  return { subject, text, html };
}

// ---------- runner ----------

const ymdOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const q1 = async (pool, sql, p) => (await pool.query(sql, p)).rows[0];

export async function loadSettings(pool, companyId) {
  const r = await q1(pool, 'SELECT * FROM reminder_settings WHERE company_id=$1', [companyId]);
  return {
    emailEnabled: !!r?.email_enabled, whatsappEnabled: !!r?.whatsapp_enabled, smsEnabled: !!r?.sms_enabled,
    lead: parseDays(r?.lead_days ?? daysText(DEFAULT_LEAD), { min: 0, max: 30 }) ?? DEFAULT_LEAD,
    overdue: parseDays(r?.overdue_days ?? daysText(DEFAULT_OVERDUE), { min: 1, max: 60, order: 'asc' }) ?? DEFAULT_OVERDUE,
    since: ymdOf(r?.enabled_since),
  };
}

async function log(pool, row) {
  await pool.query(
    `INSERT INTO reminder_log (company_id, recipient_id, channel, address, kind, item_key, rule_code, period_key, stage, due, status, provider, provider_ref, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [row.companyId, row.recipientId ?? null, row.channel, row.address, row.kind ?? 'reminder', row.itemKey ?? '', row.ruleCode ?? null, row.periodKey ?? null, row.stage ?? null, row.due ?? null, row.status, row.provider ?? null, row.ref ?? null, row.error ?? null]);
}

/**
 * Send (or with dryRun, only list) today's reminders for one company.
 * openItems(companyId, today) must return the company's compliance items with status. Returns what was done per recipient.
 */
export async function runForCompany(pool, { companyId, today, channels, openItems, dryRun = false, appUrl = null }) {
  const settings = await loadSettings(pool, companyId);
  const company = (await q1(pool, 'SELECT name, legal_name FROM companies WHERE id=$1', [companyId]));
  const name = company.legal_name || company.name;
  const items = await openItems(companyId, today);
  const recipients = (await pool.query('SELECT * FROM reminder_recipients WHERE company_id=$1 AND active=true ORDER BY id', [companyId])).rows;
  const sentRows = (await pool.query("SELECT recipient_id, channel, item_key FROM reminder_log WHERE company_id=$1 AND status='sent' AND kind='reminder' AND item_key <> ''", [companyId])).rows;
  const results = [];

  for (const channel of ['email', 'whatsapp', 'sms']) {
    if (!settings[`${channel}Enabled`]) continue;
    const provider = channels[channel];
    for (const rc of recipients.filter((x) => x.channel === channel)) {
      const sent = new Set(sentRows.filter((s) => s.recipient_id === rc.id && s.channel === channel).map((s) => s.item_key));
      const pending = dueReminders({ items, today, lead: settings.lead, overdue: settings.overdue, since: settings.since, sent });
      if (!pending.length) continue;
      const base = { recipient: rc.id, channel, to: maskAddress(channel, rc.address), items: pending.map((i) => ({ name: i.name, due: i.due, stage: i.stage, days: i.days })) };
      if (NEEDS_CONSENT.has(channel) && !rc.consent_at) { results.push({ ...base, status: 'skipped', reason: `No recorded consent for ${CHANNEL_LABEL[channel]}.` }); continue; }
      if (!provider) { results.push({ ...base, status: 'skipped', reason: `${CHANNEL_LABEL[channel]} sending is not configured on this server.` }); continue; }
      if (dryRun) { results.push({ ...base, status: 'would_send' }); continue; }
      const msg = buildMessage({ company: name, items: pending, channel, appUrl, templateName: channels.templateName, templateLang: channels.templateLang, smsTemplate: channels.smsTemplate, smsVarMax: channels.smsVarMax });
      try {
        const out = await provider.send({ to: rc.address, ...msg });
        for (const i of pending) await log(pool, { companyId, recipientId: rc.id, channel, address: rc.address, itemKey: i.key, ruleCode: i.rule_code, periodKey: i.period_key, stage: i.stage, due: i.due, status: 'sent', provider: provider.name, ref: out?.id });
        results.push({ ...base, status: 'sent', provider: provider.name });
      } catch (e) {
        await log(pool, { companyId, recipientId: rc.id, channel, address: rc.address, status: 'failed', provider: provider.name, error: String(e.message).slice(0, 300) });
        results.push({ ...base, status: 'failed', error: e.message });
      }
    }
  }
  return { companyId, today, results };
}

/** The daily job: every company with reminders switched on and a usable subscription. One company's failure never stops the rest. */
export async function runAll(pool, { today, channels, openItems, appUrl = null, onError = () => {} }) {
  const cos = (await pool.query(
    `SELECT c.id, c.billing_company_id, c.archived FROM companies c JOIN reminder_settings s ON s.company_id=c.id WHERE s.email_enabled OR s.whatsapp_enabled OR s.sms_enabled ORDER BY c.id`)).rows;
  const done = [];
  for (const c of cos) {
    try {
      if (c.archived) continue;
      const sub = await loadSubscription(pool, c.billing_company_id ?? c.id, today);
      if (!subscriptionStatus(sub, today).writable) continue;      // an expired subscription is read-only: no reminders either
      done.push(await runForCompany(pool, { companyId: c.id, today, channels, openItems, appUrl }));
    } catch (e) { onError(c.id, e); }
  }
  return done;
}
