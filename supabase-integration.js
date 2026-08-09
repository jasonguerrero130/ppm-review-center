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

const SUPABASE_URL = 'https://xvlffamwbkkznbewpqsu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kiRALknw9nvr3-X5KxkHSw_PxnRJkME';

// PayMongo's PUBLIC key — safe to expose in browser code (unlike the secret
// key). Used only to tokenize card details and attach them to a payment
// intent; it cannot be used to charge anything or read account data.
// PayMongo Dashboard > Developers > API Keys > Public Key (starts with pk_test_ or pk_live_).
const PAYMONGO_PUBLIC_KEY = 'YOUR-PAYMONGO-PUBLIC-KEY'; // TODO: fill in

// Captured BEFORE creating the client, since Supabase clears this hash once it
// processes it. Distinguishes "just completed magic link / OAuth login" from
// "returning visitor with an already-saved session" — only the former should
// jump straight into the payment step below.
const cameFromFreshLogin = window.location.hash.includes('access_token') || window.location.hash.includes('type=magiclink');

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Captured once, at load, before submitRegistration() ever overwrites this
// element's content with the "check your email" message — this is what lets
// resetRegistrationForm() actually restore the real form later (a plain
// showGate() call can't, since the title/subtitle elements it depends on
// live inside this same block and would already be gone by then).
const ORIGINAL_REGISTER_FORM_HTML = document.getElementById('gate-step-register').innerHTML;

/* ============ ACCOUNT / SESSION ============ */

async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session; // null if not logged in
}

// Called at app init, replacing the old localStorage-based loadAccount().
async function loadAccount() {
  const session = await getSession();
  if (!session) {
    return { answeredCount: 0, readArticleIds: [], registered: null, subscription: null, subscriptionExpired: false, userId: null };
  }

  const [{ data: profile }, { data: sub }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', session.user.id).single(),
    sb.from('subscriptions').select('*').eq('user_id', session.user.id).maybeSingle(),
  ]);

  // A subscription can still say status:'active' in the database even after
  // its paid period has actually ended — nothing flips that automatically on
  // its own (this matters especially for one-time payments with no
  // auto-renewal yet). Check the date ourselves on every load, and clean up
  // the database record to match so it doesn't just look right in the app —
  // it's actually true in Supabase too.
  const isExpired = !!(sub?.current_period_end && new Date(sub.current_period_end) < new Date());
  if (isExpired && sub.status === 'active') {
    sb.from('subscriptions')
      .update({ status: 'canceled', updated_at: new Date().toISOString() })
      .eq('user_id', session.user.id)
      .then(() => {}); // fire-and-forget — don't block loading the page on this
  }

  return {
    userId: session.user.id,
    answeredCount: profile?.answered_count ?? 0,
    readArticleIds: profile?.read_article_ids ?? [],
    registered: profile ? { firstName: profile.first_name, email: profile.email } : null,
    subscription: sub && sub.status === 'active' && !isExpired
      ? { plan: sub.plan, active: true, currentPeriodEnd: sub.current_period_end }
      : null,
    subscriptionExpired: isExpired, // lets the UI say "expired, renew" instead of just "Free"
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
      <p style="color:var(--graphite-soft); font-size:13px; margin-top:16px;">Typo in your email, or didn't get it? <a href="#" onclick="resetRegistrationForm(); return false;" style="color:var(--navy); font-weight:600;">Try a different email →</a></p>
    </div>`;
}

// Restores the registration form so a mistyped email can be corrected —
// signInWithOtp() has no way to know an email was wrong (Supabase never
// reveals whether an address is valid, for security), so this is the only
// real recovery path if the magic link never arrives.
function resetRegistrationForm(){
  document.getElementById('gate-step-register').innerHTML = ORIGINAL_REGISTER_FORM_HTML;
  showGate(state.gateContext);
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
function showCardError(msg) {
  const el = document.getElementById('card-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ============================================================
// ACTIVE: one-time checkout (works right now — no PayMongo approval needed
// beyond your normal test-mode account). This is what's currently wired to
// the "Confirm & unlock" button.
// ============================================================
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

// ============================================================
// READY BUT NOT ACTIVE YET: real recurring billing via PayMongo's
// Subscriptions API. Requires PayMongo to approve Subscriptions on your
// account first (see README Step 2b), plus PAYMONGO_PUBLIC_KEY filled in
// above, plus the card-entry form back in index.html's gate-step-plan
// section, plus api/create-subscription.js and api/cancel-subscription.js
// actually deployed. Once all of that's true, rename this function to
// confirmSubscription() and rename the one above to something else — that's
// the only change needed to switch over.
// ============================================================
async function confirmSubscriptionRecurring() {
  if (!state.pendingPlan) return;
  const session = await getSession();
  if (!session) {
    document.getElementById('plan-summary-tag').textContent = 'PLEASE REGISTER FIRST';
    return;
  }

  document.getElementById('card-error').style.display = 'none';
  const name = document.getElementById('card-name').value.trim();
  const rawNumber = document.getElementById('card-number').value.replace(/\s+/g, '');
  const expiry = document.getElementById('card-expiry').value.trim();
  const cvc = document.getElementById('card-cvc').value.trim();
  const [expMonth, expYear] = expiry.split('/').map(s => s && s.trim());

  if (!name || !/^\d{12,19}$/.test(rawNumber) || !expMonth || !expYear || !/^\d{3,4}$/.test(cvc)) {
    showCardError('Please fill in all card fields correctly.');
    return;
  }

  const btn = document.getElementById('plan-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  try {
    // 1. Ask our server to create the subscription + a Payment Intent for the first charge.
    const subRes = await fetch('/api/create-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: state.pendingPlan, accessToken: session.access_token }),
    });
    const subData = await subRes.json();
    if (!subRes.ok) throw new Error(subData.error || 'Could not start subscription.');

    // 2. Tokenize the card directly with PayMongo using the PUBLIC key —
    //    the raw card number never touches our own server.
    const pmRes = await fetch('https://api.paymongo.com/v1/payment_methods', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa(PAYMONGO_PUBLIC_KEY + ':'),
      },
      body: JSON.stringify({
        data: {
          attributes: {
            type: 'card',
            details: {
              card_number: rawNumber,
              exp_month: parseInt(expMonth, 10),
              exp_year: parseInt(expYear.length === 2 ? '20' + expYear : expYear, 10),
              cvc,
            },
            billing: { name },
          },
        },
      }),
    });
    const pmData = await pmRes.json();
    if (!pmRes.ok) throw new Error(pmData.errors?.[0]?.detail || 'Card details were rejected.');
    const paymentMethodId = pmData.data.id;

    // 3. Attach the tokenized card to the Payment Intent — this actually
    //    triggers the charge (and possibly a 3D Secure redirect).
    const attachRes = await fetch(
      `https://api.paymongo.com/v1/payment_intents/${subData.paymentIntentId}/attach`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + btoa(PAYMONGO_PUBLIC_KEY + ':'),
        },
        body: JSON.stringify({
          data: {
            attributes: {
              payment_method: paymentMethodId,
              client_key: subData.clientKey,
              return_url: window.location.origin + '/?subscription=return',
            },
          },
        }),
      }
    );
    const attachData = await attachRes.json();
    if (!attachRes.ok) throw new Error(attachData.errors?.[0]?.detail || 'Payment could not be processed.');

    const status = attachData.data.attributes.status;
    const nextActionUrl = attachData.data.attributes.next_action?.redirect?.url;

    if (status === 'awaiting_next_action' && nextActionUrl) {
      // Card requires 3D Secure authentication — full-page redirect,
      // PayMongo sends the browser back to our return_url afterward.
      window.location.href = nextActionUrl;
      return;
    }

    // No extra authentication needed — poll briefly for the webhook to confirm.
    await pollForActiveSubscription();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Confirm & subscribe →';
    showCardError(err.message || 'Something went wrong. Please try again.');
  }
}

