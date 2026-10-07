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

/** Records instead of sending. `sent` is for tests and the dev outbox. */
export function simulatedChannels() {
  const sent = [];
  let n = 0;
  const make = (channel) => ({ name: 'simulated', mode: 'simulated', send: async (msg) => { const id = `sim-${channel}-${++n}`; sent.push({ channel, id, ...msg }); return { id }; } });
  return { email: make('email'), whatsapp: make('whatsapp'), sent, templateName: 'ibmp_compliance_reminder', templateLang: 'en' };
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
  return { email, whatsapp, sent: sim?.sent ?? [], templateName: env.WHATSAPP_TEMPLATE || 'ibmp_compliance_reminder', templateLang: env.WHATSAPP_LANG || 'en' };
}
