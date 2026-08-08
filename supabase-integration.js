/* ============================================================
   Pinoy Project Managers — Supabase + PayMongo integration layer
   ============================================================
   This file REPLACES the following functions currently defined
   inline in index.html's <script> block:
     - loadAttempts / saveAttempt
     - loadAccount / saveAccount
     - hasFullAccess
     - submitRegistration
     - confirmSubscription  (now redirects to real PayMongo checkout)

   HOW TO WIRE THIS IN:
   1. In index.html's <head>, add before your closing </head>:
        <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   2. Just before your existing <script> block's closing </script> tag,
      add: <script src="supabase-integration.js"></script>
      (must load AFTER the main script, since it overwrites some of its functions)
   3. Delete the old loadAttempts / saveAttempt / loadAccount / saveAccount /
      hasFullAccess / submitRegistration / confirmSubscription function
      definitions from the main script — this file defines all of them now.
   4. Fill in SUPABASE_URL and SUPABASE_ANON_KEY below (Project Settings > API
      in your Supabase dashboard — the ANON key, never the service role key).
   ============================================================ */

const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';   // TODO: fill in
const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';                 // TODO: fill in

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ============ ACCOUNT / SESSION ============ */

async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session; // null if not logged in
}

// Called at app init, replacing the old localStorage-based loadAccount().
async function loadAccount() {
  const session = await getSession();
  if (!session) {
    return { answeredCount: 0, readArticleIds: [], registered: null, subscription: null, userId: null };
  }

  const [{ data: profile }, { data: sub }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', session.user.id).single(),
    sb.from('subscriptions').select('*').eq('user_id', session.user.id).maybeSingle(),
  ]);

  return {
    userId: session.user.id,
    answeredCount: profile?.answered_count ?? 0,
    readArticleIds: profile?.read_article_ids ?? [],
    registered: profile ? { firstName: profile.first_name, email: profile.email } : null,
    subscription: sub && sub.status === 'active'
      ? { plan: sub.plan, active: true, currentPeriodEnd: sub.current_period_end }
      : null,
  };
}

// Replaces the old window.storage-based saveAccount(). Persists progress counters only —
// subscription status is never written by the client (see paymongo-webhook.js).
async function saveAccount() {
  if (!state.account.userId) return; // not logged in yet — nothing to save server-side
  await sb.from('profiles').update({
    answered_count: state.account.answeredCount,
    read_article_ids: state.account.readArticleIds,
  }).eq('id', state.account.userId);
}

function hasFullAccess() {
  return !!(state.account.subscription && state.account.subscription.active);
}

/* ============ REGISTRATION (magic link, no password) ============ */

// Replaces the old submitRegistration(). Sends a one-time login link instead of
// creating an account with a password — simplest secure flow with minimal UI change.
async function submitRegistration() {
  const firstName = document.getElementById('gate-firstname').value.trim();
  const email = document.getElementById('gate-email').value.trim();
  const errEl = document.getElementById('gate-register-error');
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (!firstName || !emailOk) {
    errEl.textContent = !firstName ? 'Please enter your first name.' : 'Please enter a valid email address.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';

  // Stash the first name so we can save it to `profiles` once they click the magic link
  // and land back on the site with a real session.
  localStorage.setItem('ppm_pending_first_name', firstName);

  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });

  if (error) {
    errEl.textContent = 'Something went wrong sending your login link. Please try again.';
    errEl.style.display = 'block';
    return;
  }

  document.getElementById('gate-step-register').innerHTML = `
    <div class="section-head"><h2>Check your email</h2></div>
    <div class="qcard">
      <p style="color:var(--graphite-soft);">We sent a login link to <b>${email}</b>. Click it to finish registering — this tab will pick up automatically once you're logged in.</p>
    </div>`;
}

// Google/Facebook: redirects to the provider's login page, then back here.
// Requires enabling these providers in Supabase (Authentication > Providers) —
// see the "Social login setup" section in README.md.
async function signInWithGoogle() {
  await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
}
async function signInWithFacebook() {
  await sb.auth.signInWithOAuth({
    provider: 'facebook',
    options: { redirectTo: window.location.origin },
  });
}

