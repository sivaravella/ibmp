// Payment gateway providers. One interface so the billing code never mentions a specific gateway:
//   createOrder({ amountPaise, receipt, notes }) -> { orderId }
//   verifyPayment({ orderId, paymentId, signature }) -> boolean        (checkout callback)
//   verifyWebhook(rawBody, headers) -> boolean                          (server-to-server notification)
//   parseWebhook(json) -> { orderId, paymentId, amountPaise, paid } | null
//
// The Razorpay adapter follows Razorpay's documented Orders API and signature scheme (HMAC-SHA256 of
// "order_id|payment_id" with the key secret for checkout; HMAC-SHA256 of the raw body with the webhook secret for
// webhooks). It has been exercised against a stubbed HTTP layer only, never a live account: run it in Razorpay's
// test mode before going live. Recurring auto-debit (Razorpay Subscriptions / e-mandates) is deliberately not used:
// each billing period is a one-off order that the customer pays.
import crypto from 'node:crypto';

export const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const gatewayError = (message) => Object.assign(new Error(message), { status: 502, code: 'GATEWAY_ERROR' });

export function razorpayProvider({ keyId, keySecret, webhookSecret, fetchImpl = fetch }) {
  return {
    name: 'razorpay',
    mode: keyId.startsWith('rzp_test_') ? 'test' : 'live',
    keyId,
    async createOrder({ amountPaise, receipt, notes }) {
      let res;
      try {
        res = await fetchImpl('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
          body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
        });
      } catch { throw gatewayError('Could not reach the payment gateway'); }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.id) throw gatewayError(body?.error?.description || 'The payment gateway rejected the order');
      return { orderId: body.id };
    },
    verifyPayment: ({ orderId, paymentId, signature }) => safeEqual(hmac(keySecret, `${orderId}|${paymentId}`), signature),
    verifyWebhook: (rawBody, headers) => !!webhookSecret && safeEqual(hmac(webhookSecret, rawBody), headers['x-razorpay-signature']),
    parseWebhook(json) {
      const event = json?.event;
      if (!['payment.captured', 'order.paid', 'payment.failed'].includes(event)) return null;
      const p = json?.payload?.payment?.entity;
      if (!p?.order_id) return null;
      return { orderId: p.order_id, paymentId: p.id, amountPaise: Number(p.amount), paid: event !== 'payment.failed' };
    },
  };
}

/** Simulated gateway for development and tests: same signature scheme, fixed secrets, no network. Never used in production. */
export function mockProvider() {
  const secret = 'mock_key_secret', webhookSecret = 'mock_webhook_secret';
  return {
    name: 'mock',
    mode: 'simulated',
    keyId: 'mock_key',
    secret, webhookSecret,
    async createOrder() { return { orderId: `order_mock_${crypto.randomBytes(8).toString('hex')}` }; },
    verifyPayment: ({ orderId, paymentId, signature }) => safeEqual(hmac(secret, `${orderId}|${paymentId}`), signature),
    verifyWebhook: (rawBody, headers) => safeEqual(hmac(webhookSecret, rawBody), headers['x-mock-signature']),
    parseWebhook(json) {
      if (!['payment.captured', 'payment.failed'].includes(json?.event) || !json?.orderId) return null;
      return { orderId: json.orderId, paymentId: json.paymentId, amountPaise: Number(json.amountPaise), paid: json.event === 'payment.captured' };
    },
    /** What a real gateway's checkout would hand back after a successful payment. */
    sign: ({ orderId, paymentId }) => hmac(secret, `${orderId}|${paymentId}`),
  };
}

/** Razorpay when keys are configured; otherwise the simulator outside production; otherwise none. */
export function resolveGateway(env = process.env, fetchImpl = fetch) {
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)
    return razorpayProvider({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, fetchImpl });
  return env.NODE_ENV === 'production' && env.ENABLE_SIMULATORS !== 'true' ? null : mockProvider();
}
