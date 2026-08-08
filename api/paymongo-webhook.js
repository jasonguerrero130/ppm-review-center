// Vercel serverless function: POST /api/paymongo-webhook
// This is the ONLY place a subscription is ever marked active. PayMongo calls
// this endpoint server-to-server after a real payment succeeds — the browser
// is never trusted to report "payment succeeded" on its own.
//
// Setup: PayMongo Dashboard > Developers > Webhooks > Add endpoint
//   URL: https://your-site.vercel.app/api/paymongo-webhook
//   Events to send: checkout_session.payment.paid
//
// Required environment variables:
//   PAYMONGO_WEBHOOK_SECRET    — shown when you create the webhook in PayMongo's dashboard
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  — bypasses RLS, so only ever used here, server-side

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Vercel needs the raw request body (not pre-parsed) to verify the signature.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signatureHeader, secret) {
  // PayMongo signs as: t=<timestamp>,te=<test_sig>,li=<live_sig>
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.split('='))
  );
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const provided = parts.li || parts.te;
  return provided && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function addDuration(plan) {
  const now = new Date();
  if (plan === 'annual') now.setFullYear(now.getFullYear() + 1);
  else now.setMonth(now.getMonth() + 1);
  return now.toISOString();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req);
  const signature = req.headers['paymongo-signature'];

  if (!verifySignature(rawBody, signature, process.env.PAYMONGO_WEBHOOK_SECRET)) {
    console.warn('Webhook signature verification failed.');
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  const event = JSON.parse(rawBody);
  const eventType = event?.data?.attributes?.type;

  if (eventType === 'checkout_session.payment.paid') {
    const session = event.data.attributes.data;
    const metadata = session.attributes.metadata || {};
    const { user_id: userId, plan } = metadata;

    if (!userId || !plan) {
      console.error('Webhook missing metadata:', metadata);
      return res.status(400).json({ error: 'Missing metadata on checkout session.' });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await supabase.from('subscriptions').upsert({
      user_id: userId,
      plan,
      status: 'active',
      current_period_end: addDuration(plan),
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error('Supabase upsert failed:', error);
      return res.status(500).json({ error: 'Database update failed.' });
    }
  }

  // Always 200 quickly so PayMongo doesn't keep retrying — even for event types we ignore.
  return res.status(200).json({ received: true });
}
