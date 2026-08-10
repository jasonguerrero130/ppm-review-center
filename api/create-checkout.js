// Vercel serverless function: POST /api/create-checkout
// Creates a PayMongo Checkout Session for the logged-in user's chosen plan,
// and returns the checkout URL for the browser to redirect to.
//
// Required environment variables (set in Vercel project settings, never in client code):
//   PAYMONGO_SECRET_KEY   — from PayMongo Dashboard > Developers > API Keys (secret key)
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (Project Settings > API) — NEVER the anon key here
//   SITE_URL              — e.g. https://review.pinoyprojectmanagers.com (used for redirect URLs)

import { createClient } from '@supabase/supabase-js';

const PLAN_PRICES_CENTAVOS = {
  monthly: 19900,   // ₱199.00 — PayMongo amounts are in centavos
  annual: 199900,   // ₱1,999.00
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { plan, accessToken } = req.body || {};
  if (!plan || !PLAN_PRICES_CENTAVOS[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Expected "monthly" or "annual".' });
  }
  if (!accessToken) {
    return res.status(401).json({ error: 'Missing accessToken — user must be logged in.' });
  }

  // Verify the Supabase session token server-side and get the real user id —
  // never trust a user id sent directly from the client.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
  const userId = userData.user.id;
  const userEmail = userData.user.email;

  try {
    const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64'),
      },
      body: JSON.stringify({
        data: {
          attributes: {
            billing: { email: userEmail },
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            description: plan === 'monthly' ? 'PPM Review Center — Monthly' : 'PPM Review Center — Annual',
            line_items: [
              {
                currency: 'PHP',
                amount: PLAN_PRICES_CENTAVOS[plan],
                name: plan === 'monthly' ? 'Monthly subscription' : 'Annual subscription',
                quantity: 1,
              },
            ],
            payment_method_types: ['card', 'gcash', 'paymaya', 'shopee_pay'],
            success_url: `${process.env.SITE_URL}/?checkout=success`,
            cancel_url: `${process.env.SITE_URL}/?checkout=cancelled`,
            // Carried through to the webhook so we know which user + plan to activate.
            metadata: { user_id: userId, plan },
          },
        },
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error('PayMongo error:', result);
      return res.status(502).json({ error: 'Payment provider error.' });
    }

    return res.status(200).json({ checkoutUrl: result.data.attributes.checkout_url });
  } catch (err) {
    console.error('create-checkout error:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
