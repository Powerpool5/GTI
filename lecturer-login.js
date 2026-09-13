(function () {
  const signInForm = document.getElementById('staffSignInForm');
  const resetForm = document.getElementById('staffResetForm');
  const deniedNotice = document.getElementById('deniedNotice');

  function showReset(show) {
    signInForm.classList.toggle('active', !show);
    resetForm.classList.toggle('active', show);
  }

  document.getElementById('staffForgotPasswordBtn').addEventListener('click', () => showReset(true));
  document.getElementById('staffBackToSignIn').addEventListener('click', () => showReset(false));

  // Root (super admin) outranks role — someone can be granted root
  // without being staff/admin (see the "Root" badge in admin.html /
  // lecturer-home.html, which is tracked separately from the role
  // badge). So this form's gate can't be has_staff_access() alone, or
  // a root account without the staff/admin role would get turned away
  // from its own dashboard. Check both and let either one through.
  async function hasStaffOrRootAccess() {
    const [{ data: hasAccess }, { data: isSuperAdmin }] = await Promise.all([
      supabaseClient.rpc('has_staff_access'),
      supabaseClient.rpc('is_super_admin'),
    ]);
    return hasAccess === true || isSuperAdmin === true;
  }

  // requireAdmin() (app.js) sends people here with ?denied=1 when they
  // had a session but no staff access, rather than because they chose
  // "Staff login" themselves — say why, once.
  const params = new URLSearchParams(window.location.search);
  if (params.get('denied') === '1') {
    deniedNotice.hidden = false;
    deniedNotice.classList.add('visible');
  }

  const signInThrottle = new AttemptThrottle('staff-signin', { maxFreeAttempts: 3, baseDelayMs: 2000, maxDelayMs: 60000 });
  function secondsLeft(ms) { return Math.ceil(ms / 1000); }

  // Already signed in with staff access? Skip straight to the dashboard.
  // (A signed-in student is left on this form rather than bounced away —
  // they may be about to sign in with a different, staff, account.)
  supabaseClient.auth.getSession().then(async ({ data: { session } }) => {
    if (!session) return;
    if (await hasStaffOrRootAccess()) window.location.href = 'lecturer-home.html';
  });

  signInForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('staffSignInStatus');
    const submitBtn = document.getElementById('staffSignInSubmit');

    if (document.getElementById('staffCompanyWebsite').value) return; // honeypot

    const wait = signInThrottle.msUntilAllowed();
    if (wait > 0) {
      setStatus(status, `Too many attempts. Try again in ${secondsLeft(wait)}s.`, 'error');
      return;
    }

    const email = document.getElementById('staffEmail').value.trim();
    const password = document.getElementById('staffPassword').value;

    submitBtn.disabled = true;
    setStatus(status, '', null);
    deniedNotice.hidden = true;
    deniedNotice.classList.remove('visible');

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
      signInThrottle.recordFailure();
      setStatus(status, friendlyAuthError(error), 'error');
      submitBtn.disabled = false;
      return;
    }

    // Credentials were fine, but this form is staff-only — check access
    // before letting them further in, and sign back out if they don't
    // have it (rather than leaving a stray non-staff session live here).
    // Root always counts as access here too, even on an account that
    // isn't staff/admin by role (see hasStaffOrRootAccess above).
    if (!(await hasStaffOrRootAccess())) {
      await supabaseClient.auth.signOut();
      setStatus(status, "That account doesn't have staff access. Sign in with a staff or admin account, or use the student sign-in.", 'error');
      submitBtn.disabled = false;
      return;
    }

    // Lockdown mode (root-only, see admin.html's System tab) can still
    // turn away non-admin staff even though credentials and staff
    // access both checked out.
    const lockdownMessage = await checkLockdownBlock();
    if (lockdownMessage) {
      setStatus(status, lockdownMessage, 'error');
      submitBtn.disabled = false;
      return;
    }

    signInThrottle.reset();
    setStatus(status, 'Signed in. Redirecting…', 'success');
    window.location.href = 'lecturer-home.html';
  });

  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('staffResetStatus');
    const submitBtn = document.getElementById('staffResetSubmit');
    const email = document.getElementById('staffResetEmail').value.trim();

    submitBtn.disabled = true;
    await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname.replace('lecturer-login.html', 'reset-password.html'),
    });
    submitBtn.disabled = false;

    // Same message whether or not the email exists / has staff access —
    // can't be used to probe which emails are registered or staff.
    setStatus(status, "If that email is registered, we've sent a reset link.", 'success');
  });
})();