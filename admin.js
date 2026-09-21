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

    document.getElementById('loadingMessage').hidden = true;
    document.getElementById('appShell').hidden = false;
    signOutButton.hidden = false;

    if (admin.isSuperAdmin) {
      document.getElementById('systemNavItem').hidden = false;
      loadSystemStatus();
    }

    loadOverviewStats();
    loadAnnouncements();
    document.getElementById('timetableCourseSelect').addEventListener('change', (e) => loadTimetable(e.target.value));
    loadTimetable(document.getElementById('timetableCourseSelect').value);
    markUploadedTimetableCourses();
    loadStudents();
    document.getElementById('resourceCourseFilter').addEventListener('change', (e) => loadResources(e.target.value));
    loadResources('');
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

    if (nextValue && !confirm('Enable lockdown? This immediately blocks sign-in for everyone except admins, and signs out anyone else currently signed in.')) return;

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
        const proceed = window.confirm(
          'There is already a global announcement live. Delete it and publish this one instead?'
        );
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
    if (!rows.length) { list.innerHTML = '<li class="empty-state">No announcements yet.</li>'; return; }

    rows.forEach((a) => {
      const item = document.createElement('li');
      item.className = 'record';

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
        if (!confirm('Delete this announcement?')) return;
        const { error: delError } = await supabaseClient.from('announcements').delete().eq('id', a.id);
        if (delError) { toast('Could not delete announcement.', 'error'); return; }
        toast('Announcement deleted.', 'success');
        loadAnnouncements();
        loadOverviewStats();
      });
      actions.append(editBtn, deleteBtn);

      item.append(title, meta, body, actions);
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
        && !window.confirm('This replaces the table below with a fresh reading of the picture, and your edits to it will be lost. Continue?')) {
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
      if (window.confirm('You changed the table, but this timetable is set to show students the original image/PDF, so they would not see your changes.\n\nShow the converted table instead?')) {
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
      if (!confirm(`Remove the timetable for ${entry.course_code}?`)) return;
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

  async function loadResources(department) {
    currentResourceFilter = department || '';
    const tbody = document.getElementById('resourcesTableBody');
    tbody.innerHTML = '<tr><td colspan="6"><div class="skeleton skeleton-line"></div></td></tr>';

    let query = supabaseClient
      .from('resources')
      .select('id, department, title, author, file_url, created_at')
      .order('department')
      .order('title');
    if (department) query = query.eq('department', department);

    const { data, error } = await query;

    tbody.innerHTML = '';
    if (error) { console.error('Loading resources failed:', error); tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Could not load resources.</td></tr>'; return; }
    const rows = data || [];
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No resources uploaded yet.</td></tr>'; return; }

    rows.forEach((r) => {
      const tr = document.createElement('tr');

      const courseTd = document.createElement('td');
      courseTd.textContent = r.department;
      tr.appendChild(courseTd);

      const titleTd = document.createElement('td');
      titleTd.textContent = r.title;
      tr.appendChild(titleTd);

      const authorTd = document.createElement('td');
      authorTd.textContent = r.author || '—';
      tr.appendChild(authorTd);

      const fileTd = document.createElement('td');
      if (r.file_url) {
        const link = document.createElement('a');
        link.href = r.file_url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'file-link';
        link.textContent = 'Open';
        fileTd.appendChild(link);
      } else {
        fileTd.textContent = '—';
      }
      tr.appendChild(fileTd);

      const uploadedTd = document.createElement('td');
      uploadedTd.textContent = r.created_at
        ? new Date(r.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : '—';
      tr.appendChild(uploadedTd);

      const actionsTd = document.createElement('td');
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openResourceModal(r));
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger btn-sm';
      deleteBtn.textContent = 'Remove';
      deleteBtn.style.marginLeft = '8px';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Remove "${r.title}"?`)) return;
        const { error: delError } = await supabaseClient.from('resources').delete().eq('id', r.id);
        if (delError) { toast('Could not remove resource.', 'error'); return; }
        toast('Resource removed.', 'success');
        loadResources(currentResourceFilter);
        loadOverviewStats();
      });
      actionsTd.append(editBtn, deleteBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
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
        if (!confirm(makeAdmin ? `Make ${s.full_name || 'this user'} an admin?` : `Remove admin access from ${s.full_name || 'this user'}?`)) return;
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
        if (!confirm(`${label} ${s.full_name || 'this user'}? This is temporary while root grants go through admins — treat it carefully.`)) return;
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