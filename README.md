# Pinoy Project Managers — Review Center (Live Setup)

This folder converts the demo review center into a real, working product with
actual accounts, a real database, and real PayMongo payments. Follow these
steps in order — none of them can be done for you, since they all require
your own accounts and credentials.

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | The site itself (copy of the working demo, ready to be wired up) |
| `supabase-integration.js` | Replaces the demo's fake login/storage with real Supabase calls |
| `supabase-schema.sql` | Database tables + security rules — run this once in Supabase |
| `api/create-checkout.js` | Serverless function: starts a real PayMongo checkout |
| `api/paymongo-webhook.js` | Serverless function: the ONLY place that marks someone as paid |
| `package.json` | Dependency list for the two serverless functions |

## Step 1 — Create your Supabase project

1. Go to [supabase.com](https://supabase.com), sign up, create a new project.
2. Once it's ready, go to **SQL Editor** → **New query**, paste the entire
   contents of `supabase-schema.sql`, and run it. This creates all your tables.
3. Go to **Project Settings → API**. You'll need three values later:
   - **Project URL**
   - **anon public key** (safe to use in the browser)
   - **service_role key** (secret — server-side only, never in browser code)
4. Go to **Authentication → URL Configuration** and add your future site URL
   (e.g. `https://review.pinoyprojectmanagers.com`) as a redirect URL — this is
   what lets the magic-link login email send people back to your site.

## Step 1b — Enable Google and Facebook login (optional but recommended)

The site has "Continue with Google" / "Continue with Facebook" buttons built
in — they just need to be switched on and connected to real OAuth apps.

**Google:**
1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create
   a project → **APIs & Services → OAuth consent screen** → fill in the basics
   (app name, your email) → **Credentials → Create Credentials → OAuth client ID**
   → type: **Web application**.
2. Under **Authorized redirect URIs**, add the callback URL Supabase shows you
   (Supabase Dashboard → Authentication → Providers → Google — it displays the
   exact URL to paste here, looks like `https://YOUR-PROJECT.supabase.co/auth/v1/callback`).
3. Copy the **Client ID** and **Client Secret** Google gives you.
4. Back in Supabase → Authentication → Providers → Google: toggle it on, paste
   both values in, save.

**Facebook:**
1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps**
   → **Create App** → choose "Consumer" → fill in the basics.
2. Add the **Facebook Login** product → **Settings** → under **Valid OAuth
   Redirect URIs**, paste the same Supabase callback URL as above.
3. Go to **Settings → Basic**, copy the **App ID** and **App Secret**.
4. Back in Supabase → Authentication → Providers → Facebook: toggle it on,
   paste both values in, save.

Until these are switched on, the Google/Facebook buttons will show an error —
the email option always works regardless, so this step can be skipped for now
and added later.

## Step 2 — Create your PayMongo account

1. Sign up at [paymongo.com](https://paymongo.com) (Philippines-based, supports
   cards, GCash, Maya — recommended for a PHP-priced product, as discussed).
2. Go to **Developers → API Keys**. Start in **test mode** — you'll get a
   test secret key to use while setting everything up, so no real charges happen yet.
3. Once you deploy (Step 4) and have a live URL, go to **Developers → Webhooks**,
   add an endpoint pointing to `https://your-site-url/api/paymongo-webhook`,
   and select the `checkout_session.payment.paid` event. PayMongo will show you
   a **webhook secret** — you'll need that too.

## Step 3 — Fill in your credentials

Open `supabase-integration.js` and fill in:
```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
```

The other credentials (PayMongo secret key, Supabase service role key, webhook
secret) are **never** put directly in code — they go into Vercel's environment
variables in Step 4, so they stay private.

## Step 4 — Deploy to Vercel

1. Push this folder to a GitHub repository (Vercel deploys from GitHub).
2. Go to [vercel.com](https://vercel.com), sign up, click **Add New Project**,
   and import that repository.
3. Before deploying, add these **Environment Variables** in Vercel's project settings:

   | Variable | Where to get it |
   |---|---|
   | `SUPABASE_URL` | Supabase → Project Settings → API |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (the secret one) |
   | `PAYMONGO_SECRET_KEY` | PayMongo → Developers → API Keys |
   | `PAYMONGO_WEBHOOK_SECRET` | PayMongo → Developers → Webhooks (after creating the webhook) |
   | `SITE_URL` | Your eventual live URL, e.g. `https://review.pinoyprojectmanagers.com` |

4. Click **Deploy**. You'll get a working `.vercel.app` URL immediately.
5. Go back to PayMongo's webhook settings and update the endpoint URL to your
   real deployed URL if you hadn't set it yet.

## Step 5 — Test before going live

PayMongo's **test mode** lets you use fake card numbers (listed in their docs)
to run through the entire registration → checkout → webhook → unlocked flow
without spending real money. Do this before switching PayMongo to live mode.

## Step 6 — Go live

1. In PayMongo, switch from test keys to **live** keys, update the
   `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` env vars in Vercel to
   the live versions, and redeploy.
2. Connect your custom domain/subdomain in Vercel's project settings (see the
   DNS steps we covered earlier).

## What's simplified in this first pass

- **Login is passwordless**: Google, Facebook, or a magic link (one-time
  emailed link) for email — no passwords to manage or leak. Google/Facebook
  need the one-time OAuth app setup in Step 1b before they'll work.
- **Subscription renewal**: the webhook activates access for exactly one
  billing period (30 days or 1 year) from the moment of payment. Automatic
  recurring re-billing isn't wired up yet — PayMongo's native recurring
  billing support is limited, so renewals would need either a scheduled job
  that re-charges saved payment methods, or simply prompting users to
  re-subscribe when their period ends. Worth discussing once you're ready
  for that piece.
- **Certificates and the exam planner** still work exactly as before — they
  just now read `hasFullAccess()` and attempt history from Supabase instead
  of the local demo storage.
