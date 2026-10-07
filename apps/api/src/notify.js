// Delivery channels for reminders. Same pattern as the payment gateway and the GSP: one small interface, an adapter per provider,
// and a simulator for development that records what would have been sent. Nothing here was tested against a live provider.
//
//   email.send({ to, subject, text, html })            -> { id }
//   whatsapp.send({ to, template: { name, lang, params: [string] }, text }) -> { id }
//
// WhatsApp (Meta Cloud API): a business may only START a conversation with an approved message TEMPLATE. Create one in WhatsApp
// Manager (category Utility) whose body has two variables, for example:
//   "Compliance reminder for {{1}}: {{2}}. Open IBMP for details."
// and put its name in IBMP_WHATSAPP_TEMPLATE. Until Meta approves it, sends are rejected and recorded as failed.
import nodemailer from 'nodemailer';

const GRAPH = 'https://graph.facebook.com/v21.0';

// SMS in India (TRAI DLT): the sender must be registered as a Principal Entity, with a registered sender ID (header), and the text
// of every SMS must match a registered TEMPLATE, where only the {#var#} placeholders may differ. So the wording below is not free:
// register EXACTLY this template (or your own with the same placeholders, in this order) with your DLT operator and put the
// registered text in IBMP_SMS_TEMPLATE. Variables, in order: 1 company, 2 number of items, 3 the most urgent item, 4 its due date.
// Registered variables are typically limited to 30 characters, so values are cut to IBMP_SMS_VAR_MAX (default 30).
export const SMS_VARS = 4;
export const DEFAULT_SMS_TEMPLATE = 'IBMP reminder: {#var#} has {#var#} compliance item(s) to action. Next: {#var#} due {#var#}. Open IBMP for details.';
const VAR = '{#var#}';

/** Problems with a template text, or none. */
export function smsTemplateProblems(template) {
  const t = String(template ?? '');
  const n = t.split(VAR).length - 1;
  const p = [];
  if (!n) p.push(`The SMS template needs at least one ${VAR} placeholder.`);
  if (n > SMS_VARS) p.push(`The SMS template can have at most ${SMS_VARS} ${VAR} placeholders (company, item count, next item, due date), not ${n}.`);
  if (t.length > 500) p.push('The SMS template is longer than 500 characters.');
  return p;
}

/** Fill the placeholders in order. Values are single-line and cut to `max` characters (DLT variable limit). */
export function renderSmsTemplate(template, values, max = 30) {
  const problems = smsTemplateProblems(template);
  if (problems.length) throw new Error(problems[0]);
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  const parts = template.split(VAR);
  return parts.map((p, i) => p + (i < parts.length - 1 ? clean(values[i]) : '')).join('');
}

/** Records instead of sending. `sent` is for tests and the dev outbox. */
export function simulatedChannels() {
  const sent = [];
  let n = 0;
  const make = (channel) => ({ name: 'simulated', mode: 'simulated', send: async (msg) => { const id = `sim-${channel}-${++n}`; sent.push({ channel, id, ...msg }); return { id }; } });
  return { email: make('email'), whatsapp: make('whatsapp'), sms: make('sms'), sent, templateName: 'ibmp_compliance_reminder', templateLang: 'en', smsTemplate: DEFAULT_SMS_TEMPLATE, smsVarMax: 30 };
}

/**
 * Twilio Programmable Messaging: POST /2010-04-01/Accounts/{sid}/Messages.json with HTTP Basic auth and form fields To, Body and
 * From (a registered sender ID or number) or MessagingServiceSid. A 201 returns { sid, status }; an error returns { code, message }.
 * (Checked against Twilio's published Message resource documentation; not run against a live account.)
 */
export function twilioSms({ accountSid, authToken, from = null, messagingServiceSid = null, fetchImpl = fetch }) {
  return {
    name: 'twilio', mode: 'live',
    send: async ({ to, text }) => {
      const form = new URLSearchParams({ To: `+${to}`, Body: text });
      if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid); else form.set('From', from);
      const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.message ? `${body.message}${body.code ? ` (Twilio error ${body.code})` : ''}` : `SMS request failed (${r.status})`);
      return { id: body?.sid ?? null };
    },
  };
}

export function smtpEmail({ url, from, transport = null }) {
  const t = transport ?? nodemailer.createTransport(url);
  return {
    name: 'smtp', mode: 'live',
    send: async ({ to, subject, text, html }) => {
      const info = await t.sendMail({ from, to, subject, text, html });
      return { id: info.messageId };
    },
  };
}

export function whatsappCloud({ token, phoneId, template, lang = 'en', fetchImpl = fetch }) {
  return {
    name: 'whatsapp_cloud', mode: 'live',
    send: async ({ to, template: t }) => {
      const r = await fetchImpl(`${GRAPH}/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to, type: 'template',
          template: { name: t?.name ?? template, language: { code: t?.lang ?? lang }, components: [{ type: 'body', parameters: (t?.params ?? []).map((text) => ({ type: 'text', text })) }] },
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error?.message || `WhatsApp request failed (${r.status})`);
      return { id: body?.messages?.[0]?.id ?? null };
    },
  };
}

/**
 * Real adapters when configured (SMTP_URL + MAIL_FROM; WHATSAPP_TOKEN + WHATSAPP_PHONE_ID + WHATSAPP_TEMPLATE), otherwise the
 * simulator outside production (or with ENABLE_SIMULATORS), otherwise nothing: a channel that is not configured is reported, not faked.
 */
export function resolveChannels(env = process.env, fetchImpl = fetch) {
  const sim = env.NODE_ENV !== 'production' || env.ENABLE_SIMULATORS === 'true' ? simulatedChannels() : null;
  const email = env.SMTP_URL && env.MAIL_FROM ? smtpEmail({ url: env.SMTP_URL, from: env.MAIL_FROM }) : sim?.email ?? null;
  const whatsapp = env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID && env.WHATSAPP_TEMPLATE
    ? whatsappCloud({ token: env.WHATSAPP_TOKEN, phoneId: env.WHATSAPP_PHONE_ID, template: env.WHATSAPP_TEMPLATE, lang: env.WHATSAPP_LANG || 'en', fetchImpl })
    : sim?.whatsapp ?? null;
  // Real SMS needs Twilio credentials, a sender (or messaging service) AND a valid registered template; a half configuration is none.
  const smsTemplate = env.SMS_TEMPLATE || DEFAULT_SMS_TEMPLATE;
  const smsLive = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.SMS_FROM || env.TWILIO_MESSAGING_SERVICE_SID) && env.SMS_TEMPLATE && !smsTemplateProblems(env.SMS_TEMPLATE).length;
  const sms = smsLive
    ? twilioSms({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.SMS_FROM, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID, fetchImpl })
    : sim?.sms ?? null;
  return {
    email, whatsapp, sms, sent: sim?.sent ?? [], templateName: env.WHATSAPP_TEMPLATE || 'ibmp_compliance_reminder', templateLang: env.WHATSAPP_LANG || 'en',
    smsTemplate: smsLive ? env.SMS_TEMPLATE : smsTemplate, smsVarMax: Number(env.SMS_VAR_MAX) > 0 ? Number(env.SMS_VAR_MAX) : 30,
  };
}
