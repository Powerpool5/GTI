(function () {
  // Built from COURSES (courses-data.js) instead of the old hardcoded
  // <option> markup, which had drifted out of sync with the codes
  // admin.html actually uses (e.g. different codes for the same
  // Electrical courses) — see courses-data.js's own comment. "Staff"
  // is left out; a student signing up shouldn't be offered it.
  populateCourseSelect(
    document.getElementById('signUpCourse'),
    COURSES.filter((g) => g.label !== 'Staff'),
    '-- Select a Course --',
    true
  );
  enhanceCourseSelect(document.getElementById('signUpCourse'));

  // Auto-insert the dash after the first 2 digits as the person types,
  // instead of making them type it themselves — e.g. "251729" becomes
  // "25-1729" on the fly. Non-digits are stripped as they're typed
  // (rather than merely rejected) so pasting "25-1729" or "25 1729"
  // still lands in the right format.
  const studentIdInput = document.getElementById('signUpStudentId');
  studentIdInput.addEventListener('input', () => {
    const digits = studentIdInput.value.replace(/\D/g, '').slice(0, 6); // 2 + 4
    studentIdInput.value = digits.length > 2 ? digits.slice(0, 2) + '-' + digits.slice(2) : digits;
  });

  const tabSignIn = document.getElementById('tabSignIn');
  const tabSignUp = document.getElementById('tabSignUp');
  const signInForm = document.getElementById('signInForm');
  const signUpForm = document.getElementById('signUpForm');
  const resetForm = document.getElementById('resetForm');
  const heading = document.getElementById('formHeading');
  const subtitle = document.getElementById('formSubtitle');

  function showForm(which) {
    [signInForm, signUpForm, resetForm].forEach(f => f.classList.remove('active'));
    [tabSignIn, tabSignUp].forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });

    if (which === 'signin') {
      signInForm.classList.add('active');
      tabSignIn.classList.add('active');
      tabSignIn.setAttribute('aria-selected', 'true');
      heading.textContent = 'Welcome back';
      subtitle.textContent = 'Sign in with your student email.';
    } else if (which === 'signup') {
      signUpForm.classList.add('active');
      tabSignUp.classList.add('active');
      tabSignUp.setAttribute('aria-selected', 'true');
      heading.textContent = 'Create your account';
      subtitle.textContent = 'Register with the email your department has on file.';
    } else {
      resetForm.classList.add('active');
      heading.textContent = 'Reset your password';
      subtitle.textContent = "We'll email you a link to choose a new one.";
    }
  }

  tabSignIn.addEventListener('click', () => showForm('signin'));
  tabSignUp.addEventListener('click', () => showForm('signup'));
  document.getElementById('forgotPasswordBtn').addEventListener('click', () => showForm('reset'));
  document.getElementById('backToSignIn').addEventListener('click', () => showForm('signin'));

  // Lockdown mode blocks students outright ("only admins can use the
  // portal"), so this checks *before* anyone can type a password or
  // submit, not only after a login attempt — a locked-out student is
  // redirected on page load. Sign-up is disabled the same way (a new
  // account is still portal access); the password-reset form is left
  // alone, since resetting a password doesn't get anyone into the portal.
  // (Staff aren't gated this way: lecturer-login.js only finds out after
  // verifying who's signing in, since an admin's account must still get
  // through.)
  const signInSubmit = document.getElementById('signInSubmit');
  const signUpSubmit = document.getElementById('signUpSubmit');
  signInSubmit.disabled = true;
  signUpSubmit.disabled = true;

  (async () => {
    let status;
    try { status = await getSystemStatus(); } catch { status = null; }
    if (status && status.lockdown_enabled === true) {
      try {
        sessionStorage.setItem('gti-lockdown', JSON.stringify({
          message: status.lockdown_message || DEFAULT_LOCKDOWN_MESSAGE,
          style: status.lockdown_style || 'warning',
        }));
      } catch {}
      window.location.href = 'lockdown.html';
      return;
    }

    signInSubmit.disabled = false;
    signUpSubmit.disabled = false;

    // If requireSession()/requireAdmin() just bounced someone here because
    // lockdown mode kicked in while they were signed in, say why. (Checked
    // only once lockdown itself is confirmed off, so this message can't
    // flash up right before the redirect above fires instead.)
    try {
      const lockoutMsg = sessionStorage.getItem('gti-lockout-message');
      if (lockoutMsg) {
        sessionStorage.removeItem('gti-lockout-message');
        setStatus(document.getElementById('signInStatus'), lockoutMsg, 'error');
      }
    } catch {}

    // Already signed in? Skip straight to the portal.
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) window.location.href = 'home.html';
  })();

  const signInThrottle = new AttemptThrottle('signin', { maxFreeAttempts: 3, baseDelayMs: 2000, maxDelayMs: 60000 });
  function secondsLeft(ms) { return Math.ceil(ms / 1000); }

  // SIGN IN
  signInForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('signInStatus');
    const submitBtn = signInSubmit;

    if (document.getElementById('companyWebsite').value) return; // honeypot

    const wait = signInThrottle.msUntilAllowed();
    if (wait > 0) {
      setStatus(status, `Too many attempts. Try again in ${secondsLeft(wait)}s.`, 'error');
      return;
    }

    const email = document.getElementById('signInEmail').value.trim();
    const password = document.getElementById('signInPassword').value;

    submitBtn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
      signInThrottle.recordFailure();
      setStatus(status, friendlyAuthError(error), 'error');
      submitBtn.disabled = false;
      return;
    }

    // Credentials were correct, but lockdown mode (root-only, see the
    // admin panel's System tab) may still turn away anyone who isn't an
    // admin. checkLockdownBlock() signs them back out if so.
    const lockdownMessage = await checkLockdownBlock();
    if (lockdownMessage) {
      // Lockdown has its own page (message + style set by the admin, and it
      // notices when the lockdown is lifted).
      window.location.href = 'lockdown.html';
      return;
    }

    signInThrottle.reset();
    setStatus(status, 'Signed in. Redirecting…', 'success');
    window.location.href = 'home.html';
  });

  // SIGN UP
  signUpForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('signUpStatus');
    const submitBtn = signUpSubmit;

    if (document.getElementById('companyWebsite2').value) return; // honeypot

    const courseSelect = document.getElementById('signUpCourse');
    const firstName = document.getElementById('signUpFirstName').value.trim();
    const lastName = document.getElementById('signUpLastName').value.trim();
    const studentId = document.getElementById('signUpStudentId').value.trim();
    const email = document.getElementById('signUpEmail').value.trim();
    const password = document.getElementById('signUpPassword').value;

    if (!courseSelect.value) {
      setStatus(status, 'Please select a course.', 'error');
      return;
    }
    if (!firstName || !lastName) {
      setStatus(status, 'Please enter your first and last name.', 'error');
      return;
    }
    if (!/^[0-9]{2}-[0-9]{4}$/.test(studentId)) {
      setStatus(status, 'Student ID must be 2 digits, then 4 digits (e.g., 25-1729).', 'error');
      return;
    }
    if (password.length < 8) {
      setStatus(status, 'Password must be at least 8 characters.', 'error');
      return;
    }

    submitBtn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: `${firstName} ${lastName}`,
          student_id: studentId,
          course_code: courseSelect.value,
          course_name: courseSelect.options[courseSelect.selectedIndex].textContent.trim(),
        },
      },
    });

    submitBtn.disabled = false;

    if (error) {
      setStatus(status, friendlyAuthError(error), 'error');
      return;
    }

    setStatus(status, 'Account created. Check your email to confirm before signing in.', 'success');
    signUpForm.reset();
  });

  // RESET PASSWORD
  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('resetStatus');
    const submitBtn = document.getElementById('resetSubmit');
    const email = document.getElementById('resetEmail').value.trim();

    submitBtn.disabled = true;
    await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname.replace('index.html', 'reset-password.html'),
    });
    submitBtn.disabled = false;

    // Same message whether or not the email exists — can't be used to
    // check which emails are registered.
    setStatus(status, "If that email is registered, we've sent a reset link.", 'success');
  });
})();