/* Emails tab — shared by admin.html (root) and lecturer-home.html (admins + root).

   window.EmailManager.init(container, { isSuperAdmin })

   - Everyone who reaches this (admin or root) gets the template editor:
     Accepted / Denied / Pending / Test needed. Templates are structured
     fields (subject, heading, body, button, footer, colour) rather than raw
     HTML, so an admin can change how an email looks but can't inject markup
     or scripts into mail sent to students.
   - Root additionally gets the SMTP setup card. The SMTP password is only
     ever sent to the `email-admin` edge function; it is never read back.

   Like the rest of the portal, hiding this in the UI is a convenience only:
   the real gates are the RLS policies and the edge function (email-setup.sql,
   email-admin/index.ts). Depends on app.js (supabaseClient, setStatus, toast). */
(function () {
  const TYPES = [
    { key: 'accepted', label: 'Accepted' },
    { key: 'denied', label: 'Denied' },
    { key: 'pending', label: 'Pending' },
    { key: 'test_needed', label: 'Test needed' },
  ];

  // Keep in sync with the seed rows in email-setup.sql.
  const DEFAULTS = {
    accepted: {
      subject: 'Your GTI application has been accepted',
      heading: 'Welcome to GTI, {{first_name}}!',
      body: 'Good news — your application for {{course}} has been accepted.\n\nYou can now sign in to the student portal to check your timetable, announcements and course record.\n\n{{note}}',
      button_label: 'Open the student portal', button_url: '{{portal_url}}',
      footer: 'Government Technical Institute', accent_color: '#1f7a4d',
    },
    denied: {
      subject: 'An update on your GTI application',
      heading: 'Application update',
      body: 'Hello {{first_name}},\n\nThank you for applying for {{course}}. Unfortunately we are unable to offer you a place at this time.\n\n{{note}}\n\nIf you have questions, please contact the administration office.',
      button_label: '', button_url: '',
      footer: 'Government Technical Institute', accent_color: '#a33a3a',
    },
    pending: {
      subject: 'We have received your GTI application',
      heading: 'Application received',
      body: 'Hello {{first_name}},\n\nWe have received your application for {{course}} (Student ID {{student_id}}). It is currently being reviewed and we will email you as soon as there is a decision.\n\n{{note}}',
      button_label: '', button_url: '',
      footer: 'Government Technical Institute', accent_color: '#b7791f',
    },
    test_needed: {
      subject: 'Next step: entrance test for your GTI application',
      heading: 'A test is required, {{first_name}}',
      body: 'Hello {{first_name}},\n\nBefore we can finish reviewing your application for {{course}}, you need to sit a short test.\n\n{{note}}\n\nPlease reply to this email if you cannot attend.',
      button_label: 'Open the student portal', button_url: '{{portal_url}}',
      footer: 'Government Technical Institute', accent_color: '#1f4e8c',
    },
  };

  const PLACEHOLDERS = ['first_name', 'full_name', 'course', 'student_id', 'portal_url', 'note'];
  const SAMPLE = {
    first_name: 'Alex', full_name: 'Alex Johnson', course: 'Electrical Engineering',
    student_id: '25-1729', portal_url: window.location.origin + '/',
    note: '(Any extra note you add when sending appears here.)',
  };

  /* ---------- tiny helpers ---------- */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach((c) => node.append(c));
    return node;
  }

  let uid = 0;
  function field(labelText, input, hint) {
    const id = 'emailField' + (++uid);
    input.id = id;
    const frag = document.createDocumentFragment();
    frag.append(el('label', { for: id, text: labelText }), input);
    if (hint) frag.append(el('p', { class: 'field-hint', text: hint }));
    return frag;
  }

  const fill = (s, vars) => String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in vars ? vars[k] : ''));

  // The edge function returns { error } with a non-2xx status; supabase-js
  // wraps that, so dig the message back out.
  async function invokeError(error) {
    try {
      if (error && error.context && typeof error.context.json === 'function') {
        const body = await error.context.json();
        if (body && body.error) return body.error;
      }
    } catch (e) { /* fall through */ }
    return 'Request failed. Please try again.';
  }

  /* ---------- live preview (mirror of renderHtml in email-admin/index.ts) ---------- */
  // Letterhead details, taken from the institute's registration form.
  // Keep in sync with LETTERHEAD in email-admin/index.ts.
  const LETTERHEAD = {
    name: 'Government Technical Institute',
    address: 'Woolford Avenue, Non-Pariel Park, Georgetown',
    email: 'gti_guyana@yahoo.com',
    tel: '592-226-2468',
  };
  const SERIF = "Georgia,'Times New Roman',Times,serif";

  function renderPreview(target, t) {
    const vars = SAMPLE;
    target.replaceChildren();
    const outer = el('div', { style: `background:#eef0f3;padding:14px;border-radius:8px;font-family:${SERIF};color:#1f2937;` });
    const card = el('div', { style: `max-width:600px;margin:0 auto;background:#fff;border:1px solid #d9dde3;border-top:5px solid ${t.accent_color};` });

    const head = el('div', { style: 'padding:26px 24px 8px;text-align:center;' });
    head.append(
      el('img', { src: 'gti.png', width: '150', height: '105', alt: 'GTI crest', style: 'display:block;margin:0 auto 10px;border:0;max-width:100%;height:auto;' }),
      el('div', { style: 'font-size:19px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#111827;', text: LETTERHEAD.name }),
      el('div', { style: 'font-size:12.5px;font-weight:bold;margin-top:6px;color:#374151;', text: LETTERHEAD.address }),
      el('div', { style: 'font-size:12.5px;margin-top:4px;color:#374151;' }, [
        document.createTextNode('E-mail: '),
        el('span', { style: 'color:#1a6fc4;', text: LETTERHEAD.email }),
        document.createTextNode('  |  Tel: ' + LETTERHEAD.tel),
      ]),
    );
    card.append(head);

    card.append(el('div', {
      style: `margin:18px 24px 0;border-top:2px solid ${t.accent_color};border-bottom:1px solid #e5e7eb;padding:13px 0;text-align:center;font-size:18px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px;color:${t.accent_color};`,
      text: fill(t.heading, vars) || ' ',
    }));

    const bodyBox = el('div', { style: 'padding:22px 24px 10px;font-size:15px;' });
    fill(t.body, vars).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).forEach((p) => {
      const para = el('p', { style: 'margin:0 0 15px;line-height:1.6;' });
      p.split('\n').forEach((line, i) => { if (i) para.append(document.createElement('br')); para.append(document.createTextNode(line)); });
      bodyBox.append(para);
    });
    if (t.button_label && /^https?:\/\//i.test(fill(t.button_url, vars))) {
      bodyBox.append(el('p', { style: 'margin:24px 0 6px;text-align:center;' }, [
        el('span', { style: `display:inline-block;background:${t.accent_color};color:#fff;font-weight:bold;font-family:Arial,Helvetica,sans-serif;font-size:13.5px;padding:11px 24px;border-radius:4px;`, text: fill(t.button_label, vars) }),
      ]));
    }
    card.append(bodyBox);

    const foot = el('div', { style: 'margin:10px 24px 0;padding:13px 0 20px;border-top:1px solid #e5e7eb;text-align:center;font-size:12px;color:#6b7280;' });
    if (t.footer) foot.append(el('p', { style: 'margin:0 0 4px;', text: fill(t.footer, vars) }));
    foot.append(el('p', { style: 'margin:0;', text: LETTERHEAD.address + ' · Tel ' + LETTERHEAD.tel }));
    card.append(foot);

    outer.append(card);
    target.append(outer);
  }

  function validateTemplate(t) {
    if (!t.subject.trim()) return 'Subject is required.';
    if (t.subject.length > 200) return 'Subject is too long (200 max).';
    if (t.heading.length > 120) return 'Heading is too long (120 max).';
    if (t.body.length > 4000) return 'Body is too long (4000 max).';
    if (t.button_label.length > 60) return 'Button label is too long (60 max).';
    if (t.footer.length > 500) return 'Footer is too long (500 max).';
    if (!/^#[0-9a-f]{6}$/i.test(t.accent_color)) return 'Pick a valid colour.';
    if (t.button_label && !t.button_url.trim()) return 'A button needs a link (or clear the button label).';
    if (t.button_url && !/^(https:\/\/|\{\{portal_url\}\})/i.test(t.button_url))
      return 'Button link must start with https:// or be {{portal_url}}.';
    return null;
  }

  /* ---------- Step-by-step confirmation dialog ---------- */
  // steps: [{ title, text, button, typed? }] — resolves true only if every
  // step is accepted. A step with `typed` also needs that exact word typed.
  function confirmSteps(steps) {
    return new Promise((resolve) => {
      let i = 0;
      const backdrop = el('div', { class: 'modal-backdrop' });
      const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
      backdrop.append(modal);

      function finish(result) {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') finish(false); }
      document.addEventListener('keydown', onKey);
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(false); });

      function render() {
        const step = steps[i];
        const cancel = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Cancel' });
        const next = el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: step.button });
        cancel.addEventListener('click', () => finish(false));

        modal.replaceChildren(
          el('div', { class: 'modal-header' }, [el('h2', { style: 'margin:0;', text: step.title })]),
          el('p', { class: 'field-hint', style: 'margin:0 0 10px;', text: 'Warning ' + (i + 1) + ' of ' + steps.length }),
          el('p', { style: 'margin:0 0 14px;line-height:1.5;', text: step.text }),
        );

        let typedInput = null;
        if (step.typed) {
          typedInput = el('input', { type: 'text', autocomplete: 'off', placeholder: 'Type ' + step.typed + ' to continue' });
          next.disabled = true;
          typedInput.addEventListener('input', () => { next.disabled = typedInput.value.trim() !== step.typed; });
          modal.append(typedInput);
        }
        modal.append(el('div', { class: 'card-row-between', style: 'margin-top:14px;' }, [cancel, next]));

        next.addEventListener('click', () => {
          if (i < steps.length - 1) { i += 1; render(); } else finish(true);
        });
        (typedInput || cancel).focus();
      }

      document.body.append(backdrop);
      render();
    });
  }

  /* ---------- SMTP card (root only) ---------- */
  // Once SMTP has been set up, the card collapses into a read-only summary.
  // Editing it (which includes replacing the password) takes three warnings,
  // so it can't be changed by a stray click. First-time setup has no gate.
  async function buildSmtpCard() {
    const card = el('div', { class: 'card' });
    const lockBadge = el('span', { class: 'badge badge-verified', text: 'Locked', hidden: true });
    card.append(
      el('div', { class: 'card-row-between' }, [
        el('h3', { style: 'margin:0;', text: 'SMTP server' }),
        el('span', {}, [lockBadge, document.createTextNode(' '), el('span', { class: 'badge badge-admin', text: 'Root only' })]),
      ]),
      el('p', { style: 'margin:8px 0 12px;color:var(--slate);font-size:0.9rem;', text: 'The mail server the portal sends these emails through. The password is stored server-side only and is never shown again after you save it.' }),
    );

    const summary = el('div', { hidden: true });
    const formWrap = el('div');
    card.append(summary, formWrap);

    const enabled = el('input', { type: 'checkbox' });
    const host = el('input', { type: 'text', maxlength: '253', placeholder: 'smtp.example.com', autocomplete: 'off' });
    const port = el('input', { type: 'number', min: '1', max: '65535', value: '465' });
    const security = el('select', {}, [
      el('option', { value: 'ssl', text: 'SSL/TLS — port 465 (use this)' }),
      el('option', { value: 'starttls', text: 'STARTTLS — port 587 (blocked on Supabase)' }),
    ]);
    const username = el('input', { type: 'text', maxlength: '254', autocomplete: 'off' });
    const password = el('input', { type: 'password', maxlength: '512', autocomplete: 'new-password' });
    const fromEmail = el('input', { type: 'email', maxlength: '254', placeholder: 'no-reply@yourdomain.com' });
    const fromName = el('input', { type: 'text', maxlength: '100', value: 'GTI Student Portal' });
    const replyTo = el('input', { type: 'email', maxlength: '254', placeholder: 'optional' });
    const status = el('p', { class: 'status-message', role: 'alert' });
    const saveBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Save SMTP settings' });
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Cancel and lock', hidden: true });

    const enabledLabel = el('label', { style: 'display:flex;align-items:center;gap:8px;' }, [enabled, document.createTextNode('Sending enabled')]);
    formWrap.append(enabledLabel);
    formWrap.append(field('SMTP host', host), field('Port', port), field('Connection security', security),
      field('Username', username), field('Password', password), field('From address', fromEmail),
      field('From name', fromName), field('Reply-to address', replyTo), status,
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;' }, [saveBtn, cancelBtn]));

    // What is currently saved on the server (as far as this page knows).
    let saved = null;
    let hasPassword = false;
    function reflectPassword() {
      password.placeholder = hasPassword ? '•••••••• saved — leave blank to keep it' : 'SMTP password';
    }
    function isConfigured() { return !!(saved && saved.host && saved.username && saved.from_email && hasPassword); }

    function fillInputs(d) {
      enabled.checked = !!(d && d.enabled);
      host.value = (d && d.host) || '';
      port.value = (d && d.port) || 465;
      security.value = (d && d.security) || 'ssl';
      username.value = (d && d.username) || '';
      fromEmail.value = (d && d.from_email) || '';
      fromName.value = (d && d.from_name) || 'GTI Student Portal';
      replyTo.value = (d && d.reply_to) || '';
      password.value = '';
      reflectPassword();
    }

    function row(label, value) {
      return el('div', { style: 'display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--border, #e5e7eb);' }, [
        el('span', { style: 'flex:0 0 130px;color:var(--slate);font-size:0.88rem;', text: label }),
        el('span', { style: 'word-break:break-word;', text: value }),
      ]);
    }

    function showSummary() {
      const changeBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Change SMTP settings…' });
      changeBtn.addEventListener('click', async () => {
        const ok = await confirmSteps([
          {
            title: 'Change the SMTP settings?',
            text: 'These settings control every email the portal sends — support-ticket emails and the accepted, denied, pending and test-needed emails. Only continue if you really mean to change them.',
            button: 'I understand, continue',
          },
          {
            title: 'A wrong password stops all email',
            text: 'If the host, username or password you save is wrong, nobody will receive portal emails and nothing will warn them. The current password can\'t be viewed again once it\'s replaced, so have the new details ready before you go on.',
            button: 'Continue anyway',
          },
          {
            title: 'Last check',
            text: 'You are about to unlock the SMTP settings, including the password. After saving, send a test email straight away to confirm it still works.',
            button: 'Unlock settings',
            typed: 'CHANGE',
          },
        ]);
        if (!ok) return;
        showForm(true);
      });

      summary.replaceChildren(
        row('Sending', saved.enabled ? 'Enabled' : 'Switched off'),
        row('Server', saved.host + ':' + saved.port + (saved.security === 'ssl' ? ' (SSL/TLS)' : ' (STARTTLS)')),
        row('Username', saved.username),
        row('Password', '•••••••• saved (hidden)'),
        row('From', (saved.from_name ? saved.from_name + ' ' : '') + '<' + saved.from_email + '>'),
        row('Reply-to', saved.reply_to || '—'),
        el('div', { style: 'margin-top:12px;' }, [changeBtn]),
      );
      summary.hidden = false;
      formWrap.hidden = true;
      lockBadge.hidden = false;
    }

    function showForm(editing) {
      summary.hidden = true;
      formWrap.hidden = false;
      lockBadge.hidden = true;
      cancelBtn.hidden = !editing;
      if (editing) fillInputs(saved);
    }

    cancelBtn.addEventListener('click', () => {
      fillInputs(saved);
      setStatus(status, '', null);
      showSummary();
    });

    const { data, error } = await supabaseClient.from('email_settings').select('*').eq('id', 1).maybeSingle();
    if (error) {
      setStatus(status, 'Could not load SMTP settings. Has email-setup.sql been run?', 'error');
      showForm(false);
    } else {
      saved = data || null;
      hasPassword = !!(data && data.has_password === true);
      fillInputs(data);
      if (isConfigured()) showSummary(); else showForm(false);
    }

    // Switching security type is the most common cause of "it just hangs" —
    // nudge the port to the matching default if it's still on the other one.
    security.addEventListener('change', () => {
      if (security.value === 'ssl' && port.value === '587') port.value = '465';
      if (security.value === 'starttls' && port.value === '465') port.value = '587';
      setStatus(status, security.value === 'starttls' ? 'Supabase blocks outgoing port 587 — SSL/TLS on 465 is the one that works.' : '', security.value === 'starttls' ? 'error' : null);
    });

    saveBtn.addEventListener('click', async () => {
      setStatus(status, '', null);
      if (!host.value.trim() || !fromEmail.value.trim() || !username.value.trim()) {
        setStatus(status, 'Host, username and From address are required.', 'error');
        return;
      }
      if (!hasPassword && !password.value) {
        setStatus(status, 'Enter the SMTP password.', 'error');
        return;
      }
      if (Number(port.value) === 587 || Number(port.value) === 25) {
        setStatus(status, 'Supabase blocks outgoing ports 25 and 587. Use SSL/TLS on port 465.', 'error');
        return;
      }
      saveBtn.disabled = true;
      const settings = {
        enabled: enabled.checked, host: host.value.trim(), port: Number(port.value),
        security: security.value, username: username.value.trim(),
        from_email: fromEmail.value.trim(), from_name: fromName.value.trim(), reply_to: replyTo.value.trim(),
      };
      const { error: invokeErr } = await supabaseClient.functions.invoke('email-admin', {
        body: { action: 'save_smtp', settings: { ...settings, password: password.value } },
      });
      saveBtn.disabled = false;
      if (invokeErr) { setStatus(status, await invokeError(invokeErr), 'error'); return; }
      if (password.value) hasPassword = true;
      saved = { ...settings, reply_to: settings.reply_to || null };
      password.value = '';
      reflectPassword();
      setStatus(status, '', null);
      toast('SMTP settings saved and locked. Use "Send test to me" below to check they work.', 'success');
      showSummary();
    });

    return card;
  }

  /* ---------- Template editor (admins + root) ---------- */
  async function buildTemplatesCard() {
    const card = el('div', { class: 'card' });
    card.append(
      el('h3', { style: 'margin-top:0;', text: 'Email templates' }),
      el('p', { style: 'margin:0 0 12px;color:var(--slate);font-size:0.9rem;', text: 'Change how each status email looks and reads. Blank lines start a new paragraph.' }),
    );

    const templates = {};
    const { data, error } = await supabaseClient.from('email_templates').select('*');
    if (error) {
      card.append(el('p', { class: 'status-message error visible', text: 'Could not load templates. Has email-setup.sql been run?' }));
      return card;
    }
    (data || []).forEach((r) => { templates[r.key] = r; });

    const typeSelect = el('select', {}, TYPES.map((t) => el('option', { value: t.key, text: t.label })));
    const enabled = el('input', { type: 'checkbox' });
    const subject = el('input', { type: 'text', maxlength: '200' });
    const heading = el('input', { type: 'text', maxlength: '120' });
    const bodyBox = el('textarea', { maxlength: '4000', rows: '9' });
    const buttonLabel = el('input', { type: 'text', maxlength: '60', placeholder: 'optional, e.g. Open the student portal' });
    const buttonUrl = el('input', { type: 'text', maxlength: '500', placeholder: 'https://… or {{portal_url}}' });
    const footer = el('textarea', { maxlength: '500', rows: '2' });
    const colour = el('input', { type: 'color', value: '#1f4e8c', style: 'width:64px;height:38px;padding:2px;' });
    const status = el('p', { class: 'status-message', role: 'alert' });
    const saveBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Save changes' });
    const resetBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Reset to default' });
    const testBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Send test to me' });
    const previewBox = el('div');

    const enabledLabel = el('label', { style: 'display:flex;align-items:center;gap:8px;' }, [enabled, document.createTextNode('Send this email')]);

    const form = el('div');
    form.append(
      field('Email type', typeSelect), enabledLabel,
      field('Subject', subject), field('Heading (coloured header bar)', heading),
      field('Body', bodyBox, 'Placeholders: ' + PLACEHOLDERS.map((p) => '{{' + p + '}}').join('  ')),
      field('Button label', buttonLabel), field('Button link', buttonUrl),
      field('Footer', footer), field('Accent colour', colour), status,
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;' }, [saveBtn, resetBtn, testBtn]),
    );

    const preview = el('div', {}, [el('strong', { text: 'Preview (sample data)' }), el('div', { style: 'margin-top:8px;' }, [previewBox])]);
    card.append(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px;align-items:start;' }, [form, preview]));

    function draft() {
      return {
        subject: subject.value, heading: heading.value, body: bodyBox.value,
        button_label: buttonLabel.value.trim(), button_url: buttonUrl.value.trim(),
        footer: footer.value, accent_color: colour.value,
      };
    }
    function load(t) {
      subject.value = t.subject; heading.value = t.heading; bodyBox.value = t.body;
      buttonLabel.value = t.button_label || ''; buttonUrl.value = t.button_url || '';
      footer.value = t.footer || ''; colour.value = t.accent_color;
      renderPreview(previewBox, draft());
    }
    function loadKey(key) {
      const row = templates[key] || DEFAULTS[key];
      enabled.checked = templates[key] ? templates[key].enabled !== false : true;
      load(row);
      setStatus(status, '', null);
    }

    [subject, heading, bodyBox, buttonLabel, buttonUrl, footer, colour].forEach((n) =>
      n.addEventListener('input', () => renderPreview(previewBox, draft())));
    typeSelect.addEventListener('change', () => loadKey(typeSelect.value));

    resetBtn.addEventListener('click', () => {
      if (!confirm('Reset this email to its default wording and colour? (Nothing is saved until you click Save changes.)')) return;
      load(DEFAULTS[typeSelect.value]);
      setStatus(status, 'Default restored — click Save changes to keep it.', 'success');
    });

    saveBtn.addEventListener('click', async () => {
      const t = draft();
      const problem = validateTemplate(t);
      if (problem) { setStatus(status, problem, 'error'); return; }
      saveBtn.disabled = true;
      setStatus(status, '', null);
      const { data: session } = await supabaseClient.auth.getUser();
      const patch = { ...t, enabled: enabled.checked, updated_at: new Date().toISOString(), updated_by: session && session.user ? session.user.id : null };
      const { error: updateErr } = await supabaseClient.from('email_templates').update(patch).eq('key', typeSelect.value);
      saveBtn.disabled = false;
      if (updateErr) { console.error('Saving template failed:', updateErr); setStatus(status, 'Could not save. Please try again.', 'error'); return; }
      templates[typeSelect.value] = { ...(templates[typeSelect.value] || {}), ...patch, key: typeSelect.value };
      setStatus(status, 'Saved.', 'success');
      toast('Email template saved.', 'success');
    });

    testBtn.addEventListener('click', async () => {
      const t = draft();
      const problem = validateTemplate(t);
      if (problem) { setStatus(status, problem, 'error'); return; }
      testBtn.disabled = true;
      setStatus(status, 'Sending…', null);
      const { data: res, error: invokeErr } = await supabaseClient.functions.invoke('email-admin', {
        body: { action: 'send_test', template: t, portal_url: window.location.origin + '/' },
      });
      testBtn.disabled = false;
      if (invokeErr) { setStatus(status, await invokeError(invokeErr), 'error'); return; }
      setStatus(status, 'Test sent to ' + ((res && res.sent_to) || 'your address') + ' (your current edits, saved or not).', 'success');
    });

    loadKey('accepted');
    return card;
  }

  /* ---------- public entry point ---------- */
  window.EmailManager = {
    async init(container, opts) {
      if (!container) return;
      container.replaceChildren(el('div', { class: 'skeleton skeleton-line', style: 'width:200px;' }));
      try {
        const cards = [];
        if (opts && opts.isSuperAdmin) cards.push(await buildSmtpCard());
        cards.push(await buildTemplatesCard());
        container.replaceChildren(...cards);
      } catch (e) {
        console.error('Emails tab failed to load:', e);
        container.replaceChildren(el('p', { class: 'status-message error visible', text: 'Could not load the Emails tab.' }));
      }
    },
  };
})();