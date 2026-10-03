(function () {
  const signOutButton = document.getElementById('signOutButton');
  let currentTimetableCourse = null;
  let currentAdminUserId = null;

  function populateCourseSelects() {
    const timetableSelect = document.getElementById('timetableCourseSelect');
    const announcementSelect = document.getElementById('announcementCourse');

    function fill(sel, groups) {
      sel.innerHTML = '';
      groups.forEach((group) => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.label;
        group.options.forEach((opt) => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          optgroup.appendChild(option);
        });
        sel.appendChild(optgroup);
      });
    }

    // Staff isn't a real course with a schedule — don't offer it as a
    // timetable target, even though it's a valid course to assign a
    // staff account to, or to post a course-scoped announcement for.
    fill(timetableSelect, COURSES.filter((g) => g.label !== 'Staff'));
    fill(announcementSelect, COURSES);

    enhanceCourseSelect(timetableSelect);
    enhanceCourseSelect(announcementSelect);
  }

  // Resources are uploaded per department rather than per specific
  // course — see departmentFor()/DEPARTMENTS and populateDepartmentSelects()
  // below, and the matching comment in lecturer-home.js.
  function departmentFor(code) {
    for (const group of COURSES) {
      if (group.options.some((o) => o.value === code)) return group.label;
    }
    return code;
  }

  const DEPARTMENTS = COURSES.filter((g) => g.label !== 'Staff').map((g) => g.label);

  function populateDepartmentSelects() {
    const resourceFilterSelect = document.getElementById('resourceCourseFilter');
    const resourceCourseSelect = document.getElementById('resourceCourse');
    [resourceFilterSelect, resourceCourseSelect].forEach((select) => {
      const keepFirst = select.querySelector('option'); // preserve "All departments" / "-- Select --" placeholder
      select.innerHTML = '';
      if (keepFirst) select.appendChild(keepFirst);
      DEPARTMENTS.forEach((dept) => {
        const option = document.createElement('option');
        option.value = dept;
        option.textContent = dept;
        select.appendChild(option);
      });
    });
  }

  function courseNameFor(code) {
    for (const group of COURSES) {
      const found = group.options.find((o) => o.value === code);
      if (found) return found.label;
    }
    return code;
  }

  // Prefixes a ✓ onto the course options that already have a timetable
  // uploaded, so it's visible at a glance before you even pick one.
  async function markUploadedTimetableCourses() {
    const sel = document.getElementById('timetableCourseSelect');
    if (!sel) return;
    const { data, error } = await supabaseClient.from('timetable').select('course_code');
    if (error) { console.error('Could not load uploaded-timetable list:', error); return; }
    const uploaded = new Set((data || []).map((r) => r.course_code));
    sel.querySelectorAll('option').forEach((opt) => {
      const label = opt.textContent.replace(/^✓ /, '');
      opt.textContent = uploaded.has(opt.value) ? `✓ ${label}` : label;
    });
    syncCourseSelectDisplay(sel); // the ✓ above may have just changed the currently-selected option's text
  }

  async function init() {
    const admin = await requireAdmin();
    if (!admin) return;

    // requireAdmin() only confirms staff/admin/root access (it's the
    // same gate lecturer-home.html uses) — it does not by itself
    // restrict this page to root. Enforce that here: anyone without
    // root/super admin is bounced back to the staff dashboard, same
    // pattern as requireAdmin()'s own redirects. This is still a
    // UX-layer gate, same as the rest of this page — see the note in
    // the Overview tab; the real enforcement has to live in the
    // database's row-level security policies, not here.
    if (!admin.isSuperAdmin) {
      window.location.href = 'lecturer-home.html';
      return;
    }

    currentAdminUserId = admin.session.user.id;

    populateCourseSelects();
    populateDepartmentSelects();

    document.getElementById('headerEmail').textContent = admin.session.user.email || '';
    renderAvatar(document.getElementById('avatarSlot'), admin.profile.full_name || admin.session.user.email, admin.profile.avatar_url);

    const firstName = ((admin.profile.full_name || '').trim().split(/\s+/)[0]) || '';
    document.getElementById('heroGreeting').textContent = 'Welcome back' + (firstName ? ', ' + firstName : '');
    document.getElementById('heroSub').textContent = admin.session.user.email || '';
    document.getElementById('heroRoleTag').textContent = 'Root admin';
    const heroAccessTag = document.getElementById('heroAccessTag');
    heroAccessTag.textContent = 'Root access';
    heroAccessTag.classList.add('tag-verified');

    document.getElementById('loadingMessage').hidden = true;
    document.getElementById('appShell').hidden = false;
    signOutButton.hidden = false;

    if (admin.isSuperAdmin) {
      document.getElementById('systemNavItem').hidden = false;
      loadSystemStatus();
    }

    // Emails tab: root reaches this page, so it gets the SMTP card too.
    if (window.EmailManager) EmailManager.init(document.getElementById('emailManagerRoot'), { isSuperAdmin: true });

    loadOverviewStats();
    loadAnnouncements();
    document.getElementById('timetableCourseSelect').addEventListener('change', (e) => loadTimetable(e.target.value));
    loadTimetable(document.getElementById('timetableCourseSelect').value);
    markUploadedTimetableCourses();
    loadStudents();
    document.getElementById('resourceCourseFilter').addEventListener('change', (e) => loadResources(e.target.value));
    document.getElementById('resourceSearch').addEventListener('input', renderResourcesList);
    loadResources('');
  }

  const ICONS = {
    bell: '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" aria-hidden="true"><path d="M9 3C7.1 3 5.6 4.6 5.6 6.5V9.3L4.2 11.4H13.8L12.4 9.3V6.5C12.4 4.6 10.9 3 9 3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7.4 13.4C7.4 14.3 8.1 15 9 15C9.9 15 10.6 14.3 10.6 13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    resource: '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" aria-hidden="true"><path d="M3.5 3.5H10.5C11.6 3.5 12.5 4.4 12.5 5.5V14.5H5.5C4.4 14.5 3.5 13.6 3.5 12.5V3.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M12.5 5.5H13.5C13.5 5.5 14.5 5.5 14.5 6.5V13.5C14.5 13.5 14.5 14.5 13.5 14.5H5.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 6.5H10M6 9H10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    person: '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" aria-hidden="true"><circle cx="9" cy="6.5" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 15C4 12 6.3 10.5 9 10.5C11.7 10.5 14 12 14.5 15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    empty: '<svg viewBox="0 0 32 32" width="28" height="28" fill="none" aria-hidden="true"><rect x="6" y="8" width="20" height="17" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M6 14H26M11 4V8M21 4V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  function recordIcon(name) {
    const span = document.createElement('span');
    span.className = 'record-icon';
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  function emptyState(message) {
    return '<li class="empty-state">' + ICONS.empty + '<span>' + message + '</span></li>';
  }

  /* ---------------- Overview ---------------- */
  async function loadOverviewStats() {
    const [{ count: studentCount }, { count: announcementCount }, { count: timetableCount }, { count: resourceCount }, { count: unverifiedCount }, { count: inactiveCount }] = await Promise.all([
      supabaseClient.from('profiles').select('*', { count: 'exact', head: true }),
      supabaseClient.from('announcements').select('*', { count: 'exact', head: true }),
      supabaseClient.from('timetable').select('*', { count: 'exact', head: true }),
      supabaseClient.from('resources').select('*', { count: 'exact', head: true }),
      supabaseClient.from('profiles').select('*', { count: 'exact', head: true }).eq('verified', false),
      supabaseClient.from('profiles').select('*', { count: 'exact', head: true }).not('deactivated_at', 'is', null),
    ]);
    document.getElementById('statStudents').textContent = studentCount ?? '–';
    document.getElementById('statAnnouncements').textContent = announcementCount ?? '–';
    document.getElementById('statTimetable').textContent = timetableCount ?? '–';
    document.getElementById('statResources').textContent = resourceCount ?? '–';
    document.getElementById('statUnverified').textContent = unverifiedCount ?? '–';
    document.getElementById('statInactive').textContent = inactiveCount ?? '–';
  }

  /* ---------------- System (root only) ---------------- */
  let currentLockdownEnabled = false;

  async function loadSystemStatus() {
    let data;
    try { data = await getSystemStatus(); } catch { return; }
    if (!data) return;

    document.getElementById('bannerStyle').value = data.banner_style || 'warning';
    document.getElementById('bannerMessage').value = data.maintenance_message || '';
    syncBannerPresetToMessage();

    document.getElementById('lockdownStyle').value = data.lockdown_style || 'warning';
    document.getElementById('lockdownMessage').value = data.lockdown_message || '';
    syncLockdownPresetToMessage();
    currentLockdownEnabled = data.lockdown_enabled === true;
    updateLockdownUi();
  }

  function updateLockdownUi() {
    document.getElementById('lockdownState').textContent =
      currentLockdownEnabled ? 'Lockdown is currently ON' : 'Lockdown is currently OFF';
    document.getElementById('lockdownToggleBtn').textContent =
      currentLockdownEnabled ? 'Disable lockdown' : 'Enable lockdown';
  }

  // Keeps a preset dropdown and its free-text message box in sync in both
  // directions: picking a preset fills the textarea (still editable
  // afterwards), and typing anything that no longer matches a preset
  // flips the dropdown back to "Custom message…" rather than silently
  // showing a stale preset name next to hand-edited text. Returns the
  // sync function so the caller can also run it once after loading
  // a saved message from the database.
  function wirePresetSelect(selectId, textareaId) {
    const select = document.getElementById(selectId);
    const box = document.getElementById(textareaId);

    // If either element is missing (e.g. admin.html and admin.js got out of
    // sync), fail soft instead of throwing here and silently aborting every
    // line of script after this — which is what previously made banner
    // publishing (and everything else below this point) stop working.
    if (!select || !box) {
      console.warn(`wirePresetSelect: #${selectId} or #${textareaId} not found — admin.html may be out of date.`);
      return () => {};
    }

    function syncSelectToMessage() {
      const currentText = box.value;
      const matchingOption = Array.from(select.options).find((opt) => opt.value === currentText);
      select.value = matchingOption ? matchingOption.value : 'custom';
    }

    select.addEventListener('change', () => {
      if (select.value === 'custom') {
        box.focus();
        return;
      }
      box.value = select.value;
    });

    box.addEventListener('input', syncSelectToMessage);

    return syncSelectToMessage;
  }

  const syncLockdownPresetToMessage = wirePresetSelect('lockdownPreset', 'lockdownMessage');
  const syncBannerPresetToMessage = wirePresetSelect('bannerPreset', 'bannerMessage');

  document.getElementById('bannerPublishBtn').addEventListener('click', async () => {
    const status = document.getElementById('bannerStatus');
    const btn = document.getElementById('bannerPublishBtn');
    const style = document.getElementById('bannerStyle').value;
    const message = document.getElementById('bannerMessage').value.trim();

    if (!message) { setStatus(status, 'Enter a message before publishing.', 'error'); return; }
    if (!(await confirmAction({ title: 'Publish this banner?', text: 'It will show on every page, for students and staff, until you clear it.', confirmText: 'Publish banner', danger: false }))) return;

    btn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient
      .from('system_status')
      .update({ maintenance_mode: true, maintenance_message: message, banner_style: style })
      .eq('id', 1);

    btn.disabled = false;

    if (error) { console.error('Publishing banner failed:', error); setStatus(status, 'Could not publish the banner. Please try again.', 'error'); return; }

    invalidateCache('system_status');
    // Re-render right away instead of waiting on Realtime (or the 30s
    // safety poll) to echo this write back to us — the admin who just
    // published shouldn't need to reload, or sit around, to see their
    // own banner. Other tabs/users still pick it up via Realtime as
    // before; this only fixes it for the tab that made the change.
    refreshSystemStatusOnce();
    setStatus(status, 'Banner is now live for everyone.', 'success');
    toast('Site-wide banner published.', 'success');
  });

  document.getElementById('bannerClearBtn').addEventListener('click', async () => {
    const status = document.getElementById('bannerStatus');
    const btn = document.getElementById('bannerClearBtn');

    if (!(await confirmAction({ title: 'Clear the site-wide banner?', text: 'It will disappear for everyone straight away.', confirmText: 'Clear banner' }))) return;
    btn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient
      .from('system_status')
      .update({ maintenance_mode: false })
      .eq('id', 1);

    btn.disabled = false;

    if (error) { console.error('Clearing banner failed:', error); setStatus(status, 'Could not clear the banner. Please try again.', 'error'); return; }

    invalidateCache('system_status');
    refreshSystemStatusOnce(); // see note above — don't wait on Realtime for our own tab
    setStatus(status, 'Banner cleared.', 'success');
    toast('Site-wide banner cleared.', 'success');
  });

  document.getElementById('lockdownToggleBtn').addEventListener('click', async () => {
    const status = document.getElementById('lockdownStatus');
    const btn = document.getElementById('lockdownToggleBtn');
    const nextValue = !currentLockdownEnabled;
    const message = document.getElementById('lockdownMessage').value.trim() || null;
    const style = document.getElementById('lockdownStyle').value;

    if (nextValue && !(await confirmAction({ title: 'Enable lockdown?', text: 'This immediately blocks sign-in for everyone except admins, and signs out anyone else currently signed in.', confirmText: 'Enable lockdown' }))) return;
    if (!nextValue && !(await confirmAction({ title: 'Turn off lockdown?', text: 'Everyone will be able to sign in again straight away.', confirmText: 'Turn off lockdown', danger: false }))) return;

    btn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient
      .from('system_status')
      .update({ lockdown_enabled: nextValue, lockdown_message: message, lockdown_style: style })
      .eq('id', 1);

    btn.disabled = false;

    if (error) { console.error('Updating lockdown mode failed:', error); setStatus(status, 'Could not update lockdown mode. Please try again.', 'error'); return; }

    invalidateCache('system_status');
    refreshSystemStatusOnce(); // see note above — don't wait on Realtime for our own tab
    currentLockdownEnabled = nextValue;
    updateLockdownUi();
    setStatus(status, nextValue ? 'Lockdown enabled.' : 'Lockdown disabled.', 'success');
    toast(nextValue ? 'Lockdown mode enabled.' : 'Lockdown mode disabled.', 'success');
  });

  /* ---------------- Announcements ---------------- */
  const announcementModal = document.getElementById('announcementModal');
  const announcementForm = document.getElementById('announcementForm');
  const announcementAudience = document.getElementById('announcementAudience');
  const announcementCourseWrap = document.getElementById('announcementCourseWrap');

  function toggleAnnouncementCourseField() {
    announcementCourseWrap.style.display = announcementAudience.value === 'course' ? 'block' : 'none';
  }
  announcementAudience.addEventListener('change', toggleAnnouncementCourseField);

  function openAnnouncementModal(existing) {
    announcementForm.reset();
    document.getElementById('announcementId').value = existing ? existing.id : '';
    document.getElementById('announcementModalTitle').textContent = existing ? 'Edit announcement' : 'New announcement';
    if (existing) {
      announcementAudience.value = existing.audience;
      document.getElementById('announcementCourse').value = existing.course_code || '';
      document.getElementById('announcementTitle').value = existing.title;
      document.getElementById('announcementMessage').value = existing.message;
    }
    toggleAnnouncementCourseField();
    setStatus(document.getElementById('announcementStatus'), '', null);
    announcementModal.hidden = false;
  }
  document.getElementById('newAnnouncementBtn').addEventListener('click', () => openAnnouncementModal(null));
  document.getElementById('announcementModalClose').addEventListener('click', () => announcementModal.hidden = true);

  announcementForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('announcementStatus');
    const submitBtn = document.getElementById('announcementSubmit');
    const id = document.getElementById('announcementId').value;
    const audience = announcementAudience.value;
    const courseCode = audience === 'course' ? document.getElementById('announcementCourse').value : null;
    const title = document.getElementById('announcementTitle').value.trim();
    const message = document.getElementById('announcementMessage').value.trim();

    if (audience === 'course' && !courseCode) {
      setStatus(status, 'Choose a course for a course-specific announcement.', 'error');
      return;
    }

    // Only one global ("everyone") announcement may exist at a time. If one
    // is already live, warn and offer to delete it before publishing this
    // one — declining leaves the existing one untouched and posts nothing.
    if (audience === 'everyone') {
      let existingQuery = supabaseClient.from('announcements').select('id').eq('audience', 'everyone');
      if (id) existingQuery = existingQuery.neq('id', id);
      const { data: existingGlobal, error: checkError } = await existingQuery;

      if (checkError) {
        setStatus(status, 'Could not verify existing global announcements. Please try again.', 'error');
        return;
      }

      if (existingGlobal && existingGlobal.length) {
        const proceed = await confirmAction({ title: 'Replace the live global announcement?', text: 'There is already a global announcement live. Delete it and publish this one instead?', confirmText: 'Delete it and publish' });
        if (!proceed) {
          setStatus(status, 'Your announcement will not be posted.', 'error');
          return;
        }
        const { error: delError } = await supabaseClient
          .from('announcements')
          .delete()
          .in('id', existingGlobal.map((r) => r.id));
        if (delError) {
          setStatus(status, 'Could not remove the existing global announcement. Please try again.', 'error');
          return;
        }
      }
    }

    submitBtn.disabled = true;
    const payload = { audience, course_code: courseCode, title, message };
    if (!id) payload.created_by = currentAdminUserId;

    const { data, error } = id
      ? await supabaseClient.from('announcements').update(payload).eq('id', id).select().single()
      : await supabaseClient.from('announcements').insert(payload).select().single();

    submitBtn.disabled = false;

    if (error) { setStatus(status, 'Could not save announcement. Please try again.', 'error'); return; }

    announcementModal.hidden = true;
    toast(id ? 'Announcement updated.' : 'Announcement published.', 'success');
    loadAnnouncements();
    loadOverviewStats();
  });

  async function loadAnnouncements() {
    const list = document.getElementById('adminAnnouncementsList');
    const { data, error } = await supabaseClient
      .from('announcements')
      .select('id, title, message, audience, course_code, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    list.innerHTML = '';
    if (error) { console.error('Loading announcements failed:', error); list.innerHTML = '<li class="empty-state">Could not load announcements.</li>'; return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No announcements yet.'); return; }

    const ACCENT_FOR_AUDIENCE = { everyone: 'accent-danger', all_students: 'accent-brass', staff: 'accent-ink' };

    rows.forEach((a) => {
      const item = document.createElement('li');
      item.className = 'record' + (ACCENT_FOR_AUDIENCE[a.audience] ? ' ' + ACCENT_FOR_AUDIENCE[a.audience] : '');

      const title = document.createElement('div');
      title.className = 'record-title';
      title.textContent = a.title;

      const meta = document.createElement('div');
      meta.className = 'record-meta';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (
        a.audience === 'everyone' ? 'badge-everyone' :
        a.audience === 'all_students' ? 'badge-all' :
        a.audience === 'staff' ? 'badge-staff' : 'badge-course'
      );
      badge.textContent =
        a.audience === 'everyone' ? 'Everyone' :
        a.audience === 'all_students' ? 'All students' :
        a.audience === 'staff' ? 'Staff only' : courseNameFor(a.course_code);
      const dateSpan = document.createElement('span');
      dateSpan.textContent = new Date(a.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      meta.append(badge, dateSpan);

      const body = document.createElement('div');
      body.className = 'record-body';
      body.textContent = a.message;

      const actions = document.createElement('div');
      actions.className = 'record-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openAnnouncementModal(a));
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger btn-sm';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!(await confirmAction({ title: 'Delete this announcement?', text: 'It will disappear for everyone who can see it. This can\'t be undone.', confirmText: 'Delete' }))) return;
        const { error: delError } = await supabaseClient.from('announcements').delete().eq('id', a.id);
        if (delError) { toast('Could not delete announcement.', 'error'); return; }
        toast('Announcement deleted.', 'success');
        loadAnnouncements();
        loadOverviewStats();
      });
      actions.append(editBtn, deleteBtn);

      const head = document.createElement('div');
      head.className = 'record-head';
      const headMain = document.createElement('div');
      headMain.className = 'record-head-main';
      const headText = document.createElement('div');
      headText.className = 'record-head-text';
      headText.append(title, meta);
      headMain.append(recordIcon('bell'), headText);
      head.appendChild(headMain);

      item.append(head, body, actions);
      list.appendChild(item);
    });
  }

  /* ---------------- Timetable ---------------- */
  const timetableModal = document.getElementById('timetableModal');
  const timetableForm = document.getElementById('timetableForm');

  // Holds the current draft of the extracted/edited table (array of
  // arrays of strings) for the entry currently open in the modal, plus
  // the editor widget instance so the export/save handlers can pull the
  // latest cells out of it. Both are reset every time the modal opens.
  let timetableEditorHandle = null;
  let currentTimetableTableData = null;

  function timetableEntryTitle() {
    return document.getElementById('timetableFileName').value.trim() || courseNameFor(currentTimetableCourse);
  }

  // JSON of the table as it was when the editor opened — used at save time to
  // tell whether the words were actually changed.
  let timetableBaselineJson = null;

  // `extra` (optional, from the OCR step): { flags, previewUrl } — which cells
  // the reader was unsure about (highlighted until edited) and a picture of
  // the original to compare against.
  function showTimetableEditor(rows, extra) {
    currentTimetableTableData = TimetableEditor.normalizeRows(rows);
    timetableBaselineJson = JSON.stringify(currentTimetableTableData);
    document.getElementById('timetableEditorSection').hidden = false;
    timetableEditorHandle = TimetableEditor.renderTimetableEditor(
      document.getElementById('timetableEditorContainer'),
      currentTimetableTableData,
      {
        onChange: (rows) => { currentTimetableTableData = rows; },
        flags: extra && extra.flags,
        previewUrl: extra && extra.previewUrl,
      }
    );
  }

  function hideTimetableEditor() {
    currentTimetableTableData = null;
    timetableEditorHandle = null;
    document.getElementById('timetableEditorSection').hidden = true;
    document.getElementById('timetableEditorContainer').innerHTML = '';
    document.getElementById('timetableDisplayModeImage').checked = true;
  }

  function openTimetableModal(existing) {
    timetableForm.reset();
    document.getElementById('timetableEntryId').value = existing ? existing.id : '';
    document.getElementById('timetableModalTitle').textContent = existing ? 'Edit entry' : 'New timetable entry';
    document.getElementById('timetableOcrBtn').hidden = true;
    document.getElementById('timetableOcrProgress').textContent = '';
    hideTimetableEditor();
    if (existing) {
      document.getElementById('timetableFileUrl').value = existing.file_url || '';
      document.getElementById('timetableFileName').value = existing.file_name || '';
      // Previously-extracted/edited table, if any — let staff keep
      // refining it without having to re-run OCR from scratch.
      if (existing.table_data && existing.table_data.length) {
        showTimetableEditor(existing.table_data);
        document.getElementById(existing.display_mode === 'table' ? 'timetableDisplayModeTable' : 'timetableDisplayModeImage').checked = true;
      }
    } else {
      document.getElementById('timetableFileName').value = courseNameFor(currentTimetableCourse);
    }
    setStatus(document.getElementById('timetableFormStatus'), '', null);
    updateReconvertVisibility();
    timetableModal.hidden = false;
  }
  document.getElementById('newTimetableEntryBtn').addEventListener('click', () => openTimetableModal(null));
  document.getElementById('timetableModalClose').addEventListener('click', () => timetableModal.hidden = true);

  // Show the "Extract table" button as soon as a usable file is chosen —
  // OCR runs against the file the person just picked, before it's
  // uploaded anywhere, so there's nothing to wait on here.
  document.getElementById('timetableFileUpload').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    const ocrBtn = document.getElementById('timetableOcrBtn');
    ocrBtn.hidden = !file;
    document.getElementById('timetableOcrProgress').textContent = '';
  });

  // Reads a picture/PDF into the editor. Used by "Extract table from file" (a newly chosen
  // file) and "Reconvert from original" (the file already saved for this entry).
  async function runTimetableOcr(file, keepExistingOnError) {
    const ocrBtn = document.getElementById('timetableOcrBtn');
    const reconvertBtn = document.getElementById('timetableReconvertBtn');
    const progress = document.getElementById('timetableOcrProgress');

    // Never silently throw away edits.
    if (timetableEditorHandle
        && JSON.stringify(timetableEditorHandle.getRows()) !== timetableBaselineJson
        && !(await confirmAction({ title: 'Replace your edits?', text: 'This replaces the table below with a fresh reading of the picture, and your edits to it will be lost.', confirmText: 'Replace table' }))) {
      return;
    }

    ocrBtn.disabled = true;
    reconvertBtn.disabled = true;
    progress.textContent = 'Loading OCR engine…';
    try {
      const { rows, flags, previewUrl, flagCount, mode } = await TimetableEditor.ocrExtractTable(file, {
        onProgress: (pct, text) => { progress.textContent = `${text || 'Reading table…'} (${pct}%)`; },
      });
      showTimetableEditor(rows, { flags, previewUrl });
      // The point of extracting the table is for students to see it, so show
      // "Converted table" by default (it can still be switched back below).
      document.getElementById('timetableDisplayModeTable').checked = true;
      if (mode === 'fallback') {
        progress.textContent = 'No table lines were found in that picture, so this is a rougher reading — please check every cell against the original.';
      } else if (flagCount > 0) {
        progress.textContent = `Extracted — ${flagCount} highlighted cell${flagCount === 1 ? '' : 's'} need a quick check against the original. Click a cell to fix it.`;
      } else {
        progress.textContent = 'Extracted — nothing was flagged, but still give it a quick look against the original picture.';
      }
    } catch (err) {
      console.error('Timetable OCR failed:', err);
      if (keepExistingOnError) {
        progress.textContent = 'Could not read that file automatically — your current table has been kept.';
      } else {
        progress.textContent = 'Could not read that file automatically. You can still type the table in by hand below.';
        showTimetableEditor([['', '', ''], ['', '', '']]);
      }
    } finally {
      ocrBtn.disabled = false;
      reconvertBtn.disabled = false;
    }
  }

  document.getElementById('timetableOcrBtn').addEventListener('click', () => {
    const file = document.getElementById('timetableFileUpload').files[0];
    if (file) runTimetableOcr(file, false);
  });

  // "Reconvert from original": run the reader again on the picture/PDF already saved
  // for this entry (its link), without having to upload it again.
  function updateReconvertVisibility() {
    document.getElementById('timetableReconvertBtn').hidden = !document.getElementById('timetableFileUrl').value.trim();
  }
  document.getElementById('timetableFileUrl').addEventListener('input', updateReconvertVisibility);

  document.getElementById('timetableReconvertBtn').addEventListener('click', async () => {
    const progress = document.getElementById('timetableOcrProgress');
    const url = document.getElementById('timetableFileUrl').value.trim();
    if (!url) return;
    let file;
    progress.textContent = 'Downloading the original…';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'timetable');
      const type = blob.type && blob.type !== 'application/octet-stream'
        ? blob.type
        : (/\.pdf$/i.test(name) ? 'application/pdf' : 'image/jpeg');
      file = new File([blob], name, { type });
    } catch (err) {
      console.error('Could not download the original timetable file:', err);
      progress.textContent = 'Could not download the original to reconvert it (it may be an external link). Upload the file again with "Or upload a picture/PDF", then use "Extract table from file".';
      return;
    }
    runTimetableOcr(file, true);
  });

  document.getElementById('timetableExportPdfBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!timetableEditorHandle) return;
    btn.disabled = true;
    try {
      await TimetableEditor.exportTimetablePdf(timetableEditorHandle.getRows(), timetableEntryTitle());
    } catch (err) {
      console.error('PDF export failed:', err);
      toast('Could not create the PDF.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('timetableExportDocxBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!timetableEditorHandle) return;
    btn.disabled = true;
    try {
      await TimetableEditor.exportTimetableDocx(timetableEditorHandle.getRows(), timetableEntryTitle());
    } catch (err) {
      console.error('Word export failed:', err);
      toast('Could not create the Word document.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  timetableForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('timetableFormStatus');
    const submitBtn = document.getElementById('timetableSubmit');

    let fileUrl = document.getElementById('timetableFileUrl').value.trim() || null;
    let fileName = document.getElementById('timetableFileName').value.trim() || courseNameFor(currentTimetableCourse);

    const uploadInput = document.getElementById('timetableFileUpload');
    const uploadStatus = document.getElementById('timetableUploadStatus');
    const chosenFile = uploadInput.files && uploadInput.files[0];

    if (!fileUrl && !chosenFile) {
      setStatus(status, 'Provide a link or upload a file.', 'error');
      return;
    }

    // Students only see the edited words when the entry is set to show the
    // converted table. If the table was changed but the entry still shows the
    // original picture, the save would look like it did nothing — so ask.
    if (timetableEditorHandle
        && document.getElementById('timetableDisplayModeImage').checked
        && JSON.stringify(timetableEditorHandle.getRows()) !== timetableBaselineJson) {
      if (await confirmAction({ title: 'Show the converted table instead?', text: 'You changed the table, but this timetable is set to show students the original image/PDF, so they would not see your changes.', confirmText: 'Show converted table', cancelText: 'Keep original image', danger: false })) {
        document.getElementById('timetableDisplayModeTable').checked = true;
      }
    }

    submitBtn.disabled = true;

    if (chosenFile) {
      uploadStatus.textContent = 'Uploading…';
      const path = `${currentTimetableCourse}/${Date.now()}-${chosenFile.name}`;
      const { error: uploadError } = await supabaseClient.storage
        .from('timetable-files')
        .upload(path, chosenFile, { upsert: false });

      if (uploadError) {
        console.error('Timetable file upload failed:', uploadError);
        uploadStatus.textContent = '';
        submitBtn.disabled = false;
        setStatus(status, 'Could not upload the file.', 'error');
        return;
      }

      const { data: publicUrlData } = supabaseClient.storage.from('timetable-files').getPublicUrl(path);
      fileUrl = publicUrlData.publicUrl;
      uploadStatus.textContent = 'Uploaded.';
    }

    // Pull the latest cells straight from the editor widget (rather than
    // trusting the last onChange event) so an edit still focused/mid-blur
    // at submit time is never lost.
    const tableData = timetableEditorHandle ? timetableEditorHandle.getRows() : null;
    const displayMode = document.getElementById('timetableDisplayModeTable').checked ? 'table' : 'image';

    const payload = {
      course_code: currentTimetableCourse,
      file_url: fileUrl,
      file_name: fileName,
      table_data: tableData,
      display_mode: tableData ? displayMode : 'image',
    };

    // One row per course — upsert on course_code so re-saving an
    // existing course replaces its timetable instead of erroring on
    // the unique constraint.
    const { data, error } = await supabaseClient
      .from('timetable')
      .upsert(payload, { onConflict: 'course_code' })
      .select()
      .single();
    submitBtn.disabled = false;

    if (error) { setStatus(status, 'Could not save entry. Please try again.', 'error'); console.error('Saving timetable entry failed:', error); return; }

    // Make sure the stored row really holds what was sent — otherwise this page
    // could say "saved" while the old data is still what the database has.
    if (JSON.stringify(data.table_data) !== JSON.stringify(payload.table_data) || data.display_mode !== payload.display_mode) {
      console.error('Timetable save mismatch', { sent: payload, stored: data });
      setStatus(status, 'The save went through, but the stored timetable does not match what you entered. Please try again — and tell an admin if it keeps happening.', 'error');
      return;
    }

    uploadInput.value = '';
    uploadStatus.textContent = '';
    hideTimetableEditor();
    timetableModal.hidden = true;
    toast(payload.display_mode === 'table'
      ? 'Timetable saved — students will see the converted table.'
      : 'Timetable saved — students will see the original image/PDF.', 'success');
    loadTimetable(currentTimetableCourse);
    loadOverviewStats();
    markUploadedTimetableCourses();
  });

  async function loadTimetable(courseCode) {
    currentTimetableCourse = courseCode;
    const tbody = document.getElementById('timetableTableBody');
    tbody.innerHTML = '<tr><td colspan="4"><div class="skeleton skeleton-line"></div></td></tr>';

    const { data, error } = await supabaseClient
      .from('timetable')
      .select('id, course_code, file_name, file_url, updated_at, table_data, display_mode')
      .eq('course_code', courseCode)
      .maybeSingle();

    tbody.innerHTML = '';
    if (error) { console.error('Loading timetable failed:', error); tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Could not load timetable.</td></tr>'; return; }
    if (!data) { tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No timetable uploaded for this course yet.</td></tr>'; return; }

    const entry = data;
    const tr = document.createElement('tr');

    const courseTd = document.createElement('td');
    courseTd.textContent = entry.course_code;
    tr.appendChild(courseTd);

    const fileTd = document.createElement('td');
    // The converted table itself — opens in its own tab so staff can see exactly
    // what students will see (not just a link to the original picture/PDF).
    const hasTableData = entry.table_data && entry.table_data.length;
    if (hasTableData) {
      const viewTable = document.createElement('a');
      viewTable.href = '#';
      viewTable.className = 'file-link';
      viewTable.textContent = 'View table ↗';
      viewTable.style.marginRight = '12px';
      viewTable.addEventListener('click', (e) => {
        e.preventDefault();
        TimetableEditor.openTimetablePopup(entry.table_data, entry.file_name || 'Timetable', 'view');
      });
      fileTd.appendChild(viewTable);
    }
    if (entry.file_url) {
      const link = document.createElement('a');
      link.href = entry.file_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'file-link';
      link.textContent = hasTableData ? 'Original file ↗' : (entry.file_name || 'View timetable');
      fileTd.appendChild(link);
    } else {
      fileTd.textContent = '—';
    }
    if (entry.table_data && entry.table_data.length) {
      const modeBadge = document.createElement('span');
      modeBadge.className = 'badge ' + (entry.display_mode === 'table' ? 'badge-verified' : 'badge-course');
      modeBadge.style.marginLeft = '8px';
      modeBadge.textContent = entry.display_mode === 'table' ? 'Showing: Table' : 'Showing: Image';
      fileTd.appendChild(modeBadge);
    }
    tr.appendChild(fileTd);

    const updatedTd = document.createElement('td');
    updatedTd.textContent = entry.updated_at
      ? new Date(entry.updated_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      : '—';
    tr.appendChild(updatedTd);

    const actionsTd = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openTimetableModal(entry));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Remove';
    deleteBtn.style.marginLeft = '8px';
    deleteBtn.addEventListener('click', async () => {
      if (!(await confirmAction({ title: 'Remove this timetable?', text: `The timetable for ${entry.course_code} will be removed for students. This can\'t be undone.`, confirmText: 'Remove' }))) return;
      const { error: delError } = await supabaseClient.from('timetable').delete().eq('id', entry.id);
      if (delError) { toast('Could not remove entry.', 'error'); return; }
      toast('Timetable removed.', 'success');
      loadTimetable(currentTimetableCourse);
      loadOverviewStats();
      markUploadedTimetableCourses();
    });
    actionsTd.append(editBtn, deleteBtn);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  }

  /* ---------------- Resources ---------------- */
  const resourceModal = document.getElementById('resourceModal');
  const resourceForm = document.getElementById('resourceForm');
  let currentResourceFilter = '';

  function openResourceModal(existing) {
    resourceForm.reset();
    document.getElementById('resourceId').value = existing ? existing.id : '';
    document.getElementById('resourceModalTitle').textContent = existing ? 'Edit resource' : 'New resource';
    if (existing) {
      document.getElementById('resourceCourse').value = existing.department;
      document.getElementById('resourceTitle').value = existing.title;
      document.getElementById('resourceAuthor').value = existing.author || '';
      document.getElementById('resourceFileUrl').value = existing.file_url || '';
    } else if (currentResourceFilter) {
      document.getElementById('resourceCourse').value = currentResourceFilter;
    }
    document.getElementById('resourceUploadStatus').textContent = '';
    setStatus(document.getElementById('resourceFormStatus'), '', null);
    resourceModal.hidden = false;
  }
  document.getElementById('newResourceBtn').addEventListener('click', () => openResourceModal(null));
  document.getElementById('resourceModalClose').addEventListener('click', () => resourceModal.hidden = true);

  resourceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('resourceFormStatus');
    const submitBtn = document.getElementById('resourceSubmit');

    const id = document.getElementById('resourceId').value;
    const department = document.getElementById('resourceCourse').value;
    const title = document.getElementById('resourceTitle').value.trim();
    const author = document.getElementById('resourceAuthor').value.trim() || null;
    let fileUrl = document.getElementById('resourceFileUrl').value.trim() || null;

    const uploadInput = document.getElementById('resourceFileUpload');
    const uploadStatus = document.getElementById('resourceUploadStatus');
    const chosenFile = uploadInput.files && uploadInput.files[0];

    if (!department) {
      setStatus(status, 'Choose a department.', 'error');
      return;
    }
    if (!fileUrl && !chosenFile) {
      setStatus(status, 'Provide a link or upload a file.', 'error');
      return;
    }

    submitBtn.disabled = true;

    if (chosenFile) {
      uploadStatus.textContent = 'Uploading…';
      const deptSlug = department.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const path = `${deptSlug}/${Date.now()}-${chosenFile.name}`;
      const { error: uploadError } = await supabaseClient.storage
        .from('resource-files')
        .upload(path, chosenFile, { upsert: false });

      if (uploadError) {
        console.error('Resource file upload failed:', uploadError);
        uploadStatus.textContent = '';
        submitBtn.disabled = false;
        setStatus(status, 'Could not upload the file.', 'error');
        return;
      }

      const { data: publicUrlData } = supabaseClient.storage.from('resource-files').getPublicUrl(path);
      fileUrl = publicUrlData.publicUrl;
      uploadStatus.textContent = 'Uploaded.';
    }

    const payload = {
      department,
      title,
      author,
      file_url: fileUrl,
    };
    if (!id) payload.created_by = currentAdminUserId;

    // Unlike timetable (one row per course), resources are a plain
    // list — several textbooks can exist for the same department, so
    // this is a normal insert/update by id rather than an upsert on
    // department.
    const { error } = id
      ? await supabaseClient.from('resources').update(payload).eq('id', id).select().single()
      : await supabaseClient.from('resources').insert(payload).select().single();

    submitBtn.disabled = false;

    if (error) { setStatus(status, 'Could not save resource. Please try again.', 'error'); console.error('Saving resource failed:', error); return; }

    uploadInput.value = '';
    uploadStatus.textContent = '';
    resourceModal.hidden = true;
    toast('Resource saved.', 'success');
    loadResources(currentResourceFilter);
    loadOverviewStats();
  });

  let currentAllResources = []; // last fetch; the search box filters this client-side

  async function loadResources(department) {
    currentResourceFilter = department || '';
    const list = document.getElementById('resourcesList');
    list.innerHTML = '<li><div class="skeleton skeleton-line"></div></li>';

    let query = supabaseClient
      .from('resources')
      .select('id, department, title, author, file_url, created_at')
      .order('department')
      .order('title');
    if (department) query = query.eq('department', department);

    const { data, error } = await query;

    if (error) { console.error('Loading resources failed:', error); list.innerHTML = emptyState('Could not load resources.'); return; }
    currentAllResources = data || [];
    renderResourcesList();
  }

  function renderResourcesList() {
    const list = document.getElementById('resourcesList');
    const q = document.getElementById('resourceSearch').value.trim().toLowerCase();
    const rows = q
      ? currentAllResources.filter((r) => (r.title || '').toLowerCase().includes(q) || (r.author || '').toLowerCase().includes(q))
      : currentAllResources;

    list.innerHTML = '';
    if (!rows.length) { list.innerHTML = emptyState(currentAllResources.length ? 'No matching resources.' : 'No resources uploaded yet.'); return; }

    rows.forEach((r) => {
      const item = document.createElement('li');
      item.className = 'record';

      const head = document.createElement('div');
      head.className = 'record-head';
      const headMain = document.createElement('div');
      headMain.className = 'record-head-main';
      const headText = document.createElement('div');
      headText.className = 'record-head-text';

      const title = document.createElement('div');
      title.className = 'record-title';
      title.textContent = r.title;

      const meta = document.createElement('div');
      meta.className = 'record-meta';
      const courseBadge = document.createElement('span');
      courseBadge.className = 'badge badge-course';
      courseBadge.textContent = r.department;
      meta.appendChild(courseBadge);
      if (r.author) {
        const authorSpan = document.createElement('span');
        authorSpan.textContent = r.author;
        meta.appendChild(authorSpan);
      }
      if (r.created_at) {
        const dateSpan = document.createElement('span');
        dateSpan.textContent = 'Added ' + new Date(r.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        meta.appendChild(dateSpan);
      }

      headText.append(title, meta);
      headMain.append(recordIcon('resource'), headText);
      head.appendChild(headMain);

      if (r.file_url) {
        const fileLink = document.createElement('a');
        fileLink.className = 'record-action';
        fileLink.href = r.file_url;
        fileLink.target = '_blank';
        fileLink.rel = 'noopener noreferrer';
        fileLink.textContent = 'Open ↗';
        head.appendChild(fileLink);
      }
      item.appendChild(head);

      const actions = document.createElement('div');
      actions.className = 'record-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openResourceModal(r));
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger btn-sm';
      deleteBtn.textContent = 'Remove';
      deleteBtn.addEventListener('click', async () => {
        if (!(await confirmAction({ title: 'Remove this resource?', text: `"${r.title}" will be removed for students. This can\'t be undone.`, confirmText: 'Remove' }))) return;
        const { error: delError } = await supabaseClient.from('resources').delete().eq('id', r.id);
        if (delError) { toast('Could not remove resource.', 'error'); return; }
        toast('Resource removed.', 'success');
        loadResources(currentResourceFilter);
        loadOverviewStats();
      });
      actions.append(editBtn, deleteBtn);
      item.appendChild(actions);

      list.appendChild(item);
    });
  }

  /* ---------------- Students ---------------- */
  let allStudents = [];

  async function loadStudents() {
    const tbody = document.getElementById('studentsTableBody');
    tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton skeleton-line"></div></td></tr>';

    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, full_name, student_id, email, course_code, course_name, verified, is_admin, deactivated_at, is_super_admin')
      .order('full_name')
      .limit(500);

    if (error) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Could not load students.</td></tr>'; return; }
    // Super admin (root) accounts are no longer hidden from this list —
    // an admin needs to see them to grant/revoke root access below. The
    // real gate is set_super_admin() server-side (see SECURITY.md /
    // the super-admin migration): this page just reflects what that
    // RPC will actually allow.
    allStudents = data || [];
    renderStudents(allStudents);
  }

  document.getElementById('studentSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { renderStudents(allStudents); return; }
    renderStudents(allStudents.filter((s) =>
      (s.full_name || '').toLowerCase().includes(q) ||
      (s.email || '').toLowerCase().includes(q) ||
      (s.student_id || '').toLowerCase().includes(q)
    ));
  });

  function renderStudents(students) {
    const tbody = document.getElementById('studentsTableBody');
    tbody.innerHTML = '';
    if (!students.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No matching students.</td></tr>'; return; }

    students.forEach((s) => {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td'); nameTd.textContent = s.full_name || '—'; tr.appendChild(nameTd);
      const idTd = document.createElement('td'); idTd.textContent = s.student_id || '—'; tr.appendChild(idTd);
      const emailTd = document.createElement('td'); emailTd.textContent = s.email || '—'; tr.appendChild(emailTd);

      const courseTd = document.createElement('td');
      const courseSelect = document.createElement('select');
      const blankOpt = document.createElement('option'); blankOpt.value = ''; blankOpt.textContent = '— none —';
      courseSelect.appendChild(blankOpt);
      COURSES.forEach((group) => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.label;
        group.options.forEach((opt) => {
          const option = document.createElement('option');
          option.value = opt.value; option.textContent = opt.label;
          if (opt.value === s.course_code) option.selected = true;
          optgroup.appendChild(option);
        });
        courseSelect.appendChild(optgroup);
      });
      courseSelect.addEventListener('change', async () => {
        const newCode = courseSelect.value;
        const newName = newCode ? courseNameFor(newCode) : null;
        const { error } = await supabaseClient.from('profiles').update({ course_code: newCode || null, course_name: newName }).eq('id', s.id);
        if (error) { toast('Could not update course.', 'error'); return; }
        toast(`Updated ${s.full_name || 'student'}'s course.`, 'success');
      });
      courseTd.appendChild(courseSelect);
      enhanceCourseSelect(courseSelect);
      tr.appendChild(courseTd);

      const statusTd = document.createElement('td');
      if (s.deactivated_at) {
        const remaining = 30 - Math.floor((Date.now() - new Date(s.deactivated_at).getTime()) / (1000 * 60 * 60 * 24));
        const inactiveBadge = document.createElement('span');
        inactiveBadge.className = 'badge badge-inactive';
        inactiveBadge.textContent = remaining > 0 ? `Deletes in ${remaining}d` : 'Deletion pending';
        statusTd.appendChild(inactiveBadge);
      } else {
        const verifiedBadge = document.createElement('button');
        verifiedBadge.className = 'badge ' + (s.verified ? 'badge-verified' : 'badge-unverified');
        verifiedBadge.style.cursor = 'pointer';
        verifiedBadge.style.border = 'none';
        verifiedBadge.textContent = s.verified ? 'Verified' : 'Pending';
        verifiedBadge.title = 'Click to toggle';
        verifiedBadge.addEventListener('click', async () => {
          const markVerified = !s.verified;
          if (!(await confirmAction({ title: markVerified ? 'Mark as verified?' : 'Mark as pending?', text: `${s.full_name || 'This student'} will be marked ${markVerified ? 'Verified' : 'Pending'}.`, confirmText: markVerified ? 'Mark verified' : 'Mark pending', danger: !markVerified }))) return;
          const { error } = await supabaseClient.from('profiles').update({ verified: !s.verified }).eq('id', s.id);
          if (error) { toast('Could not update verification status.', 'error'); return; }
          s.verified = !s.verified;
          renderStudents(allStudents);
        });
        statusTd.appendChild(verifiedBadge);
      }
      tr.appendChild(statusTd);

      const roleTd = document.createElement('td');
      const roleBadge = document.createElement('button');
      roleBadge.className = 'badge ' + (s.is_admin ? 'badge-admin' : 'badge-unverified');
      roleBadge.style.cursor = 'pointer';
      roleBadge.style.border = 'none';
      roleBadge.textContent = s.is_admin ? 'Admin' : 'Student';
      roleBadge.title = 'Click to toggle';
      roleBadge.addEventListener('click', async () => {
        const makeAdmin = !s.is_admin;
        if (!(await confirmAction({ title: makeAdmin ? 'Make this user an admin?' : 'Remove admin access?', text: makeAdmin ? `${s.full_name || 'This user'} will be able to manage the portal.` : `${s.full_name || 'This user'} will lose admin access.`, confirmText: makeAdmin ? 'Make admin' : 'Remove admin access', danger: !makeAdmin }))) return;
        const { error } = await supabaseClient.from('profiles').update({ is_admin: makeAdmin }).eq('id', s.id);
        if (error) { toast('Could not update role.', 'error'); return; }
        s.is_admin = makeAdmin;
        renderStudents(allStudents);
      });
      roleTd.appendChild(roleBadge);
      tr.appendChild(roleTd);

      const rootTd = document.createElement('td');
      const isSelf = s.id === currentAdminUserId;
      const rootBadge = document.createElement('button');
      rootBadge.className = 'badge ' + (s.is_super_admin ? 'badge-admin' : 'badge-unverified');
      rootBadge.style.cursor = isSelf ? 'default' : 'pointer';
      rootBadge.style.border = 'none';
      rootBadge.textContent = s.is_super_admin ? 'Root' : '—';
      rootBadge.disabled = isSelf;
      rootBadge.title = isSelf
        ? "You can't change your own root status."
        : (s.is_super_admin ? 'Click to revoke root access' : 'Click to grant root access');
      rootBadge.addEventListener('click', async () => {
        if (isSelf) return;
        const grant = !s.is_super_admin;
        const label = grant ? 'Grant ROOT (super admin) access to' : 'Revoke root access from';
        if (!(await confirmAction({ title: grant ? 'Grant root access?' : 'Revoke root access?', text: `${label} ${s.full_name || 'this user'}? This is temporary while root grants go through admins — treat it carefully.`, confirmText: grant ? 'Grant root' : 'Revoke root' }))) return;
        const { error } = await supabaseClient.rpc('set_super_admin', { p_user_id: s.id, p_value: grant });
        if (error) { toast(error.message || 'Could not update root access.', 'error'); return; }
        s.is_super_admin = grant;
        toast(grant ? `Granted root access to ${s.full_name || 'user'}.` : `Revoked root access from ${s.full_name || 'user'}.`, 'success');
        renderStudents(allStudents);
      });
      rootTd.appendChild(rootBadge);
      tr.appendChild(rootTd);

      const actionsTd = document.createElement('td');
      if (s.deactivated_at) {
        const reactivateBtn = document.createElement('button');
        reactivateBtn.className = 'btn btn-secondary btn-sm';
        reactivateBtn.textContent = 'Reactivate';
        reactivateBtn.addEventListener('click', async () => {
          reactivateBtn.disabled = true;
          const { error } = await supabaseClient.rpc('reactivate_account', { p_user_id: s.id });
          if (error) { toast('Could not reactivate this account.', 'error'); reactivateBtn.disabled = false; return; }
          s.deactivated_at = null;
          toast(`Reactivated ${s.full_name || 'account'}.`, 'success');
          renderStudents(allStudents);
        });
        actionsTd.appendChild(reactivateBtn);
      } else if (!isSelf) {
        // Puts the account into the same 30-day pending-deletion state
        // it would reach on its own after a year of inactivity —
        // manually, rather than waiting for that to happen. Excluded
        // for your own account so root can't start their own deletion
        // clock by mistake.
        const deactivateBtn = document.createElement('button');
        deactivateBtn.className = 'btn btn-danger btn-sm';
        deactivateBtn.textContent = 'Force pending deletion';
        deactivateBtn.addEventListener('click', async () => {
          if (!(await confirmAction({ title: 'Force pending deletion?', text: `${s.full_name || 'This account'} will enter the 30-day pending-deletion phase. They'll keep normal access until they sign in again (which cancels it), or you reactivate it sooner.`, confirmText: 'Force pending deletion' }))) return;
          deactivateBtn.disabled = true;
          const { error } = await supabaseClient.rpc('deactivate_account', { p_user_id: s.id });
          if (error) { toast(error.message || 'Could not deactivate this account.', 'error'); deactivateBtn.disabled = false; return; }
          s.deactivated_at = new Date().toISOString();
          toast(`${s.full_name || 'Account'} moved into the pending-deletion phase.`, 'success');
          renderStudents(allStudents);
        });
        actionsTd.appendChild(deactivateBtn);
      }
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
  }

  signOutButton.addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    window.location.href = 'index.html';
  });

  init();
})();