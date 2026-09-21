/* Lockdown page (lockdown.html).
   Shown when lockdown mode (system_status.lockdown_enabled, flipped by root in
   admin.html's System tab) turns someone away — at sign-in (login.js /
   lecturer-login.js) or when a signed-in person loads any page (requireSession
   in app.js). Those hand over the admin's message + style in sessionStorage
   ("gti-lockdown") so this page can paint instantly; it then reads the live row
   and keeps checking, so the message stays accurate and the page notices the
   moment the lockdown is lifted.

   Deliberately does NOT load app.js: that would start the status banner and a
   realtime channel on top of this page, and app.js's session guards would
   fight with a page whose whole point is that the visitor is signed out.
   Like the rest of the lockdown feature this is a UX layer only — the real
   gate is server-side (see SECURITY.md). */
(function () {
  const SUPABASE_URL = 'https://iqcwrberwzumxxjktgux.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_bD6Za9HNb0bu72OfMylG1g_J_0yWV0K'; // public by design (RLS is the protection)
  const DEFAULT_MESSAGE = 'The portal is temporarily locked down by an administrator. Please try again shortly.';
  const STYLES = ['info', 'warning', 'danger'];
  const POLL_MS = 5000;
  const REDIRECT_SECONDS = 3;

  const $ = (id) => document.getElementById(id);
  const card = $('lockdownCard');

  let state = 'active';        // 'active' | 'checking' | 'lifted' | 'none'
  let redirectTimer = null;
  let pollTimer = null;
  let sawActive = false;       // did we ever see (or get told about) a lockdown on this page?

  function setStyle(style) {
    document.body.dataset.style = STYLES.includes(style) ? style : 'warning';
  }

  // Everything is written with textContent — the admin's message is plain text, never markup.
  function showActive(message, style) {
    state = 'active';
    sawActive = true;
    card.dataset.state = 'active';
    setStyle(style);
    $('lockdownChip').textContent = 'Lockdown active';
    $('lockdownTitle').textContent = 'The portal is locked';
    $('lockdownMessage').textContent = message || DEFAULT_MESSAGE;
    $('lockdownMessage').hidden = false;
    $('lockdownHint').textContent = "This page checks automatically. As soon as the lockdown is lifted, you'll be taken back to sign in.";
    $('lockdownPrimary').textContent = 'Administrator sign in';
    $('lockdownPrimary').setAttribute('href', 'lecturer-login.html');
    $('lockdownCheck').hidden = false;
    $('lockdownStudentLink').parentElement.hidden = false;
    document.title = 'Portal locked down - GTI Portal';
  }

  function showResolved(kind) {
    state = kind;
    card.dataset.state = kind;
    $('lockdownChip').textContent = kind === 'lifted' ? 'Lockdown lifted' : 'No lockdown';
    $('lockdownTitle').textContent = kind === 'lifted' ? "You're good to go" : 'No lockdown right now';
    $('lockdownMessage').hidden = true;
    $('lockdownPrimary').textContent = 'Go to sign in';
    $('lockdownPrimary').setAttribute('href', 'index.html');
    $('lockdownCheck').hidden = true;
    $('lockdownStudentLink').parentElement.hidden = true;
    document.title = 'Portal open - GTI Portal';
    stopPolling();
    let left = REDIRECT_SECONDS;
    const tick = () => {
      $('lockdownHint').textContent = (kind === 'lifted' ? 'The lockdown has been lifted. ' : 'Nothing is locked at the moment. ')
        + 'Taking you to sign in in ' + left + '…';
      if (left <= 0) { window.location.href = 'index.html'; return; }
      left -= 1;
      redirectTimer = window.setTimeout(tick, 1000);
    };
    tick();
  }

  function stopPolling() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  function stamp(text) { $('lockdownMeta').textContent = text; }
  function clock() { return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

  let client = null;
  try {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  } catch (e) { client = null; }

  async function check() {
    if (state === 'lifted' || state === 'none') return;
    if (!client) {
      if (state === 'checking') showActive(DEFAULT_MESSAGE, 'warning');
      stamp('Live status is unavailable — showing the last known message.');
      return;
    }
    try {
      const { data, error } = await client
        .from('system_status')
        .select('lockdown_enabled, lockdown_message, lockdown_style')
        .eq('id', 1)
        .maybeSingle();
      if (error) throw error;
      if (data && data.lockdown_enabled === true) {
        showActive(data.lockdown_message, data.lockdown_style);
        stamp('Last checked ' + clock());
      } else {
        showResolved(sawActive ? 'lifted' : 'none');
      }
    } catch (e) {
      // e.g. the status row isn't readable while signed out — keep what we were told
      // (or, if we were told nothing, assume the worst: someone sent this person here).
      if (state === 'checking') showActive(DEFAULT_MESSAGE, 'warning');
      stamp("Couldn't check the live status just now — showing the last known message.");
    }
  }

  // 1) Paint immediately from what the page that sent us here knew.
  let handed = null;
  try { handed = JSON.parse(window.sessionStorage.getItem('gti-lockdown') || 'null'); } catch (e) { handed = null; }
  if (handed && typeof handed === 'object') showActive(typeof handed.message === 'string' ? handed.message : '', handed.style);
  else {
    // Opened directly (no hand-over): don't flash a "locked" message at someone until it's confirmed.
    setStyle('warning');
    state = 'checking';
    card.dataset.state = 'checking';
    $('lockdownChip').textContent = 'Checking…';
    $('lockdownTitle').textContent = 'Checking the portal status';
    $('lockdownMessage').hidden = true;
    $('lockdownHint').textContent = '';
  }

  // 2) Then confirm against the live row and keep watching.
  $('lockdownCheck').addEventListener('click', async () => {
    const btn = $('lockdownCheck');
    btn.disabled = true;
    stamp('Checking…');
    await check();
    btn.disabled = false;
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check();
  pollTimer = window.setInterval(check, POLL_MS);
})();