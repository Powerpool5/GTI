(function () {
  const form = document.getElementById('staffSignInForm');
  const status = document.getElementById('staffSignInStatus');
  const submitBtn = document.getElementById('staffSignInSubmit');
  const throttle = new AttemptThrottle('staff-signin', { maxFreeAttempts: 3, baseDelayMs: 2000, maxDelayMs: 60000 });

  function secondsLeft(ms) { return Math.ceil(ms / 1000); }

  // If a non-admin session got redirected here (see requireAdmin in
  // app.js), show one plain, non-specific message. It never says
  // "you're not staff" — that would confirm the credentials were
  // otherwise correct, which is more than a denial screen should reveal.
  if (new URLSearchParams(window.location.search).get('denied') === '1') {
    setStatus(status, 'That account does not have staff access.', 'error');
  }

  // Already signed in and already staff? Skip straight to the dashboard.
  // Signed in but not staff? Sign out rather than leave a half-authenticated
  // session sitting on this page.
  supabaseClient.auth.getSession().then(async ({ data: { session } }) => {
    if (!session) return;
    const { data: hasAccess } = await supabaseClient.rpc('has_staff_access');
    if (hasAccess === true) {
      window.location.href = 'lecturer-home.html';
    } else {
      await supabaseClient.auth.signOut();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (document.getElementById('staffCompanyWebsite').value) return; // honeypot tripped

    const wait = throttle.msUntilAllowed();
    if (wait > 0) {
      setStatus(status, `Too many attempts. Try again in ${secondsLeft(wait)}s.`, 'error');
      return;
    }

    const email = document.getElementById('staffEmail').value.trim();
    const password = document.getElementById('staffPassword').value;

    submitBtn.disabled = true;
    setStatus(status, '', null);

    const { error: signInError } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (signInError) {
      // DIAGNOSTIC (temporary): the form always shows a generic message
      // below, but this tells us in the console whether the password
      // itself was rejected vs. something else. Safe to remove once the
      // login issue is confirmed fixed.
      console.warn('[staff-login diagnostic] signInWithPassword failed:', signInError.message);
      throttle.recordFailure();
      setStatus(status, friendlyAuthError(signInError), 'error');
      submitBtn.disabled = false;
      return;
    }

    const { data: hasAccess, error: accessCheckError } = await supabaseClient.rpc('has_staff_access');

    if (accessCheckError || hasAccess !== true) {
      // DIAGNOSTIC (temporary): password was correct — sign-in itself
      // succeeded — but the staff-access check below is what's blocking
      // this account. Logging the RPC's actual result/error so the real
      // cause (revoked role vs. a broken RPC) can be told apart from a
      // genuinely wrong password, which looks identical on the form.
      console.warn('[staff-login diagnostic] signed in OK, but has_staff_access check failed:',
        { hasAccess, accessCheckError });
      // Correct password, but not a staff account: sign out immediately
      // and show the same generic message a wrong password would get.
      await supabaseClient.auth.signOut();
      throttle.recordFailure();
      setStatus(status, 'Incorrect email or password.', 'error');
      submitBtn.disabled = false;
      return;
    }

    throttle.reset();
    setStatus(status, 'Signed in. Redirecting…', 'success');
    window.location.href = 'lecturer-home.html';
  });
})();