async function pollForActiveSubscription() {
  for (let attempt = 0; attempt < 6; attempt++) {
    state.account = await loadAccount();
    if (hasFullAccess()) {
      showUnlockedDoneScreen(state.account.subscription.plan);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  alert("Payment received! It's finishing activation — refresh in a few seconds if your access doesn't show as unlocked yet.");
}

async function cancelMySubscription() {
  if (!confirm('Cancel your subscription? You\'ll keep access until the current billing period ends, then it won\'t renew.')) return;
  const session = await getSession();
  if (!session) return;

  const btn = document.getElementById('cancel-sub-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }

  try {
    const res = await fetch('/api/cancel-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: session.access_token }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Cancellation failed.');
    state.account = await loadAccount();
    updateNavStatus();
    renderDashboard();
  } catch (err) {
    alert(err.message || 'Something went wrong cancelling — please try again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel subscription'; }
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
    questionIds: a.question_ids || [],
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
    question_ids: attempt.questionIds || [],
  });
}

// Returns the set of question IDs seen across the user's last N attempts of a
// given kind, so a new quiz can avoid repeating them. For domain practice,
// pass domainKey to look at that domain's last N attempts specifically; for
// mock exams, pass isMock:true and no domainKey. Guests (not logged in) get
// an empty set back — repeat-avoidance only works for registered accounts,
// since it depends on stored history.
async function getRecentlySeenQuestionIds({ isMock, domainKey, limit = 3 }) {
  if (!state.account.userId) return new Set();
  let query = sb.from('attempts').select('question_ids')
    .eq('user_id', state.account.userId)
    .eq('is_mock', isMock)
    .order('date', { ascending: false })
    .limit(limit);
  if (domainKey) query = query.eq('domain_key', domainKey);

  const { data, error } = await query;
  if (error || !data) return new Set();
  const ids = new Set();
  data.forEach(row => (row.question_ids || []).forEach(id => ids.add(id)));
  return ids;
}

/* ============ INIT ============ */
// Runs once the browser lands back here after a magic-link login, after a
// one-time PayMongo checkout redirects back with ?checkout=success, or
// after a 3D Secure card authentication redirects back with ?subscription=return.

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const isCheckoutReturn = params.get('checkout') === 'success';
  const isSubscriptionReturn = params.get('subscription') === 'return';
  if (!isCheckoutReturn && !isSubscriptionReturn) return;

  // Clean the URL so refreshing doesn't re-trigger this.
  window.history.replaceState({}, '', window.location.pathname);
  await pollForActiveSubscription();
}

(async function initSupabaseApp() {
  await handleAuthRedirect();
  await initApp();
  // If they just completed registration (magic link or Google/Facebook) and
  // aren't subscribed yet, take them straight to picking a plan instead of
  // silently dropping them on the Home page with no prompt.
  if (cameFromFreshLogin && state.account.registered && !hasFullAccess()) {
    showGate('practice');
  }
  await handleCheckoutReturn();
})();
