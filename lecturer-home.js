(function () {
  const loadingMessage = document.getElementById('loadingMessage');
  const appShell = document.getElementById('appShell');
  const signOutButton = document.getElementById('signOutButton');
  const supportTicketForm = document.getElementById('supportTicketForm');
  let currentUserProfile = {};


  function populateCourseSelects() {
    document.querySelectorAll('select.course-select-target').forEach((select) => {
      const keepFirst = select.querySelector('option'); // preserve "-- Select --" placeholder
      select.innerHTML = '';
      if (keepFirst) select.appendChild(keepFirst);

      // Staff isn't a real course with students on it, so it can't be
      // graded — leave the Staff group off the grading picker entirely
      // rather than let someone select it and find an empty table.
      // studentCourseSelect and announcementCourse still get every
      // group, including Staff, since those really do apply to staff
      // accounts (assigning "Staff" as someone's course, or posting a
      // course-scoped announcement).
      const groups = select.id === 'gradesCourseSelect' ? COURSES.filter((g) => g.label !== 'Staff') : COURSES;
      groups.forEach((group) => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.label;
        group.options.forEach((opt) => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          optgroup.appendChild(option);
        });
        select.appendChild(optgroup);
      });

      enhanceCourseSelect(select);
    });

    // timetableCourseSelect isn't a .course-select-target — it's a
    // standalone "which course am I looking at" picker with no placeholder,
    // and Staff isn't a real course with a schedule so it's excluded.
    const timetableSelect = document.getElementById('timetableCourseSelect');
    timetableSelect.innerHTML = '';
    COURSES.filter((g) => g.label !== 'Staff').forEach((group) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      group.options.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        optgroup.appendChild(option);
      });
      timetableSelect.appendChild(optgroup);
    });
    enhanceCourseSelect(timetableSelect);
  }

  function courseNameFor(code) {
    for (const group of COURSES) {
      const found = group.options.find((o) => o.value === code);
      if (found) return found.label;
    }
    return code;
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function daysUntil(iso) {
    return Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  }

  function openModal(id) { document.getElementById(id).hidden = false; }
  function closeModal(id) { document.getElementById(id).hidden = true; }

  /* ---------------- Overview ---------------- */

  async function loadOverview() {
    const [students, staff, admins, anns, tt, inactive, recent] = await Promise.all([
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'staff'),
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin'),
      supabaseClient.from('announcements').select('id', { count: 'exact', head: true }),
      supabaseClient.from('timetable').select('id', { count: 'exact', head: true }),
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).not('deactivated_at', 'is', null),
      supabaseClient.from('profiles').select('full_name, email, created_at').order('created_at', { ascending: false }).limit(5),
    ]);

    document.getElementById('statStudents').textContent = students.count ?? '—';
    document.getElementById('statStaff').textContent = staff.count ?? '—';
    document.getElementById('statAdmins').textContent = admins.count ?? '—';
    document.getElementById('statAnnouncements').textContent = anns.count ?? '—';
    document.getElementById('statTimetable').textContent = tt.count ?? '—';
    document.getElementById('statInactive').textContent = inactive.count ?? '—';

    if (students.error) console.error('Overview stat query failed (students):', students.error);
    if (staff.error) console.error('Overview stat query failed (staff):', staff.error);
    if (admins.error) console.error('Overview stat query failed (admins):', admins.error);
    if (anns.error) console.error('Overview stat query failed (announcements):', anns.error);
    if (tt.error) console.error('Overview stat query failed (timetable):', tt.error);
    if (inactive.error) console.error('Overview stat query failed (inactive):', inactive.error);
    if (recent.error) console.error('Overview stat query failed (recent):', recent.error);

    const list = document.getElementById('recentList');
    list.innerHTML = '';
    const rows = recent.data || [];
    if (!rows.length) {
      list.innerHTML = '<li class="empty-state">No one has signed up yet.</li>';
      return;
    }
    rows.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'record';
      const title = document.createElement('div');
      title.className = 'record-title';
      title.textContent = p.full_name || p.email || 'Unnamed';
      const meta = document.createElement('div');
      meta.className = 'record-meta';
      meta.textContent = fmtDate(p.created_at);
      li.append(title, meta);
      list.appendChild(li);
    });
  }

  /* ---------------- Students ---------------- */

  let allProfiles = [];
  let currentUserId = null;
  let currentUserEmail = null;
  let currentUserIsAdmin = false;
  let currentUserIsSuperAdmin = false;
  let editingStudentId = null;

  async function loadStudents() {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, full_name, student_id, email, course_code, course_name, role, verified, last_active_at, deactivated_at, created_at, is_super_admin')
      .order('created_at', { ascending: false });

    const tbody = document.getElementById('studentsTbody');
    if (error) {
      console.error('Loading accounts failed:', error);
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Could not load accounts right now.</td></tr>';
      return;
    }
    // Visibility is handled by RLS now (see the staff-visibility
    // migration) — anyone with staff access can see every account,
    // including admins and root. This list no longer filters anything
    // out client-side.
    allProfiles = data || [];
    renderStudents();
  }

  function renderStudents() {
    const q = document.getElementById('studentSearch').value.trim().toLowerCase();
    const tbody = document.getElementById('studentsTbody');
    tbody.innerHTML = '';

    const rows = allProfiles.filter((p) => {
      if (!q) return true;
      return [p.full_name, p.email, p.student_id].some((v) => (v || '').toLowerCase().includes(q));
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No matching accounts.</td></tr>';
      return;
    }

    rows.forEach((p) => {
      const tr = document.createElement('tr');

      [p.full_name || '—', p.student_id || '—', p.email || '—', p.course_name || 'Not selected'].forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });

      const roleTd = document.createElement('td');
      const roleBadge = document.createElement('span');
      roleBadge.className = 'badge ' + (p.role === 'admin' ? 'badge-admin' : p.role === 'staff' ? 'badge-staff' : 'badge-student');
      roleBadge.textContent = p.role;
      roleTd.appendChild(roleBadge);
      tr.appendChild(roleTd);

      const rootTd = document.createElement('td');
      const isSelf = p.id === currentUserId;
      const rootBadge = document.createElement('button');
      rootBadge.type = 'button';
      rootBadge.className = 'badge ' + (p.is_super_admin ? 'badge-admin' : 'badge-unverified');
      rootBadge.textContent = p.is_super_admin ? 'Root' : '—';
      if (currentUserIsSuperAdmin && !isSelf) {
        rootBadge.style.cursor = 'pointer';
        rootBadge.style.border = 'none';
        rootBadge.title = p.is_super_admin ? 'Click to revoke root access' : 'Click to grant root access';
        rootBadge.addEventListener('click', async () => {
          const grant = !p.is_super_admin;
          const label = grant ? 'Grant ROOT (super admin) access to' : 'Revoke root access from';
          if (!confirm(`${label} ${p.full_name || 'this user'}? This is a temporary arrangement while root grants go through admins — treat it carefully.`)) return;
          const { error } = await supabaseClient.rpc('set_super_admin', { p_user_id: p.id, p_value: grant });
          if (error) { toast(error.message || 'Could not update root access.', 'error'); return; }
          toast(grant ? `Granted root access to ${p.full_name || 'user'}.` : `Revoked root access from ${p.full_name || 'user'}.`, 'success');
          await loadStudents();
        });
      } else {
        rootBadge.disabled = true;
        rootBadge.style.border = 'none';
        rootBadge.title = isSelf
          ? "You can't change your own root status."
          : (currentUserIsAdmin ? 'Only a super admin can grant or revoke root access.' : '');
      }
      rootTd.appendChild(rootBadge);
      tr.appendChild(rootTd);

      const statusTd = document.createElement('td');
      if (p.deactivated_at) {
        const remaining = 30 - Math.floor((Date.now() - new Date(p.deactivated_at).getTime()) / (1000 * 60 * 60 * 24));
        const badge = document.createElement('span');
        badge.className = 'badge badge-inactive';
        badge.textContent = remaining > 0 ? `Deletes in ${remaining}d` : 'Deletion pending';
        statusTd.appendChild(badge);
      } else {
        const badge = document.createElement('span');
        badge.className = 'badge ' + (p.verified ? 'badge-verified' : 'badge-unverified');
        badge.textContent = p.verified ? 'Verified' : 'Pending';
        statusTd.appendChild(badge);
      }
      tr.appendChild(statusTd);

      const actionsTd = document.createElement('td');
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openStudentEdit(p));
      actionsTd.appendChild(editBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    });
  }

  function openStudentEdit(p) {
    editingStudentId = p.id;
    document.getElementById('studentModalTitle').textContent = `Editing ${p.full_name || p.email || 'this account'}`;
    document.getElementById('studentFullName').value = p.full_name || '';
    document.getElementById('studentStudentId').value = p.student_id || '';
    document.getElementById('studentCourseSelect').value = p.course_code || '';
    syncCourseSelectDisplay(document.getElementById('studentCourseSelect'));
    document.getElementById('studentRoleSelect').value = p.role;
    document.getElementById('studentVerifiedCheckbox').checked = !!p.verified;

    const roleSelect = document.getElementById('studentRoleSelect');
    const roleHint = document.getElementById('roleFieldHint');
    if (!currentUserIsAdmin) {
      roleSelect.disabled = true;
      roleHint.textContent = "Only an admin can change roles. You can still update course, verification, and other details.";
    } else {
      roleSelect.disabled = false;
      roleHint.textContent = "Admins can sign in to this dashboard and manage everything here, including other people's roles. Staff can sign in too, and can verify students, post announcements, and manage the timetable — but can't change anyone's role.";
    }

    const reactivateWrap = document.getElementById('studentReactivateWrap');
    if (p.deactivated_at) {
      const remaining = 30 - Math.floor((Date.now() - new Date(p.deactivated_at).getTime()) / (1000 * 60 * 60 * 24));
      document.getElementById('studentDeactivatedNote').textContent =
        `Deactivated on ${fmtDate(p.deactivated_at)}. ` +
        (remaining > 0 ? `Will be permanently deleted in ${remaining} day(s) unless reactivated.` : 'Past the reactivation window — will be deleted soon.');
      reactivateWrap.hidden = false;
    } else {
      reactivateWrap.hidden = true;
    }

    setStatus(document.getElementById('studentEditStatus'), '', null);
    openModal('studentModalBackdrop');
  }

  function closeStudentEdit() {
    editingStudentId = null;
    document.getElementById('studentEditForm').reset();
    closeModal('studentModalBackdrop');
  }

  document.getElementById('studentReactivateBtn').addEventListener('click', async () => {
    if (!editingStudentId) return;
    const { error } = await supabaseClient.rpc('reactivate_account', { p_user_id: editingStudentId });
    if (error) { toast('Could not reactivate this account.', 'error'); return; }
    toast('Account reactivated.', 'success');
    document.getElementById('studentReactivateWrap').hidden = true;
    await loadStudents();
    await loadOverview();
  });

  document.getElementById('studentSearch').addEventListener('input', renderStudents);
  document.getElementById('studentRefresh').addEventListener('click', loadStudents);
  document.getElementById('studentEditCancel').addEventListener('click', closeStudentEdit);
  document.getElementById('studentModalClose').addEventListener('click', closeStudentEdit);

  document.getElementById('studentEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!editingStudentId) return;

    const status = document.getElementById('studentEditStatus');
    const submitBtn = document.getElementById('studentEditSubmit');
    const courseSelect = document.getElementById('studentCourseSelect');
    const newRole = document.getElementById('studentRoleSelect').value;

    if (editingStudentId === currentUserId && newRole !== 'admin') {
      const ok = window.confirm('This removes your own admin access and signs you out. Continue?');
      if (!ok) return;
    }

    const updates = {
      full_name: document.getElementById('studentFullName').value.trim() || null,
      student_id: document.getElementById('studentStudentId').value.trim() || null,
      course_code: courseSelect.value || null,
      course_name: courseSelect.value ? courseNameFor(courseSelect.value) : null,
      role: newRole,
      verified: document.getElementById('studentVerifiedCheckbox').checked,
    };

    submitBtn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient.from('profiles').update(updates).eq('id', editingStudentId);

    submitBtn.disabled = false;

    if (error) {
      const msg = error.message.toLowerCase();
      let friendly = 'Could not save changes.';
      if (msg.includes('duplicate')) friendly = 'That student ID is already in use.';
      if (msg.includes('last remaining admin')) friendly = "Can't remove admin access — this is the last admin account. Make someone else an admin first.";
      if (msg.includes('only an admin can change')) friendly = "Only an admin can change roles.";
      setStatus(status, friendly, 'error');
      return;
    }

    const editedSelf = editingStudentId === currentUserId;
    await loadStudents();
    await loadOverview();
    closeStudentEdit();
    toast('Account updated.', 'success');

    if (editedSelf && updates.role !== 'admin') {
      await supabaseClient.auth.signOut();
      window.location.href = 'lecturer-login.html';
    }
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
    if (!id) payload.created_by = currentUserId;

    const { data, error } = id
      ? await supabaseClient.from('announcements').update(payload).eq('id', id).select().single()
      : await supabaseClient.from('announcements').insert(payload).select().single();

    submitBtn.disabled = false;

    if (error) { setStatus(status, 'Could not save announcement. Please try again.', 'error'); return; }

    announcementModal.hidden = true;
    toast(id ? 'Announcement updated.' : 'Announcement published.', 'success');
    loadAnnouncements();
    loadOverview();
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
        loadOverview();
      });
      actions.append(editBtn, deleteBtn);

      item.append(title, meta, body, actions);
      list.appendChild(item);
    });
  }

  /* ---------------- Timetable ---------------- */
  let currentTimetableCourse = null;
  const timetableModal = document.getElementById('timetableModal');
  const timetableForm = document.getElementById('timetableForm');

  function openTimetableModal(existing) {
    timetableForm.reset();
    document.getElementById('timetableEntryId').value = existing ? existing.id : '';
    document.getElementById('timetableModalTitle').textContent = existing ? 'Edit entry' : 'New timetable entry';
    if (existing) {
      document.getElementById('timetableFileUrl').value = existing.file_url || '';
      document.getElementById('timetableFileName').value = existing.file_name || '';
    } else {
      document.getElementById('timetableFileName').value = courseNameFor(currentTimetableCourse);
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

    let fileUrl = document.getElementById('timetableFileUrl').value.trim() || null;
    let fileName = document.getElementById('timetableFileName').value.trim() || courseNameFor(currentTimetableCourse);

    const uploadInput = document.getElementById('timetableFileUpload');
    const uploadStatus = document.getElementById('timetableUploadStatus');
    const chosenFile = uploadInput.files && uploadInput.files[0];

    if (!fileUrl && !chosenFile) {
      setStatus(status, 'Provide a link or upload a file.', 'error');
      return;
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

    const payload = {
      course_code: currentTimetableCourse,
      file_url: fileUrl,
      file_name: fileName,
    };

    const { data, error } = await supabaseClient
      .from('timetable')
      .upsert(payload, { onConflict: 'course_code' })
      .select()
      .single();
    submitBtn.disabled = false;

    if (error) { setStatus(status, 'Could not save entry. Please try again.', 'error'); console.error('Saving timetable entry failed:', error); return; }

    uploadInput.value = '';
    uploadStatus.textContent = '';
    timetableModal.hidden = true;
    toast('Timetable saved.', 'success');
    loadTimetable(currentTimetableCourse);
    loadOverview();
    markUploadedTimetableCourses();
  });

  async function loadTimetable(courseCode) {
    currentTimetableCourse = courseCode;
    const tbody = document.getElementById('timetableTableBody');
    tbody.innerHTML = '<tr><td colspan="4"><div class="skeleton skeleton-line"></div></td></tr>';

    const { data, error } = await supabaseClient
      .from('timetable')
      .select('id, course_code, file_name, file_url, updated_at')
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
    if (entry.file_url) {
      const link = document.createElement('a');
      link.href = entry.file_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'file-link';
      link.textContent = entry.file_name || 'View timetable';
      fileTd.appendChild(link);
    } else {
      fileTd.textContent = '—';
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
      loadOverview();
      markUploadedTimetableCourses();
    });
    actionsTd.append(editBtn, deleteBtn);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  }

  // Prefixes a ✓ onto the course options that already have a timetable
  // uploaded, so it's visible at a glance before you even pick one.
  async function markUploadedTimetableCourses() {
    const sel = document.getElementById('timetableCourseSelect');
    const { data, error } = await supabaseClient.from('timetable').select('course_code');
    if (error) { console.error('Could not load uploaded-timetable list:', error); return; }
    const uploaded = new Set((data || []).map((r) => r.course_code));
    sel.querySelectorAll('option').forEach((opt) => {
      const label = opt.textContent.replace(/^✓ /, '');
      opt.textContent = uploaded.has(opt.value) ? `✓ ${label}` : label;
    });
    syncCourseSelectDisplay(sel); // the ✓ above may have just changed the currently-selected option's text
  }

  /* ---------------- Grades ---------------- */

  // Grade (100%) and GPA are entered directly by staff, not derived
  // from Attendance/Class work/Home work/Examination — those four stay
  // as their own record but don't feed into the total. The letter
  // grade is still suggested from whatever total you type in (unless
  // you've picked one yourself), using these thresholds.
  const LETTER_THRESHOLDS = [['A', 80], ['B', 70], ['C', 60], ['F', 0]];

  function suggestLetter(total) {
    for (const [letter, min] of LETTER_THRESHOLDS) {
      if (total >= min) return letter;
    }
    return 'F';
  }

  let currentGradesCourse = '';

  async function loadGrades(courseCode) {
    currentGradesCourse = courseCode;
    const tbody = document.getElementById('gradesTbody');
    if (!courseCode) { tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Select a course to input grades.</td></tr>'; return; }
    tbody.innerHTML = '<tr><td colspan="10"><div class="skeleton skeleton-line"></div></td></tr>';

    const [studentsRes, gradesRes] = await Promise.all([
      supabaseClient
        .from('profiles')
        .select('id, full_name, student_id')
        .eq('course_code', courseCode)
        .eq('role', 'student')
        .order('full_name'),
      supabaseClient
        .from('grades')
        .select('student_id, attendance, class_work, home_work, examination, total_grade, gpa, letter_grade')
        .eq('course_code', courseCode),
    ]);

    tbody.innerHTML = '';
    if (studentsRes.error) {
      console.error('Loading students for grades failed:', studentsRes.error);
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Could not load students.</td></tr>';
      return;
    }
    if (gradesRes.error) console.error('Loading existing grades failed:', gradesRes.error);

    const students = studentsRes.data || [];
    if (!students.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No students are on this course yet.</td></tr>';
      return;
    }

    const gradeByStudent = new Map((gradesRes.data || []).map((g) => [g.student_id, g]));
    students.forEach((s) => renderGradeRow(s, gradeByStudent.get(s.id)));
  }

  function renderGradeRow(student, existing) {
    const tbody = document.getElementById('gradesTbody');
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td'); nameTd.textContent = student.full_name || '—'; tr.appendChild(nameTd);
    const idTd = document.createElement('td'); idTd.textContent = student.student_id || '—'; tr.appendChild(idTd);

    function numberInput(value, { max = '100', step = '0.1' } = {}) {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = max;
      input.step = step;
      input.value = value == null ? '' : value;
      return input;
    }

    const attendanceInput = numberInput(existing && existing.attendance);
    const classWorkInput = numberInput(existing && existing.class_work);
    const homeWorkInput = numberInput(existing && existing.home_work);
    const examInput = numberInput(existing && existing.examination);
    const totalInput = numberInput(existing && existing.total_grade);
    const gpaInput = numberInput(existing && existing.gpa, { max: '4.3', step: '0.01' });

    [attendanceInput, classWorkInput, homeWorkInput, examInput, totalInput].forEach((input) => {
      const td = document.createElement('td');
      td.appendChild(input);
      tr.appendChild(td);
    });

    const letterTd = document.createElement('td');
    const letterSelect = document.createElement('select');
    letterSelect.style.width = 'auto';
    ['A', 'B', 'C', 'F'].forEach((letter) => {
      const opt = document.createElement('option');
      opt.value = letter;
      opt.textContent = letter;
      letterSelect.appendChild(opt);
    });
    letterTd.appendChild(letterSelect);
    tr.appendChild(letterTd);

    const gpaTd = document.createElement('td');
    gpaTd.appendChild(gpaInput);
    tr.appendChild(gpaTd);

    // Suggest a letter from whatever Grade (100%) you type in, unless
    // you've picked one yourself — once you touch the dropdown, this
    // stops overwriting it.
    totalInput.addEventListener('input', () => {
      if (letterSelect.dataset.manual) return;
      if (totalInput.value === '') return;
      const total = Number(totalInput.value);
      if (!Number.isNaN(total)) letterSelect.value = suggestLetter(total);
    });
    letterSelect.addEventListener('change', () => { letterSelect.dataset.manual = '1'; });

    if (existing && existing.letter_grade) {
      letterSelect.dataset.manual = '1';
      letterSelect.value = existing.letter_grade;
    } else if (totalInput.value !== '') {
      letterSelect.value = suggestLetter(Number(totalInput.value));
    }

    const actionsTd = document.createElement('td');
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const payload = {
        student_id: student.id,
        course_code: currentGradesCourse,
        course_name: courseNameFor(currentGradesCourse),
        attendance: attendanceInput.value === '' ? 0 : Number(attendanceInput.value),
        class_work: classWorkInput.value === '' ? 0 : Number(classWorkInput.value),
        home_work: homeWorkInput.value === '' ? 0 : Number(homeWorkInput.value),
        examination: examInput.value === '' ? 0 : Number(examInput.value),
        total_grade: totalInput.value === '' ? 0 : Number(totalInput.value),
        gpa: gpaInput.value === '' ? null : Number(gpaInput.value),
        letter_grade: letterSelect.value,
        updated_by: currentUserId,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabaseClient.from('grades').upsert(payload, { onConflict: 'student_id,course_code' });
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      if (error) {
        console.error('Saving grade failed:', error);
        toast('Could not save this grade.', 'error');
        return;
      }
      toast(`Saved grade for ${student.full_name || 'student'}.`, 'success');
    });
    actionsTd.appendChild(saveBtn);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  }

  document.getElementById('gradesCourseSelect').addEventListener('change', (e) => loadGrades(e.target.value));
  document.getElementById('gradesRefresh').addEventListener('click', () => loadGrades(currentGradesCourse));

  /* ---------------- Maintenance banner (admin only) ---------------- */

  async function loadMaintenanceCard() {
    const card = document.getElementById('maintenanceCard');
    if (!currentUserIsAdmin) { card.hidden = true; return; }
    card.hidden = false;

    const { data, error } = await supabaseClient
      .from('system_status')
      .select('maintenance_mode, maintenance_message')
      .eq('id', 1)
      .maybeSingle();

    if (!error && data) {
      document.getElementById('maintenanceToggle').checked = !!data.maintenance_mode;
      document.getElementById('maintenanceMessage').value = data.maintenance_message || '';
    }
  }

  document.getElementById('maintenanceSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('maintenanceStatus');
    const btn = document.getElementById('maintenanceSaveBtn');
    const active = document.getElementById('maintenanceToggle').checked;
    const message = document.getElementById('maintenanceMessage').value.trim() || null;

    btn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient
      .from('system_status')
      .update({ maintenance_mode: active, maintenance_message: message })
      .eq('id', 1);

    btn.disabled = false;

    if (error) {
      setStatus(status, 'Could not update the maintenance banner.', 'error');
      return;
    }

    setStatus(status, active ? 'Maintenance banner is now live.' : 'Maintenance banner turned off.', 'success');
    toast(active ? 'Maintenance banner turned on.' : 'Maintenance banner turned off.', 'success');
  });

  /* ---------------- Support ---------------- */

  async function loadSupportTab() {
    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('full_name, student_id, course_code, course_name')
      .eq('id', currentUserId)
      .single();

    if (error) console.error('Could not load profile for support tab:', error);
    currentUserProfile = profile || {};

    document.getElementById('ticketName').value = currentUserProfile.full_name || '';
    document.getElementById('ticketStudentId').value = currentUserProfile.student_id || '';
    document.getElementById('ticketCourse').value = currentUserProfile.course_name || 'Staff';

    await loadMyTickets();
  }

  const ticketStatusLabel = { open: 'Open', in_progress: 'In progress', closed: 'Closed' };
  const ticketStatusBadge = { open: 'badge-unverified', in_progress: 'badge-staff', closed: 'badge-verified' };

  // Closed tickets render collapsed (a native <details> with a
  // one-line summary) so a growing history of resolved tickets doesn't
  // bury the ones that still need attention. Open/in-progress tickets
  // stay fully expanded. `extraContent`, if given, is appended inside
  // the (always-visible-once-expanded) body — used by the admin "All
  // tickets" view to attach its status/response controls.
  function renderTicketItem(t, { who, extraContent } = {}) {
    const badge = document.createElement('span');
    badge.className = 'badge ' + (ticketStatusBadge[t.status] || 'badge-unverified');
    badge.textContent = ticketStatusLabel[t.status] || 'Open';

    const bodyBlock = document.createElement('div');
    bodyBlock.className = 'record-body';
    bodyBlock.textContent = t.body;

    const extras = [];
    if (t.attachment_url) {
      const link = document.createElement('a');
      link.className = 'file-link';
      link.href = t.attachment_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'View attachment';
      extras.push(link);
    }
    if (t.admin_response) {
      const reply = document.createElement('div');
      reply.className = 'record-body';
      reply.style.marginTop = '8px';
      reply.style.paddingTop = '8px';
      reply.style.borderTop = '1px dashed var(--paper-line)';
      const replyLabel = document.createElement('strong');
      replyLabel.textContent = 'Response: ';
      reply.appendChild(replyLabel);
      reply.appendChild(document.createTextNode(t.admin_response));
      extras.push(reply);
    }
    if (extraContent) extras.push(extraContent);

    const item = document.createElement('li');
    item.className = 'record';

    if (t.status === 'closed') {
      const details = document.createElement('details');
      details.className = 'ticket-compact';

      const summary = document.createElement('summary');
      const title = document.createElement('span');
      title.className = 'record-title';
      title.textContent = t.subject;
      const meta = document.createElement('span');
      meta.className = 'record-meta';
      if (who) {
        const whoSpan = document.createElement('span');
        whoSpan.textContent = who;
        meta.appendChild(whoSpan);
      }
      const dateSpan = document.createElement('span');
      dateSpan.textContent = fmtDate(t.created_at);
      meta.append(dateSpan, badge);
      summary.append(title, meta);

      const content = document.createElement('div');
      content.className = 'ticket-compact-body';
      content.append(bodyBlock, ...extras);

      details.append(summary, content);
      item.appendChild(details);
    } else {
      const title = document.createElement('div');
      title.className = 'record-title';
      title.textContent = t.subject;

      const meta = document.createElement('div');
      meta.className = 'record-meta';
      if (who) {
        const whoSpan = document.createElement('span');
        whoSpan.textContent = who;
        meta.appendChild(whoSpan);
      }
      const dateSpan = document.createElement('span');
      dateSpan.textContent = fmtDate(t.created_at);
      meta.append(dateSpan, badge);

      item.append(title, meta, bodyBlock, ...extras);
    }

    return item;
  }

  async function loadMyTickets() {
    const list = document.getElementById('ticketsList');
    const { data, error } = await supabaseClient
      .from('support_tickets')
      .select('id, subject, body, status, attachment_url, admin_response, created_at')
      .eq('user_id', currentUserId)
      .order('created_at', { ascending: false })
      .limit(20);

    list.innerHTML = '';
    if (error) {
      console.error('Loading tickets failed:', error);
      list.innerHTML = '<li class="empty-state">Could not load your tickets right now.</li>';
      return;
    }
    const rows = data || [];
    if (!rows.length) {
      list.innerHTML = '<li class="empty-state">No tickets submitted yet.</li>';
      return;
    }

    rows.forEach((t) => list.appendChild(renderTicketItem(t)));
  }

  async function loadAllTickets() {
    if (!currentUserIsAdmin) return;
    const list = document.getElementById('adminTicketsList');
    const { data, error } = await supabaseClient
      .from('support_tickets')
      .select('id, full_name, student_id, course_name, subject, body, attachment_url, status, admin_response, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    list.innerHTML = '';
    if (error) {
      console.error('Loading all tickets failed:', error);
      list.innerHTML = '<li class="empty-state">Could not load tickets right now.</li>';
      return;
    }
    const rows = data || [];
    if (!rows.length) {
      list.innerHTML = '<li class="empty-state">No tickets submitted yet.</li>';
      return;
    }

    // Open tickets first, then in-progress, then closed — newest within
    // each group — so what still needs attention floats to the top.
    const statusRank = { open: 0, in_progress: 1, closed: 2 };
    rows.sort((a, b) =>
      (statusRank[a.status] ?? 0) - (statusRank[b.status] ?? 0) ||
      new Date(b.created_at) - new Date(a.created_at)
    );

    rows.forEach((t) => {
      // Who filed it and when — plain text, never an editable field, so
      // there's no way to accidentally change someone's name/ID/course
      // from here.
      const who = `${t.full_name || 'Unknown'} · ID ${t.student_id || '—'} · ${t.course_name || 'Staff'}`;

      const controls = document.createElement('div');
      controls.style.marginTop = '14px';

      const statusLabel = document.createElement('label');
      statusLabel.textContent = 'Status';
      const statusSelect = document.createElement('select');
      [['open', 'Open'], ['in_progress', 'In progress'], ['closed', 'Closed']].forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if (value === t.status) opt.selected = true;
        statusSelect.appendChild(opt);
      });

      const responseLabel = document.createElement('label');
      responseLabel.textContent = 'Response';
      const responseTextarea = document.createElement('textarea');
      responseTextarea.value = t.admin_response || '';
      responseTextarea.maxLength = 4000;
      responseTextarea.placeholder = 'Write a reply…';

      const saveRow = document.createElement('div');
      saveRow.className = 'card-row-between';
      saveRow.style.marginBottom = '0';
      const saveStatus = document.createElement('span');
      saveStatus.className = 'field-hint';
      saveStatus.style.margin = '0';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-sm';
      saveBtn.textContent = 'Save';

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveStatus.textContent = 'Saving…';
        const { error: updateError } = await supabaseClient
          .from('support_tickets')
          .update({
            status: statusSelect.value,
            admin_response: responseTextarea.value.trim() || null,
            responded_by: currentUserId,
            responded_at: new Date().toISOString(),
          })
          .eq('id', t.id);
        saveBtn.disabled = false;
        if (updateError) {
          console.error('Updating ticket failed:', updateError);
          saveStatus.textContent = 'Could not save.';
          return;
        }
        saveStatus.textContent = 'Saved.';
        toast('Ticket updated.', 'success');
      });

      saveRow.append(saveStatus, saveBtn);
      controls.append(statusLabel, statusSelect, responseLabel, responseTextarea, saveRow);

      list.appendChild(renderTicketItem(t, { who, extraContent: controls }));
    });
  }
  document.getElementById('adminTicketsRefresh').addEventListener('click', loadAllTickets);

  function resetTicketForm() {
    supportTicketForm.reset();
    document.getElementById('ticketName').value = currentUserProfile.full_name || '';
    document.getElementById('ticketStudentId').value = currentUserProfile.student_id || '';
    document.getElementById('ticketCourse').value = currentUserProfile.course_name || 'Staff';
    document.getElementById('ticketAttachmentStatus').textContent = '';
  }

  supportTicketForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('ticketFormStatus');
    const submitBtn = document.getElementById('ticketSubmitBtn');
    const subject = document.getElementById('ticketSubject').value.trim();
    const body = document.getElementById('ticketBody').value.trim();
    const fileInput = document.getElementById('ticketAttachment');
    const attachStatus = document.getElementById('ticketAttachmentStatus');
    const chosenFile = fileInput.files && fileInput.files[0];

    if (!subject || !body) {
      setStatus(status, 'Please fill in a subject and message.', 'error');
      return;
    }

    submitBtn.disabled = true;
    setStatus(status, '', null);

    let attachmentUrl = null;
    let attachmentPath = null;
    if (chosenFile) {
      attachStatus.textContent = 'Uploading…';
      const path = `${currentUserId}/${Date.now()}-${chosenFile.name}`;
      const { error: uploadError } = await supabaseClient.storage
        .from('support-attachments')
        .upload(path, chosenFile, { upsert: false });

      if (uploadError) {
        console.error('Ticket attachment upload failed:', uploadError);
        attachStatus.textContent = '';
        submitBtn.disabled = false;
        setStatus(status, 'Could not upload the picture. Please try again.', 'error');
        return;
      }
      const { data: publicUrlData } = supabaseClient.storage.from('support-attachments').getPublicUrl(path);
      attachmentUrl = publicUrlData.publicUrl;
      attachmentPath = path; // kept alongside the URL so the cleanup job can remove the file, not just the row
      attachStatus.textContent = 'Uploaded.';
    }

    const { error } = await supabaseClient.from('support_tickets').insert({
      user_id: currentUserId,
      user_email: currentUserEmail,
      full_name: currentUserProfile.full_name || null,
      student_id: currentUserProfile.student_id || null,
      course_code: currentUserProfile.course_code || null,
      course_name: currentUserProfile.course_name || null,
      subject,
      body,
      attachment_url: attachmentUrl,
      attachment_path: attachmentPath,
      portal_origin: window.location.origin,
    });

    submitBtn.disabled = false;

    if (error) {
      console.error('Submitting ticket failed:', error);
      setStatus(status, 'Could not submit your ticket. Please try again.', 'error');
      return;
    }

    setStatus(status, 'Ticket submitted.', 'success');
    toast('Support ticket submitted.', 'success');
    resetTicketForm();
    loadMyTickets();
  });

  /* ---------------- Boot ---------------- */

  async function init() {
    const admin = await requireAdmin();
    if (!admin) return; // already redirected to home.html

    currentUserId = admin.session.user.id;
    currentUserEmail = admin.session.user.email || null;
    currentUserIsAdmin = admin.isAdmin;
    currentUserIsSuperAdmin = admin.isSuperAdmin;
    document.getElementById('headerName').textContent = admin.profile.full_name || admin.session.user.email || '';
    renderAvatar(document.getElementById('avatarSlot'), admin.profile.full_name || admin.session.user.email, admin.profile.avatar_url);
    document.getElementById('adminTicketsSection').hidden = !currentUserIsAdmin;

    populateCourseSelects();
    document.getElementById('timetableCourseSelect').addEventListener('change', (e) => loadTimetable(e.target.value));
    markUploadedTimetableCourses();

    loadingMessage.hidden = true;
    appShell.hidden = false;
    signOutButton.hidden = false;

    await Promise.all([
      loadOverview(),
      loadStudents(),
      loadAnnouncements(),
      loadTimetable(document.getElementById('timetableCourseSelect').value),
      loadMaintenanceCard(),
      loadSupportTab(),
      loadAllTickets(),
      loadGrades(document.getElementById('gradesCourseSelect').value),
    ]);
  }

  signOutButton.addEventListener('click', async () => {
    signOutButton.disabled = true;
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      signOutButton.disabled = false;
      toast('Sign-out error: ' + friendlyAuthError(error), 'error');
      return;
    }
    window.location.href = 'lecturer-login.html';
  });

  init();
})();