// Called once, at page load, to finish registration after the user clicks the
// magic link OR completes Google/Facebook login.
async function handleAuthRedirect() {
  const session = await getSession();
  if (!session) return;

  const { data: existingProfile } = await sb.from('profiles').select('id').eq('id', session.user.id).maybeSingle();
  if (!existingProfile) {
    // Email magic-link users: we stashed their typed first name before redirecting.
    // Google/Facebook users never typed one — pull it from what the provider gave us instead.
    const stashedName = localStorage.getItem('ppm_pending_first_name');
    const providerName =
      session.user.user_metadata?.given_name ||           // Google
      session.user.user_metadata?.full_name?.split(' ')[0] || // Facebook (and Google fallback)
      session.user.user_metadata?.name?.split(' ')[0];
    const firstName = stashedName || providerName || 'there';

    await sb.from('profiles').insert({
      id: session.user.id,
      first_name: firstName,
      email: session.user.email,
    });
    localStorage.removeItem('ppm_pending_first_name');
  }
}

/* ============ SUBSCRIPTION CHECKOUT ============ */

// Replaces the old confirmSubscription() fake-unlock. Redirects to a real PayMongo
// checkout page instead of immediately marking the account as subscribed.
async function confirmSubscription() {
  if (!state.pendingPlan) return;
  const session = await getSession();
  if (!session) {
    document.getElementById('plan-summary-tag').textContent = 'PLEASE REGISTER FIRST';
    return;
  }

  const btn = document.getElementById('plan-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Redirecting to checkout…';

  try {
    const res = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: state.pendingPlan, accessToken: session.access_token }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');
    window.location.href = data.checkoutUrl; // hands off to PayMongo's hosted checkout page
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Confirm & unlock →';
    document.getElementById('plan-summary-tag').textContent = 'SOMETHING WENT WRONG — TRY AGAIN';
  }
}

/* ============ ATTEMPTS (quiz / mock exam history) ============ */

async function loadAttempts() {
  if (!state.account.userId) return [];
  const { data } = await sb.from('attempts').select('*').eq('user_id', state.account.userId).order('date');
  return (data || []).map(a => ({
    date: a.date, isMock: a.is_mock, domainKey: a.domain_key, total: a.total,
    correct: a.correct, percent: a.percent, passed: a.passed,
    timeUsedSec: a.time_used_sec, perDomain: a.per_domain, certId: a.cert_id,
  }));
}

async function saveAttempt(attempt) {
  if (!state.account.userId) return;
  await sb.from('attempts').insert({
    user_id: state.account.userId,
    date: attempt.date, is_mock: attempt.isMock, domain_key: attempt.domainKey,
    total: attempt.total, correct: attempt.correct, percent: attempt.percent,
    passed: attempt.passed, time_used_sec: attempt.timeUsedSec,
    per_domain: attempt.perDomain, cert_id: attempt.certId || null,
  });
}

/* ============ INIT ============ */
// Runs once the browser lands back here after a magic-link login OR after
// PayMongo checkout redirects back with ?checkout=success in the URL.

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') !== 'success') return;

  // Clean the URL so refreshing doesn't re-trigger this.
  window.history.replaceState({}, '', window.location.pathname);

  // The webhook usually fires within a second or two of PayMongo redirecting
  // the browser back — poll briefly rather than assuming it's instant.
  for (let attempt = 0; attempt < 6; attempt++) {
    state.account = await loadAccount();
    if (hasFullAccess()) {
      showUnlockedDoneScreen(state.account.subscription.plan);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Payment likely succeeded but the webhook hasn't landed yet — reassure
  // rather than show a false failure.
  alert("Payment received! It's finishing activation — refresh in a few seconds if your access doesn't show as unlocked yet.");
}

(async function initSupabaseApp() {
  await handleAuthRedirect();
  await initApp();
  await handleCheckoutReturn();
})();
