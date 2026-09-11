(function () {
  const signOutButton = document.getElementById('signOutButton');
  let currentTimetableCourse = null;
  let currentAdminUserId = null;

  function populateCourseSelects() {
    const selects = [document.getElementById('timetableCourseSelect'), document.getElementById('announcementCourse')];
    selects.forEach((sel) => {
      sel.innerHTML = '';
      COURSES.forEach((group) => {
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
    });
  }

  function courseNameFor(code) {
    for (const group of COURSES) {
      const found = group.options.find((o) => o.value === code);
      if (found) return found.label;
    }
    return code;
  }

  async function init() {
    const admin = await requireAdmin();
    if (!admin) return;

    currentAdminUserId = admin.session.user.id;

    populateCourseSelects();

    document.getElementById('headerEmail').textContent = admin.session.user.email || '';
    renderAvatar(document.getElementById('avatarSlot'), admin.profile.full_name || admin.session.user.email, admin.profile.avatar_url);

    document.getElementById('loadingMessage').hidden = true;
    document.getElementById('appShell').hidden = false;
    signOutButton.hidden = false;

    loadOverviewStats();
    loadAnnouncements();
    document.getElementById('timetableCourseSelect').addEventListener('change', (e) => loadTimetable(e.target.value));
    loadTimetable(document.getElementById('timetableCourseSelect').value);
    loadStudents();
  }

  /* ---------------- Overview ---------------- */
  async function loadOverviewStats() {
    const [{ count: studentCount }, { count: announcementCount }, { count: timetableCount }, { count: unverifiedCount }, { count: inactiveCount }] = await Promise.all([
      supabaseClient.from('profiles').select('*', { count: 'exact', head: true }),
      supabaseClient.from('announcements').select('*', { count: 'exact', head: true }),
      supabaseClient.from('timetable').select('*', { count: 'exact', head: true }),
      supabaseClient.from('profiles').select('*', { count: 'exact', head: true }).eq('verified', false),
      supabaseClient.from('profiles').select('*', { count: 'exact', head: true }).not('deactivated_at', 'is', null),
    ]);
    document.getElementById('statStudents').textContent = studentCount ?? '–';
    document.getElementById('statAnnouncements').textContent = announcementCount ?? '–';
    document.getElementById('statTimetable').textContent = timetableCount ?? '–';
    document.getElementById('statUnverified').textContent = unverifiedCount ?? '–';
    document.getElementById('statInactive').textContent = inactiveCount ?? '–';
  }

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

    mirrorToFirestore('announcements', data.id, data);
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
    if (error) { list.innerHTML = '<li class="empty-state">Could not load announcements.</li>'; return; }
    if (!data.length) { list.innerHTML = '<li class="empty-state">No announcements yet.</li>'; return; }

    data.forEach((a) => {
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

  function openTimetableModal(existing) {
    timetableForm.reset();
    document.getElementById('timetableEntryId').value = existing ? existing.id : '';
    document.getElementById('timetableModalTitle').textContent = existing ? 'Edit entry' : 'New timetable entry';
    if (existing) {
      document.getElementById('timetableDay').value = existing.day_name;
      document.getElementById('timetableStart').value = existing.start_time;
      document.getElementById('timetableEnd').value = existing.end_time;
      document.getElementById('timetableSubject').value = existing.subject;
      document.getElementById('timetableRoom').value = existing.room || '';
      document.getElementById('timetableLecturer').value = existing.lecturer_name || '';
      document.getElementById('timetableFileUrl').value = existing.file_url || '';
      document.getElementById('timetableFileName').value = existing.file_name || '';
    }
    setStatus(document.getElementById('timetableFormStatus'), '', null);
    timetableModal.hidden = false;
  }
  document.getElementById('newTimetableEntryBtn').addEventListener('click', () => openTimetableModal(null));
  document.getElementById('timetableModalClose').addEventListener('click', () => timetableModal.hidden = true);

  timetableForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('timetableFormStatus');
    const submitBtn = document.getElementById('timetableSubmit');
    const id = document.getElementById('timetableEntryId').value;

    let fileUrl = document.getElementById('timetableFileUrl').value.trim() || null;
    let fileName = document.getElementById('timetableFileName').value.trim() || null;

    const uploadInput = document.getElementById('timetableFileUpload');
    const uploadStatus = document.getElementById('timetableUploadStatus');
    const chosenFile = uploadInput.files && uploadInput.files[0];

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
      fileName = fileName || chosenFile.name;
      uploadStatus.textContent = 'Uploaded.';
    }

    const payload = {
      course_code: currentTimetableCourse,
      day_name: document.getElementById('timetableDay').value,
      start_time: document.getElementById('timetableStart').value,
      end_time: document.getElementById('timetableEnd').value,
      subject: document.getElementById('timetableSubject').value.trim(),
      room: document.getElementById('timetableRoom').value.trim() || null,
      lecturer_name: document.getElementById('timetableLecturer').value.trim() || null,
      file_url: fileUrl,
      file_name: fileName,
    };

    if (payload.end_time <= payload.start_time) {
      submitBtn.disabled = false;
      setStatus(status, 'End time must be after start time.', 'error');
      return;
    }

    const { data, error } = id
      ? await supabaseClient.from('timetable').update(payload).eq('id', id).select().single()
      : await supabaseClient.from('timetable').insert(payload).select().single();
    submitBtn.disabled = false;

    if (error) { setStatus(status, 'Could not save entry. Please try again.', 'error'); console.error('Saving timetable entry failed:', error); return; }

    uploadInput.value = '';
    uploadStatus.textContent = '';
    mirrorToFirestore('timetable', data.id, data);
    timetableModal.hidden = true;
    toast(id ? 'Entry updated.' : 'Entry added.', 'success');
    loadTimetable(currentTimetableCourse);
    loadOverviewStats();
  });

  async function loadTimetable(courseCode) {
    currentTimetableCourse = courseCode;
    const tbody = document.getElementById('timetableTableBody');
    tbody.innerHTML = '<tr><td colspan="6"><div class="skeleton skeleton-line"></div></td></tr>';

    const { data, error } = await supabaseClient
      .from('timetable')
      .select('id, day_name, start_time, end_time, subject, room, lecturer_name, file_name, file_url')
      .eq('course_code', courseCode)
      .order('day_name')
      .order('start_time');

    tbody.innerHTML = '';
    if (error) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Could not load timetable.</td></tr>'; return; }
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No entries for this course yet.</td></tr>'; return; }

    data.forEach((entry) => {
      const tr = document.createElement('tr');

      const cells = [
        entry.day_name,
        `${entry.start_time}–${entry.end_time}`,
        entry.subject,
        entry.room || '—',
        entry.lecturer_name || '—',
      ];
      cells.forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });

      const actionsTd = document.createElement('td');
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openTimetableModal(entry));
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger btn-sm';
      deleteBtn.textContent = 'Delete';
      deleteBtn.style.marginLeft = '8px';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete this timetable entry?')) return;
        const { error: delError } = await supabaseClient.from('timetable').delete().eq('id', entry.id);
        if (delError) { toast('Could not delete entry.', 'error'); return; }
        toast('Entry deleted.', 'success');
        loadTimetable(currentTimetableCourse);
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

    if (error) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Could not load students.</td></tr>'; return; }
    allStudents = (data || []).filter((s) => !s.is_super_admin);
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
    if (!students.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No matching students.</td></tr>'; return; }

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
        mirrorToFirestore('profiles', s.id, { course_code: newCode, course_name: newName });
        toast(`Updated ${s.full_name || 'student'}'s course.`, 'success');
      });
      courseTd.appendChild(courseSelect);
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
          mirrorToFirestore('profiles', s.id, { verified: s.verified });
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
        mirrorToFirestore('profiles', s.id, { is_admin: makeAdmin });
        renderStudents(allStudents);
      });
      roleTd.appendChild(roleBadge);
      tr.appendChild(roleTd);

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