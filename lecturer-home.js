(function () {
  const loadingMessage = document.getElementById('loadingMessage');
  const appShell = document.getElementById('appShell');
  const signOutButton = document.getElementById('signOutButton');

  function populateCourseSelects() {
    document.querySelectorAll('select.course-select-target').forEach((select) => {
      const keepFirst = select.querySelector('option'); // preserve "All courses" / "-- Select --" placeholder
      // Staff isn't a real course with a schedule — don't offer it as a
      // timetable target, even though it's valid elsewhere (assigning a
      // staff account to a course, or a course-scoped announcement).
      const isTimetableSelect = select.id === 'timetableCourseSelect' || select.id === 'timetableFilter';
      const groups = isTimetableSelect ? COURSES.filter((g) => g.label !== 'Staff') : COURSES;
      select.innerHTML = '';
      if (keepFirst) select.appendChild(keepFirst);
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
    const { data, error } = await supabaseClient.from('timetable').select('course_code');
    if (error) { console.error('Could not load uploaded-timetable list:', error); return; }
    const uploaded = new Set((data || []).map((r) => r.course_code));
    ['timetableCourseSelect', 'timetableFilter'].forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.querySelectorAll('option').forEach((opt) => {
        if (!opt.value) return; // leave the placeholder/"All courses" option alone
        const label = opt.textContent.replace(/^✓ /, '');
        opt.textContent = uploaded.has(opt.value) ? `✓ ${label}` : label;
      });
    });
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

  let editingAnnouncementId = null;
  const announcementAudience = document.getElementById('announcementAudience');
  const announcementScopeWrap = document.getElementById('announcementScopeWrap');

  function toggleAnnouncementScope() {
    announcementScopeWrap.style.display = announcementAudience.value === 'course' ? 'block' : 'none';
  }
  announcementAudience.addEventListener('change', toggleAnnouncementScope);

  async function loadAnnouncements() {
    const { data, error } = await supabaseClient
      .from('announcements')
      .select('id, title, message, audience, course_code, created_at')
      .order('created_at', { ascending: false });

    const tbody = document.getElementById('announcementsTbody');
    if (error) {
      console.error('Loading announcements failed:', error);
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Could not load announcements right now.</td></tr>';
      document.getElementById('announcementsCount').textContent = '';
      return;
    }

    const rows = data || [];
    document.getElementById('announcementsCount').textContent = `${rows.length} total`;
    tbody.innerHTML = '';

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No announcements yet.</td></tr>';
      return;
    }

    rows.forEach((a) => {
      const tr = document.createElement('tr');

      const titleTd = document.createElement('td');
      titleTd.textContent = a.title;
      tr.appendChild(titleTd);

      const scopeTd = document.createElement('td');
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
      scopeTd.appendChild(badge);
      tr.appendChild(scopeTd);

      const dateTd = document.createElement('td');
      dateTd.textContent = fmtDate(a.created_at);
      tr.appendChild(dateTd);

      const actionsTd = document.createElement('td');
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openAnnouncementEdit(a));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-danger btn-sm';
      deleteBtn.style.marginLeft = '6px';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteAnnouncement(a.id));

      actionsTd.append(editBtn, deleteBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    });
  }

  function openAnnouncementCreate() {
    editingAnnouncementId = null;
    document.getElementById('announcementModalTitle').textContent = 'New announcement';
    document.getElementById('announcementEditForm').reset();
    announcementAudience.value = 'course';
    toggleAnnouncementScope();
    document.getElementById('announcementEditSubmit').textContent = 'Post announcement';
    setStatus(document.getElementById('announcementEditStatus'), '', null);
    openModal('announcementModalBackdrop');
  }

  function openAnnouncementEdit(a) {
    editingAnnouncementId = a.id;
    document.getElementById('announcementModalTitle').textContent = 'Editing announcement';
    document.getElementById('announcementTitle').value = a.title;
    announcementAudience.value = a.audience;
    document.getElementById('announcementScope').value = a.course_code || '';
    document.getElementById('announcementMessage').value = a.message;
    toggleAnnouncementScope();
    document.getElementById('announcementEditSubmit').textContent = 'Save changes';
    setStatus(document.getElementById('announcementEditStatus'), '', null);
    openModal('announcementModalBackdrop');
  }

  function closeAnnouncementEdit() {
    editingAnnouncementId = null;
    document.getElementById('announcementEditForm').reset();
    closeModal('announcementModalBackdrop');
  }

  document.getElementById('announcementNewBtn').addEventListener('click', openAnnouncementCreate);
  document.getElementById('announcementEditCancel').addEventListener('click', closeAnnouncementEdit);
  document.getElementById('announcementModalClose').addEventListener('click', closeAnnouncementEdit);

  document.getElementById('announcementEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('announcementEditStatus');
    const submitBtn = document.getElementById('announcementEditSubmit');

    const audience = announcementAudience.value;
    const scopeSelect = document.getElementById('announcementScope');
    const courseCode = audience === 'course' ? scopeSelect.value : null;

    const payload = {
      title: document.getElementById('announcementTitle').value.trim(),
      audience,
      course_code: courseCode,
      message: document.getElementById('announcementMessage').value.trim(),
    };

    if (!payload.title || !payload.message) {
      setStatus(status, 'Title and message are both required.', 'error');
      return;
    }
    if (audience === 'course' && !courseCode) {
      setStatus(status, 'Choose a course for a course-specific announcement.', 'error');
      return;
    }

    // Only one global ("everyone") announcement may exist at a time. If one
    // is already live, warn and offer to delete it before publishing this
    // one — declining leaves the existing one untouched and posts nothing.
    if (audience === 'everyone') {
      let existingQuery = supabaseClient.from('announcements').select('id').eq('audience', 'everyone');
      if (editingAnnouncementId) existingQuery = existingQuery.neq('id', editingAnnouncementId);
      const { data: existingGlobal, error: checkError } = await existingQuery;

      if (checkError) {
        console.error('Checking for an existing global announcement failed:', checkError);
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
          console.error('Deleting the existing global announcement failed:', delError);
          setStatus(status, 'Could not remove the existing global announcement. Please try again.', 'error');
          return;
        }
      }
    }

    submitBtn.disabled = true;
    setStatus(status, '', null);

    const { error } = editingAnnouncementId
      ? await supabaseClient.from('announcements').update(payload).eq('id', editingAnnouncementId)
      : await supabaseClient.from('announcements').insert({ ...payload, created_by: currentUserId });

    submitBtn.disabled = false;

    if (error) {
      console.error('Saving announcement failed:', error);
      setStatus(status, 'Could not save the announcement.', 'error');
      return;
    }

    await loadAnnouncements();
    closeAnnouncementEdit();
    await loadOverview();
    toast('Announcement saved.', 'success');
  });

  async function deleteAnnouncement(id) {
    if (!window.confirm('Delete this announcement? This cannot be undone.')) return;
    const { error } = await supabaseClient.from('announcements').delete().eq('id', id);
    if (error) {
      toast('Could not delete the announcement.', 'error');
      return;
    }
    await loadAnnouncements();
    await loadOverview();
    toast('Announcement deleted.', 'success');
  }

  /* ---------------- Timetable ---------------- */

  async function loadTimetable() {
    markUploadedTimetableCourses();
    const filter = document.getElementById('timetableFilter').value;
    let query = supabaseClient
      .from('timetable')
      .select('id, course_code, file_name, file_url, updated_at')
      .order('course_code');

    if (filter) query = query.eq('course_code', filter);

    const { data, error } = await query;
    const tbody = document.getElementById('timetableTbody');

    if (error) {
      console.error('Loading timetable failed:', error);
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Could not load the timetable right now.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    const rows = data || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No timetables uploaded yet.</td></tr>';
      return;
    }

    rows.forEach((entry) => {
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
      editBtn.type = 'button';
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openTimetableEdit(entry));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-danger btn-sm';
      deleteBtn.style.marginLeft = '6px';
      deleteBtn.textContent = 'Remove';
      deleteBtn.addEventListener('click', () => deleteTimetableEntry(entry));

      actionsTd.append(editBtn, deleteBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    });
  }

  function openTimetableCreate() {
    document.getElementById('timetableModalTitle').textContent = 'New entry';
    document.getElementById('timetableEditForm').reset();
    document.getElementById('timetableEditSubmit').textContent = 'Save entry';
    const filter = document.getElementById('timetableFilter').value;
    if (filter) {
      document.getElementById('timetableCourseSelect').value = filter;
      document.getElementById('timetableFileName').value = courseNameFor(filter);
    }
    setStatus(document.getElementById('timetableEditStatus'), '', null);
    openModal('timetableModalBackdrop');
  }

  // Auto-fill the label with the course name once one's picked, unless
  // the person's already typed their own label.
  document.getElementById('timetableCourseSelect').addEventListener('change', (e) => {
    const nameField = document.getElementById('timetableFileName');
    if (!nameField.value.trim()) nameField.value = courseNameFor(e.target.value);
  });

  function openTimetableEdit(entry) {
    document.getElementById('timetableModalTitle').textContent = 'Editing entry';
    document.getElementById('timetableCourseSelect').value = entry.course_code;
    document.getElementById('timetableFileUrl').value = entry.file_url || '';
    document.getElementById('timetableFileName').value = entry.file_name || '';
    document.getElementById('timetableEditSubmit').textContent = 'Save changes';
    setStatus(document.getElementById('timetableEditStatus'), '', null);
    openModal('timetableModalBackdrop');
  }

  function closeTimetableEdit() {
    document.getElementById('timetableEditForm').reset();
    closeModal('timetableModalBackdrop');
  }

  document.getElementById('timetableFilter').addEventListener('change', loadTimetable);
  document.getElementById('timetableNewBtn').addEventListener('click', openTimetableCreate);
  document.getElementById('timetableEditCancel').addEventListener('click', closeTimetableEdit);
  document.getElementById('timetableModalClose').addEventListener('click', closeTimetableEdit);

  document.getElementById('timetableEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('timetableEditStatus');
    const submitBtn = document.getElementById('timetableEditSubmit');

    const courseSelect = document.getElementById('timetableCourseSelect');
    if (!courseSelect.value) { setStatus(status, 'Please select a course.', 'error'); return; }

    let fileUrl = document.getElementById('timetableFileUrl').value.trim() || null;
    let fileName = document.getElementById('timetableFileName').value.trim() || courseNameFor(courseSelect.value);

    const uploadInput = document.getElementById('timetableFileUpload');
    const uploadStatus = document.getElementById('timetableUploadStatus');
    const chosenFile = uploadInput.files && uploadInput.files[0];

    if (!fileUrl && !chosenFile) {
      setStatus(status, 'Provide a link or upload a file.', 'error');
      return;
    }

    submitBtn.disabled = true;
    setStatus(status, '', null);

    if (chosenFile) {
      uploadStatus.textContent = 'Uploading…';
      const path = `${courseSelect.value}/${Date.now()}-${chosenFile.name}`;
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
      course_code: courseSelect.value,
      file_url: fileUrl,
      file_name: fileName,
    };

    // One row per course — upsert on course_code so re-saving an
    // existing course replaces its timetable instead of erroring on
    // the unique constraint.
    const { error } = await supabaseClient
      .from('timetable')
      .upsert(payload, { onConflict: 'course_code' });

    submitBtn.disabled = false;

    if (error) {
      setStatus(status, 'Could not save this entry.', 'error');
      console.error('Saving timetable entry failed:', error);
      return;
    }

    uploadInput.value = '';
    uploadStatus.textContent = '';
    await loadTimetable();
    closeTimetableEdit();
    await loadOverview();
    toast('Timetable saved.', 'success');
  });

  async function deleteTimetableEntry(entry) {
    if (!window.confirm(`Remove the timetable for ${entry.course_code}? This cannot be undone.`)) return;
    const { error } = await supabaseClient.from('timetable').delete().eq('id', entry.id);
    if (error) {
      toast('Could not remove this entry.', 'error');
      return;
    }
    await loadTimetable();
    await loadOverview();
    toast('Timetable removed.', 'success');
  }

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

  /* ---------------- Boot ---------------- */

  async function init() {
    const admin = await requireAdmin();
    if (!admin) return; // already redirected to home.html

    currentUserId = admin.session.user.id;
    currentUserIsAdmin = admin.isAdmin;
    currentUserIsSuperAdmin = admin.isSuperAdmin;
    document.getElementById('headerName').textContent = admin.profile.full_name || admin.session.user.email || '';
    renderAvatar(document.getElementById('avatarSlot'), admin.profile.full_name || admin.session.user.email, admin.profile.avatar_url);

    populateCourseSelects();

    loadingMessage.hidden = true;
    appShell.hidden = false;
    signOutButton.hidden = false;

    await Promise.all([loadOverview(), loadStudents(), loadAnnouncements(), loadTimetable(), loadMaintenanceCard()]);
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