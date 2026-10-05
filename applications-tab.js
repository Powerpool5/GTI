/* =========================================================
   Applications tab (staff dashboard, admins only)

   Reads and reviews the applications submitted on the public
   registration form. That data lives in the SEPARATE "Registration"
   Supabase project — it is never copied into, or joined with, the
   student-portal database (app.js's supabaseClient).

   There is no second login. The admin is already signed in to the
   portal, so this file sends that portal session token to the
   Registration project's "staff-applications" edge function. The
   function asks the portal "who is this, and is_admin()?" and only
   then touches the applications. A browser can't skip that check:
   the applications tables have no public access at all.

   The interview rule (Accept / Deny / Exam required only after the
   applicant has been interviewed) is enforced by that function and by a
   constraint on the applications table, not just by greyed-out buttons.

   Everything from the database is applicant-typed text, so it is only
   ever put on the page with textContent / text nodes, never innerHTML.
   ========================================================= */
(function () {
  'use strict';

  // Edge function in the Registration project (see header comment).
  const FN_URL = 'https://hwwdsfcrndgugqquurou.supabase.co/functions/v1/staff-applications';

  // Same folder-relative URL email-tab.js uses, so the button in the acceptance
  // email opens the portal (the site lives in a sub-folder, not at the domain root).
  const PORTAL_URL = new URL('./', window.location.href).href;

  let rootEl = null;
  let apps = [];
  let modalEl = null;
  let openId = null;
  const ui = {};

  /* ---------------- talking to the registration function ---------------- */

  async function api(action, params) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) throw new Error('not_authorized');
    let res;
    try {
      res = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
        body: JSON.stringify(Object.assign({ action }, params || {})),
      });
    } catch {
      throw new Error('network');
    }
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new Error((body && body.error) || 'http_' + res.status);
    return body;
  }

  /* ---------------- small helpers ---------------- */

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    kids.flat().forEach((c) => {
      if (c == null || c === false) return;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  function fmtDate(value, withTime) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d)) return String(value);
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
    return d.toLocaleString('en-GB', opts);
  }

  function fullName(a) {
    return [a.first_name, a.other_name, a.last_name].filter(Boolean).join(' ');
  }

  function yesNo(v) {
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    return '—';
  }

  function gradeLabel(g) {
    return g === 'PENDING' ? 'Pending' : 'Grade ' + g;
  }

  function acceptedMessage(a, d) {
    let msg = fullName(a) + ' accepted (student ID ' + d.student_id + ').';
    if (d.emailed) msg += ' Acceptance email sent.';
    else if (d.email_skipped === 'template_disabled') msg += ' No email sent: the "Approved" template is switched off.';
    else if (d.email_skipped === 'smtp_disabled') msg += ' No email sent: sending is switched off in the SMTP settings.';
    else msg += ' No email was sent.';
    if (!d.course_mapped) msg += ' Their course has no portal match, so they will pick it at sign-up.';
    return msg + ' They stay in the list, marked Accepted.';
  }

  // What happened with the email that goes out with Exam Required / Denied (same SMTP + templates as the Emails tab).
  function decisionEmailNote(d) {
    if (!d || typeof d.emailed !== 'boolean') return { text: '', failed: false };
    if (d.emailed) return { text: ' Email sent to the applicant.', failed: false };
    if (d.email_skipped === 'already_sent') return { text: '', failed: false };
    if (d.email_skipped === 'template_disabled') return { text: ' No email sent: that email template is switched off.', failed: false };
    if (d.email_skipped === 'smtp_disabled') return { text: ' No email sent: sending is switched off in the SMTP settings.', failed: false };
    return { text: ' The email could not be sent. Check the SMTP settings in the Emails tab.', failed: true };
  }

  function isNotAuthorized(error) {
    return String((error && error.message) || '').includes('not_authorized');
  }

  function friendlyError(error) {
    const m = String((error && error.message) || '');
    if (m.includes('not_interviewed')) return 'Mark the applicant as interviewed first.';
    if (m.includes('cannot_unmark')) return "A decision has already been made, so the interview can't be unmarked.";
    if (m.includes('not_found')) return 'That application no longer exists. Refresh the list.';
    if (m.includes('invalid_decision')) return 'That decision is not recognised.';
    if (m.includes('accept_failed')) return 'The acceptance email or student record could not be saved, so nothing was changed. Check the Emails settings (sending enabled, SMTP) and try again.';
    if (m.includes('bad_reference')) return "This application's reference number is not in the expected format, so a student ID could not be made.";
    if (isNotAuthorized(error)) return 'Only admins can review applications.';
    if (m.includes('network')) return 'Could not reach the registration system. Check your connection.';
    return 'Something went wrong. Please try again.';
  }

  const FIRST_STATUS = 'Pending'; // new applications start here (the Pending email is sent automatically on submit)

  function statusOf(a) { return a.status || FIRST_STATUS; }

  function statusBadge(status) {
    const st = status || FIRST_STATUS;
    const cls = st === 'Accepted' ? 'badge-verified'
      : st === 'Denied' ? 'badge-inactive'
      : st === 'Exam Required' ? 'badge-grade-c'
      : 'badge-unverified';
    return h('span', { class: 'badge ' + cls, text: st });
  }

  function interviewBadge(a) {
    return a.interviewed_at
      ? h('span', { class: 'badge badge-verified', text: 'Interviewed' })
      : h('span', { class: 'badge badge-unverified', text: 'Not interviewed' });
  }

  /* ---------------- qualifications ---------------- */

  // Which kinds of qualification an applicant listed: any of 'csec', 'cape', 'other'.
  // An empty set means none at all.
  function qualKinds(a) {
    const kinds = new Set();
    (a.secondary_qualifications || []).forEach((q) => {
      if (q.exam === 'CSEC') kinds.add('csec');
      else if (q.exam === 'CAPE') kinds.add('cape');
    });
    if ((a.other_qualifications || []).length) kinds.add('other');
    return kinds;
  }

  function matchesQual(a, f) {
    if (!f || f === 'all') return true;
    const kinds = qualKinds(a);
    return f === 'none' ? kinds.size === 0 : kinds.has(f);
  }

  // CSEC / CAPE / Other badges, or a red "!" icon + "None" when there are no qualifications.
  function qualCell(a) {
    const kinds = qualKinds(a);
    if (!kinds.size) {
      return h('span', { class: 'app-quals' },
        h('span', { class: 'app-qual-warn', title: 'No qualifications listed on this application', 'aria-label': 'Warning: no qualifications', role: 'img', text: '!' }),
        h('span', { class: 'app-qual-none', text: 'None' }));
    }
    return h('span', { class: 'app-quals' },
      kinds.has('csec') ? h('span', { class: 'badge badge-verified', text: 'CSEC' }) : null,
      kinds.has('cape') ? h('span', { class: 'badge badge-verified', text: 'CAPE' }) : null,
      kinds.has('other') ? h('span', { class: 'badge badge-unverified', text: 'Other' }) : null);
  }

  // Department choices come from the applications themselves.
  function refreshDeptOptions() {
    if (!ui.dept) return;
    const keep = ui.dept.value || 'all';
    const depts = [...new Set(apps.map((a) => a.dept1).filter(Boolean))].sort((x, y) => x.localeCompare(y));
    ui.dept.replaceChildren(h('option', { value: 'all', text: 'All departments' }),
      ...depts.map((d) => h('option', { value: d, text: d })));
    ui.dept.value = depts.includes(keep) ? keep : 'all';
  }

  /* ---------------- list view ---------------- */

  function renderWorkspace() {
    rootEl.replaceChildren();

    ui.search = h('input', { type: 'search', placeholder: 'Search by name, reference, email or course…', 'aria-label': 'Search applications' });
    ui.filter = h('select', { 'aria-label': 'Filter by stage' },
      h('option', { value: 'all', text: 'All applications' }),
      h('option', { value: 'awaiting', text: 'Awaiting interview' }),
      h('option', { value: 'interviewed', text: 'Interviewed — needs a decision' }),
      h('option', { value: 'exam', text: 'Exam required' }),
      h('option', { value: 'accepted', text: 'Accepted' }),
      h('option', { value: 'denied', text: 'Denied' }));
    ui.qual = h('select', { 'aria-label': 'Filter by qualifications' },
      h('option', { value: 'all', text: 'All qualifications' }),
      h('option', { value: 'csec', text: 'CSEC' }),
      h('option', { value: 'cape', text: 'CAPE' }),
      h('option', { value: 'other', text: 'Other qualifications' }),
      h('option', { value: 'none', text: 'None (no qualifications)' }));
    ui.gender = h('select', { 'aria-label': 'Filter by gender' },
      h('option', { value: 'all', text: 'All genders' }),
      h('option', { value: 'Male', text: 'Male' }),
      h('option', { value: 'Female', text: 'Female' }));
    ui.dept = h('select', { 'aria-label': 'Filter by department' },
      h('option', { value: 'all', text: 'All departments' }));
    ui.refresh = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Refresh' });
    ui.count = h('p', { class: 'field-hint', 'aria-live': 'polite', style: 'margin:0 0 10px;' });
    ui.tbody = h('tbody');

    ui.search.addEventListener('input', renderRows);
    ui.filter.addEventListener('change', renderRows);
    ui.qual.addEventListener('change', renderRows);
    ui.gender.addEventListener('change', renderRows);
    ui.dept.addEventListener('change', renderRows);
    ui.refresh.addEventListener('click', () => loadApplications(true));

    rootEl.append(
      h('div', { class: 'card' },
        h('div', { class: 'search-row' }, ui.search, ui.filter, ui.qual, ui.gender, ui.dept, ui.refresh),
        ui.count,
        h('div', { class: 'table-wrap' },
          h('table', { class: 'admin-table' },
            h('thead', null, h('tr', null,
              h('th', { text: 'Reference' }), h('th', { text: 'Applicant' }), h('th', { text: 'First choice' }), h('th', { text: 'Qualifications' }),
              h('th', { text: 'Submitted' }), h('th', { text: 'Interview' }), h('th', { text: 'Status' }), h('th'))),
            ui.tbody))));
  }

  function matchesFilter(a, f) {
    const pending = statusOf(a) === FIRST_STATUS;
    switch (f) {
      case 'awaiting': return pending && !a.interviewed_at;
      case 'interviewed': return pending && !!a.interviewed_at;
      case 'exam': return a.status === 'Exam Required';
      case 'accepted': return a.status === 'Accepted';
      case 'denied': return a.status === 'Denied';
      default: return true;
    }
  }

  function renderRows() {
    if (!ui.tbody) return;
    const q = ui.search.value.trim().toLowerCase();
    const f = ui.filter.value;
    const rows = apps.filter((a) => {
      if (!matchesFilter(a, f)) return false;
      if (!matchesQual(a, ui.qual.value)) return false;
      if (ui.gender.value !== 'all') {
        const g = ui.gender.value;
        if (g === 'none' ? (a.gender === 'Male' || a.gender === 'Female') : a.gender !== g) return false;
      }
      if (ui.dept.value !== 'all' && a.dept1 !== ui.dept.value) return false;
      if (!q) return true;
      return [fullName(a), a.reference, a.email, a.course1, a.course2, a.dept1]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });

    ui.count.textContent = rows.length === apps.length
      ? apps.length + (apps.length === 1 ? ' application' : ' applications')
      : rows.length + ' of ' + apps.length + ' applications';

    ui.tbody.replaceChildren();
    if (!rows.length) {
      ui.tbody.append(h('tr', null, h('td', { colspan: '8', class: 'app-empty', text: apps.length ? 'No applications match your search.' : 'No applications have been submitted yet.' })));
      return;
    }
    rows.forEach((a) => {
      ui.tbody.append(h('tr', { class: a.status === 'Accepted' ? 'app-row-accepted' : null },
        h('td', null, h('code', { text: a.reference || '—' })),
        h('td', null, h('button', { type: 'button', class: 'btn-link app-name-link', text: fullName(a), onclick: () => openDetail(a.id) })),
        h('td', { text: a.course1 || '—' }),
        h('td', null, qualCell(a)),
        h('td', { text: fmtDate(a.submitted_at) }),
        h('td', null, interviewBadge(a)),
        h('td', null, statusBadge(a.status)),
        h('td', null, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Review', onclick: () => openDetail(a.id) }))));
    });
  }

  async function loadApplications(showToast) {
    if (ui.count) ui.count.textContent = 'Loading…';
    let data;
    try {
      data = await api('list');
    } catch (error) {
      if (ui.count) ui.count.textContent = '';
      toast('Could not load applications. ' + friendlyError(error), 'error');
      return;
    }
    apps = Array.isArray(data) ? data : [];
    refreshDeptOptions();
    renderRows();
    if (openId) renderDetail();
    if (showToast) toast('Applications refreshed.', 'success', 2000);
  }

  async function showWorkspace() {
    renderWorkspace();
    await loadApplications(false);
  }

  /* ---------------- detail popup ---------------- */

  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    openId = null;
    document.removeEventListener('keydown', onModalKey, true);
  }

  function onModalKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
  }

  function openDetail(id) {
    closeModal();
    openId = id;
    modalEl = h('div', { class: 'modal-backdrop' });
    modalEl.addEventListener('mousedown', (e) => { if (e.target === modalEl) closeModal(); });
    document.addEventListener('keydown', onModalKey, true);
    document.body.append(modalEl);
    renderDetail();
  }

  // Same building blocks and look as the student detail popup on the Students tab
  // (sd-header / sd-body / sd-section / sd-facts / sd-table).
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fact(label, value) {
    const w = el('div', 'sd-fact');
    const v = el('div', 'sd-fact-value');
    if (value instanceof Node) v.append(value);
    else v.textContent = value == null || value === '' ? '—' : String(value);
    w.append(el('div', 'sd-fact-label', label), v);
    return w;
  }

  function facts(...items) {
    const g = el('div', 'sd-facts');
    g.append(...items.filter(Boolean));
    return g;
  }

  function section(title, ...kids) {
    const s = el('section', 'sd-section');
    s.append(el('h3', 'sd-section-title', title));
    kids.forEach((k) => { if (k) s.append(k); });
    return s;
  }

  function table(headers, rows) {
    const wrap = el('div', 'table-wrap sd-table-wrap');
    const t = el('table', 'admin-table sd-table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    headers.forEach((x) => hr.append(el('th', null, x)));
    thead.append(hr);
    const tbody = document.createElement('tbody');
    rows.forEach((cells) => {
      const tr = document.createElement('tr');
      cells.forEach((c) => tr.append(el('td', null, c)));
      tbody.append(tr);
    });
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  async function openDocument(path, btn) {
    // Open the tab straight away (inside the click) so pop-up blockers allow it,
    // then point it at the short-lived signed link once we have it.
    const w = window.open('about:blank', '_blank');
    btn.disabled = true;
    let data = null;
    try { data = await api('sign', { path }); } catch { /* handled below */ }
    btn.disabled = false;
    if (!data || !data.signedUrl) {
      if (w) w.close();
      toast('Could not open that document.', 'error');
      return;
    }
    if (w) { w.opener = null; w.location.href = data.signedUrl; }
    else toast('Your browser blocked the pop-up. Allow pop-ups for this site and try again.', 'error');
  }

  function docRow(label, path) {
    const row = el('div', 'sd-file app-doc-row');
    row.append(el('span', 'sd-file-name', label));
    if (!path) {
      row.append(el('span', 'sd-note', 'Not uploaded'));
      return row;
    }
    const btn = el('button', 'btn btn-secondary btn-sm', 'Open ↗');
    btn.type = 'button';
    btn.addEventListener('click', () => openDocument(path, btn));
    row.append(btn);
    return row;
  }

  function renderDetail() {
    const a = apps.find((x) => x.id === openId);
    if (!a || !modalEl) return;
    const interviewed = !!a.interviewed_at;
    const awaiting = statusOf(a) === FIRST_STATUS;

    const status = el('p', 'status-message');
    status.setAttribute('role', 'alert');
    const buttons = [];

    function setBusy(on) { buttons.forEach((b) => { b.disabled = on || b.dataset.locked === '1'; }); }

    async function run(promise, okMessage) {
      setBusy(true);
      let data;
      try {
        data = await promise;
      } catch (error) {
        setBusy(false);
        setStatus(status, friendlyError(error), 'error');
        return;
      }
      setBusy(false);

      // Accepting emails the applicant and saves their student ID + course for sign-up.
      // The application stays in the list, marked Accepted (shown in a different colour).
      if (data && data.accepted) {
        const idx2 = apps.findIndex((x) => x.id === a.id);
        if (idx2 >= 0) apps[idx2] = Object.assign({}, apps[idx2], data);
        closeModal();
        renderRows();
        toast(acceptedMessage(a, data), data.emailed || data.email_skipped ? 'success' : 'error', 6000);
        return;
      }

      const idx = apps.findIndex((x) => x.id === a.id);
      if (idx >= 0 && data) apps[idx] = Object.assign({}, apps[idx], data);
      renderRows();
      renderDetail();
      const note = decisionEmailNote(data);
      toast(okMessage + note.text, note.failed ? 'error' : 'success', note.text ? 6000 : undefined);
    }

    function button(label, cls, locked, onClick) {
      const b = el('button', 'btn btn-sm' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      if (locked) { b.dataset.locked = '1'; b.disabled = true; }
      b.addEventListener('click', onClick);
      buttons.push(b);
      return b;
    }

    // ---- Interview ----
    const interviewBtn = button(
      interviewed ? 'Undo interview' : 'Mark as interviewed',
      interviewed ? 'btn-secondary' : '',
      interviewed && !awaiting,
      async () => {
        if (!interviewed) {
          const ok = await confirmAction({
            title: 'Mark as interviewed?',
            text: fullName(a) + ' will be recorded as interviewed, which unlocks Accept, Deny and Exam required.',
            confirmText: 'Mark as interviewed', danger: false,
          });
          if (ok) run(api('set_interviewed', { id: a.id, interviewed: true }), 'Marked as interviewed.');
        } else {
          const ok = await confirmAction({
            title: 'Undo interview?',
            text: fullName(a) + ' will go back to "Not interviewed" and decisions will be locked again.',
            confirmText: 'Undo interview',
          });
          if (ok) run(api('set_interviewed', { id: a.id, interviewed: false }), 'Interview unmarked.');
        }
      });
    if (interviewed && !awaiting) interviewBtn.title = 'A decision has been made.';

    // ---- Decision ----
    function decisionBtn(label, decision, cls, danger) {
      return button(label, cls, !interviewed || a.status === 'Accepted', async () => {
        const accepting = decision === 'Accepted';
        const ok = await confirmAction({
          title: label + '?',
          text: accepting
            ? fullName(a) + ' (' + a.reference + ') will be emailed their acceptance, and their student ID and course will be saved so their account is set up when they sign up. The application stays in the list, marked as Accepted.'
            : fullName(a) + ' (' + a.reference + ') will be set to "' + decision + '" and emailed the matching message from the Emails tab. Applicants also see this status when they check their application.',
          confirmText: label, danger: danger || accepting,
        });
        if (!ok) return;
        run(
          api('decide', { id: a.id, decision: decision, portal_url: PORTAL_URL }),
          'Application set to "' + decision + '".');
      });
    }
    const decisionRow = el('div', 'app-actions');
    decisionRow.append(
      decisionBtn('Accept', 'Accepted', '', false),
      decisionBtn('Exam required', 'Exam Required', 'btn-secondary', false),
      decisionBtn('Deny', 'Denied', 'btn-danger', true));

    const interviewRow = el('div', 'app-actions');
    interviewRow.append(interviewBtn);

    const statusSection = section('Status',
      facts(
        fact('Status', statusBadge(a.status)),
        fact('Qualifications', qualCell(a)),
        fact('Interview', interviewed ? 'Done · ' + fmtDate(a.interviewed_at, true) : 'Not done yet'),
        interviewed ? fact('Interviewed by', a.interviewed_by) : null,
        a.reviewed_at ? fact('Last decision', fmtDate(a.reviewed_at, true) + ' · ' + (a.reviewed_by || 'unknown')) : null),
      el('h4', 'sd-subtitle', '1. Interview'), interviewRow,
      el('h4', 'sd-subtitle', '2. Decision'), decisionRow,
      a.status === 'Accepted' ? el('p', 'sd-note sd-note-gap', 'This applicant has been accepted, so the decision is final.') : null,
      interviewed ? null : el('p', 'sd-note sd-note-gap', 'Accept, Exam required and Deny unlock once the applicant has been marked as interviewed.'),
      status);

    // ---- Header ----
    const closeBtn = el('button', 'modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', closeModal);

    const headerText = el('div', 'sd-header-text');
    headerText.append(
      el('h2', null, fullName(a) || 'Applicant'),
      el('p', null, [a.reference, 'Submitted ' + fmtDate(a.submitted_at)].filter(Boolean).join(' · ')));
    const header = el('div', 'sd-header');
    header.append(el('div', 'sd-avatar', (a.first_name || '?').trim().charAt(0).toUpperCase()), headerText, closeBtn);

    // ---- Body ----
    const body = el('div', 'sd-body');
    body.append(
      statusSection,

      section('Course choices', facts(
        fact('First choice', a.course1),
        fact('First choice department', a.dept1),
        fact('Second choice', a.course2),
        fact('Second choice department', a.dept2))),

      section('Personal details', facts(
        fact('Date of birth', fmtDate(a.date_of_birth)), fact('Gender', a.gender), fact('Marital status', a.marital_status),
        fact('Religion', a.religion), fact('Ethnicity', a.ethnicity), fact('Has a disability', yesNo(a.has_disability)))),

      section('Contact', facts(
        fact('Email', a.email), fact('Cell phone', a.cell_phone), fact('Landline', a.landline),
        fact('Office phone', a.office_phone), fact('Address', a.address), fact('Region', a.region))),

      section('Emergency contact', facts(
        fact('Name', [a.ec_first_name, a.ec_other_name, a.ec_last_name].filter(Boolean).join(' ')),
        fact('Relationship', a.ec_relationship), fact('Contact number', a.ec_contact_number),
        fact('Address', a.ec_address), fact('Region', a.ec_region))),

      section('Education',
        facts(fact('Completed secondary school', yesNo(a.completed_secondary))),
        el('h4', 'sd-subtitle', 'Secondary qualifications (CSEC / CAPE)'),
        (a.secondary_qualifications && a.secondary_qualifications.length)
          ? table(['Exam', 'Subject', 'Grade'], a.secondary_qualifications.map((q) => [q.exam, q.subject, gradeLabel(q.grade)]))
          : el('p', 'sd-note', 'None listed.'),
        el('h4', 'sd-subtitle', 'Other qualifications'),
        (a.other_qualifications && a.other_qualifications.length)
          ? table(['Subject', 'Grade'], a.other_qualifications.map((q) => [q.subject, gradeLabel(q.grade)]))
          : el('p', 'sd-note', 'None listed.')),

      section('Documents',
        docRow('CSEC / CAPE certificate', a.csec_cape_cert_path),
        docRow('Birth certificate', a.birth_cert_path),
        docRow('Academic certificate', a.academic_cert_path)));

    const modal = el('div', 'modal modal-student');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Application ' + (a.reference || ''));
    modal.append(header, body);

    const prevScroll = modalEl.querySelector('.sd-body') ? modalEl.querySelector('.sd-body').scrollTop : 0;
    modalEl.replaceChildren(modal);
    body.scrollTop = prevScroll;
  }

  /* ---------------- public entry point ---------------- */

  async function init(root) {
    rootEl = root;
    if (!root) return;
    await showWorkspace();
  }

  window.ApplicationsManager = { init };
})();