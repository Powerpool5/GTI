(function () {
  const form = document.getElementById('resetForm');
  const passwordInput = document.getElementById('password');
  const confirmInput = document.getElementById('confirmPassword');
  const submitBtn = document.getElementById('resetSubmit');
  const status = document.getElementById('resetStatus');
  const formWrap = document.getElementById('resetFormWrap');
  const invalidWrap = document.getElementById('resetInvalid');
  const invalidText = document.getElementById('resetInvalidText');

  function showInvalid(message) {
    formWrap.hidden = true;
    invalidWrap.hidden = false;
    if (message) invalidText.textContent = message;
  }

  // Supabase sends the user back here with the recovery token in the URL
  // hash. supabase-js (detectSessionInUrl: true, set in app.js) exchanges
  // it for a session automatically and fires a PASSWORD_RECOVERY event.
  // If the link was already used or has expired, Supabase instead appends
  // an error to the hash — catch that case up front.
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const urlError = hashParams.get('error_description') || hashParams.get('error');
  if (urlError) {
    showInvalid(decodeURIComponent(urlError.replace(/\+/g, ' ')));
    return;
  }

  let recoveryReady = false;

  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') recoveryReady = true;
  });

  // Fallback in case the event fired before this listener attached.
  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session) recoveryReady = true;
    window.setTimeout(() => {
      if (!recoveryReady) showInvalid('This reset link is invalid or has expired. Please request a new one.');
    }, 1500);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const password = passwordInput.value;
    const confirmPassword = confirmInput.value;

    if (password.length < 8) {
      setStatus(status, 'Password must be at least 8 characters.', 'error');
      return;
    }
    if (password !== confirmPassword) {
      setStatus(status, 'Passwords do not match.', 'error');
      return;
    }
    if (!recoveryReady) {
      setStatus(status, 'This reset link is invalid or has expired. Please request a new one.', 'error');
      return;
    }

    submitBtn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient.auth.updateUser({ password });

    submitBtn.disabled = false;

    if (error) {
      setStatus(status, friendlyAuthError(error), 'error');
      return;
    }

    setStatus(status, 'Password updated. Redirecting you to sign in…', 'success');
    form.reset();
    // Sign out of the temporary recovery session so the person has to
    // sign back in with the new password, confirming it actually works.
    await supabaseClient.auth.signOut();
    window.setTimeout(() => { window.location.href = 'index.html'; }, 1500);
  });
})();