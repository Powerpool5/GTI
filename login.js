(function () {
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

  // If requireSession()/requireAdmin() just bounced someone here because
  // lockdown mode kicked in while they were signed in, say why.
  try {
    const lockoutMsg = sessionStorage.getItem('gti-lockout-message');
    if (lockoutMsg) {
      sessionStorage.removeItem('gti-lockout-message');
      setStatus(document.getElementById('signInStatus'), lockoutMsg, 'error');
    }
  } catch {}

  tabSignIn.addEventListener('click', () => showForm('signin'));
  tabSignUp.addEventListener('click', () => showForm('signup'));
  document.getElementById('forgotPasswordBtn').addEventListener('click', () => showForm('reset'));
  document.getElementById('backToSignIn').addEventListener('click', () => showForm('signin'));

  // Already signed in? Skip straight to the portal.
  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session) window.location.href = 'home.html';
  });

  const signInThrottle = new AttemptThrottle('signin', { maxFreeAttempts: 3, baseDelayMs: 2000, maxDelayMs: 60000 });
  function secondsLeft(ms) { return Math.ceil(ms / 1000); }

  // SIGN IN
  signInForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('signInStatus');
    const submitBtn = document.getElementById('signInSubmit');

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
      setStatus(status, lockdownMessage, 'error');
      submitBtn.disabled = false;
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
    const submitBtn = document.getElementById('signUpSubmit');

    if (document.getElementById('companyWebsite2').value) return; // honeypot

    const courseSelect = document.getElementById('signUpCourse');
    const name = document.getElementById('signUpName').value.trim();
    const studentId = document.getElementById('signUpStudentId').value.trim();
    const email = document.getElementById('signUpEmail').value.trim();
    const password = document.getElementById('signUpPassword').value;

    if (!courseSelect.value) {
      setStatus(status, 'Please select a course.', 'error');
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
          full_name: name,
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