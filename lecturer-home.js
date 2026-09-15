(function () {
  const loadingMessage = document.getElementById('loadingMessage');
  const appShell = document.getElementById('appShell');
  const signOutButton = document.getElementById('signOutButton');
  const supportTicketForm = document.getElementById('supportTicketForm');
  let currentUserProfile = {};

  /* ---------------- "New response" tracking ----------------
     There's no DB column for this — it's just a per-browser,
     per-account memory (localStorage) of the responded_at we've
     already shown the person for each of their tickets. Anything
     with a newer responded_at than what's stored counts as unseen,
     which drives the Support nav badge, a toast on load, and a
     "New" tag on the ticket itself. Purely a display convenience;
     it doesn't touch the ticket rows in Postgres. */
  let lastMyTicketsRows = [];

  function seenResponsesKey() {
    return `gti-seen-ticket-responses-${currentUserId}`;
  }
  function getSeenResponses() {
    try { return JSON.parse(localStorage.getItem(seenResponsesKey())) || {}; }
    catch { return {}; }
  }
  function getUnseenResponses(rows) {
    const seen = getSeenResponses();
    return rows.filter((t) => t.admin_response && seen[t.id] !== t.responded_at);
  }
  function updateSupportBadge(unseenCount) {
    const badge = document.getElementById('supportNavBadge');
    if (!badge) return;
    if (unseenCount > 0) {
      badge.textContent = String(unseenCount);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }
  function markResponsesSeen(rows) {
    const seen = getSeenResponses();
    rows.forEach((t) => { if (t.admin_response) seen[t.id] = t.responded_at; });
    try { localStorage.setItem(seenResponsesKey(), JSON.stringify(seen)); } catch {}
    updateSupportBadge(0);
    // Drop the inline "New" tags immediately too, rather than waiting
    // for the list to reload.
    document.querySelectorAll('#ticketsList .ticket-new-tag').forEach((el) => el.remove());
  }


  function populateCourseSelects() {
    document.querySelectorAll('select.course-select-target').forEach((select) => {
      const keepFirst = select.querySelector('option'); // preserve "-- Select --" placeholder
      select.innerHTML = '';
      if (keepFirst) select.appendChild(keepFirst);

      // Staff isn't a real course with students on it, so it can't be
      // graded — leave the Staff group off the grading picker entirely
      // rather than let someone select it and find an empty table.
      // Same reasoning for resources: a resource is course material,
      // so "Staff" doesn't belong in either the course picker in the
      // modal or the tab's filter dropdown.
      // studentCourseSelect and announcementCourse still get every
      // group, including Staff, since those really do apply to staff
      // accounts (assigning "Staff" as someone's course, or posting a
      // course-scoped announcement).
      const NO_STAFF_GROUP_SELECTS = ['gradesCourseSelect', 'resourceCourse', 'resourceCourseFilter'];
      const groups = NO_STAFF_GROUP_SELECTS.includes(select.id) ? COURSES.filter((g) => g.label !== 'Staff') : COURSES;
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

  // Small stroke icons matching the sidebar nav's own icon style, same
  // set introduced on the student dashboard (home.js) — kept here as
  // its own copy since this page ships as a separate script, not a
  // shared module.
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

  async function loadOverview() {
    const [students, staff, admins, anns, tt, res, inactive, recent] = await Promise.all([
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'staff'),
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin'),
      supabaseClient.from('announcements').select('id', { count: 'exact', head: true }),
      supabaseClient.from('timetable').select('id', { count: 'exact', head: true }),
      supabaseClient.from('resources').select('id', { count: 'exact', head: true }),
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).not('deactivated_at', 'is', null),
      supabaseClient.from('profiles').select('full_name, email, created_at').order('created_at', { ascending: false }).limit(5),
    ]);

    document.getElementById('statStudents').textContent = students.count ?? '—';
    document.getElementById('statStaff').textContent = staff.count ?? '—';
    document.getElementById('statAdmins').textContent = admins.count ?? '—';
    document.getElementById('statAnnouncements').textContent = anns.count ?? '—';
    document.getElementById('statTimetable').textContent = tt.count ?? '—';
    document.getElementById('statResources').textContent = res.count ?? '—';
    document.getElementById('statInactive').textContent = inactive.count ?? '—';

    if (students.error) console.error('Overview stat query failed (students):', students.error);
    if (staff.error) console.error('Overview stat query failed (staff):', staff.error);
    if (admins.error) console.error('Overview stat query failed (admins):', admins.error);
    if (anns.error) console.error('Overview stat query failed (announcements):', anns.error);
    if (tt.error) console.error('Overview stat query failed (timetable):', tt.error);
    if (res.error) console.error('Overview stat query failed (resources):', res.error);
    if (inactive.error) console.error('Overview stat query failed (inactive):', inactive.error);
    if (recent.error) console.error('Overview stat query failed (recent):', recent.error);

    const list = document.getElementById('recentList');
    list.innerHTML = '';
    const rows = recent.data || [];
    if (!rows.length) {
      list.innerHTML = emptyState('No one has signed up yet.');
      return;
    }
    rows.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'record';

      const head = document.createElement('div');
      head.className = 'record-head';
      const headMain = document.createElement('div');
      headMain.className = 'record-head-main';
      const headText = document.createElement('div');
      headText.className = 'record-head-text';

      const title = document.createElement('div');
      title.className = 'record-title';
      title.textContent = p.full_name || p.email || 'Unnamed';
      const meta = document.createElement('div');
      meta.className = 'record-meta';
      meta.textContent = fmtDate(p.created_at);
      headText.append(title, meta);

      headMain.append(recordIcon('person'), headText);
      head.appendChild(headMain);
      li.appendChild(head);
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

    if (error) {
      console.error('Loading accounts failed:', error);
      document.getElementById('studentsTbody').innerHTML = '<tr><td colspan="8" class="empty-state">Could not load accounts right now.</td></tr>';
      document.getElementById('staffTbody').innerHTML = '<tr><td colspan="8" class="empty-state">Could not load accounts right now.</td></tr>';
      return;
    }
    // Visibility is handled by RLS now (see the staff-visibility
    // migration) — anyone with staff access can see every account,
    // including admins and root. This list no longer filters anything
    // out client-side. The two tabs below (Students / Staff) each pick
    // their own slice of allProfiles by role.
    allProfiles = data || [];
    renderStudents();
    renderStaff();
  }

  function matchesProfileSearch(p, q) {
    if (!q) return true;
    return [p.full_name, p.email, p.student_id].some((v) => (v || '').toLowerCase().includes(q));
  }

  // Shared by the Students and Staff tabs — same columns, just a
  // different filter feeding in above.
  function buildProfileRow(p) {
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

    return tr;
  }

  function renderStudents() {
    const q = document.getElementById('studentSearch').value.trim().toLowerCase();
    const courseFilter = document.getElementById('studentCourseFilter').value;
    const tbody = document.getElementById('studentsTbody');
    tbody.innerHTML = '';

    const rows = allProfiles.filter((p) => {
      if (p.role !== 'student') return false;
      if (courseFilter && p.course_code !== courseFilter) return false;
      return matchesProfileSearch(p, q);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No matching students.</td></tr>';
      return;
    }

    rows.forEach((p) => tbody.appendChild(buildProfileRow(p)));
  }

  function renderStaff() {
    const q = document.getElementById('staffSearch').value.trim().toLowerCase();
    const tbody = document.getElementById('staffTbody');
    tbody.innerHTML = '';

    const rows = allProfiles.filter((p) => {
      if (p.role !== 'staff' && p.role !== 'admin') return false;
      return matchesProfileSearch(p, q);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No matching staff.</td></tr>';
      return;
    }

    rows.forEach((p) => tbody.appendChild(buildProfileRow(p)));
  }

  function populateStudentCourseFilter() {
    const select = document.getElementById('studentCourseFilter');
    select.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All courses';
    select.appendChild(allOpt);
    // Staff isn't a real course with students on it, so it's left out
    // here the same way it's left out of gradesCourseSelect above.
    COURSES.filter((g) => g.label !== 'Staff').forEach((group) => {
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
  document.getElementById('studentCourseFilter').addEventListener('change', renderStudents);
  document.getElementById('studentRefresh').addEventListener('click', loadStudents);
  document.getElementById('staffSearch').addEventListener('input', renderStaff);
  document.getElementById('staffRefresh').addEventListener('click', loadStudents);
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
    if (error) { console.error('Loading announcements failed:', error); list.innerHTML = emptyState('Could not load announcements.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No announcements yet.'); return; }

    const ACCENT_FOR_AUDIENCE = { everyone: 'accent-danger', all_students: 'accent-brass', staff: 'accent-ink' };

    rows.forEach((a) => {
      const item = document.createElement('li');
      item.className = 'record' + (ACCENT_FOR_AUDIENCE[a.audience] ? ' ' + ACCENT_FOR_AUDIENCE[a.audience] : '');

      const head = document.createElement('div');
      head.className = 'record-head';
      const headMain = document.createElement('div');
      headMain.className = 'record-head-main';
      const headText = document.createElement('div');
      headText.className = 'record-head-text';

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

      headText.append(title, meta);
      headMain.append(recordIcon('bell'), headText);
      head.appendChild(headMain);

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

      item.append(head, body, actions);
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

  /* ---------------- Resources ----------------
     Same table (`resources`) and storage bucket (`resource-files`) as
     admin.html's Resources tab — this just brings the same management
     UI to plain staff accounts, matching how Announcements and
     Timetable already work here without needing full admin access.
     Unlike timetable (one row per course), resources are a plain list:
     several textbooks/links can exist for the same course. */
  let currentResourceFilter = '';
  const resourceModal = document.getElementById('resourceModal');
  const resourceForm = document.getElementById('resourceForm');

  function openResourceModal(existing) {
    resourceForm.reset();
    document.getElementById('resourceId').value = existing ? existing.id : '';
    document.getElementById('resourceModalTitle').textContent = existing ? 'Edit resource' : 'New resource';
    if (existing) {
      document.getElementById('resourceCourse').value = existing.course_code;
      document.getElementById('resourceTitle').value = existing.title;
      document.getElementById('resourceAuthor').value = existing.author || '';
      document.getElementById('resourceFileUrl').value = existing.file_url || '';
    } else if (currentResourceFilter) {
      document.getElementById('resourceCourse').value = currentResourceFilter;
    }
    syncCourseSelectDisplay(document.getElementById('resourceCourse'));
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
    const courseCode = document.getElementById('resourceCourse').value;
    const title = document.getElementById('resourceTitle').value.trim();
    const author = document.getElementById('resourceAuthor').value.trim() || null;
    let fileUrl = document.getElementById('resourceFileUrl').value.trim() || null;

    const uploadInput = document.getElementById('resourceFileUpload');
    const uploadStatus = document.getElementById('resourceUploadStatus');
    const chosenFile = uploadInput.files && uploadInput.files[0];

    if (!courseCode) {
      setStatus(status, 'Choose a course.', 'error');
      return;
    }
    if (!fileUrl && !chosenFile) {
      setStatus(status, 'Provide a link or upload a file.', 'error');
      return;
    }

    submitBtn.disabled = true;

    if (chosenFile) {
      uploadStatus.textContent = 'Uploading…';
      const path = `${courseCode}/${Date.now()}-${chosenFile.name}`;
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

    const payload = { course_code: courseCode, title, author, file_url: fileUrl };
    if (!id) payload.created_by = currentUserId;

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
    loadOverview();
  });

  async function loadResources(courseCode) {
    currentResourceFilter = courseCode || '';
    const list = document.getElementById('resourcesList');
    list.innerHTML = '';

    let query = supabaseClient
      .from('resources')
      .select('id, course_code, title, author, file_url, created_at')
      .order('course_code')
      .order('title');
    if (courseCode) query = query.eq('course_code', courseCode);

    const { data, error } = await query;

    if (error) { console.error('Loading resources failed:', error); list.innerHTML = emptyState('Could not load resources.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No resources uploaded yet.'); return; }

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
      courseBadge.textContent = courseNameFor(r.course_code);
      meta.appendChild(courseBadge);
      if (r.author) {
        const authorSpan = document.createElement('span');
        authorSpan.textContent = r.author;
        meta.appendChild(authorSpan);
      }
      if (r.created_at) {
        const dateSpan = document.createElement('span');
        dateSpan.textContent = 'Added ' + fmtDate(r.created_at);
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
        if (!confirm(`Remove "${r.title}"?`)) return;
        const { error: delError } = await supabaseClient.from('resources').delete().eq('id', r.id);
        if (delError) { toast('Could not remove resource.', 'error'); return; }
        toast('Resource removed.', 'success');
        loadResources(currentResourceFilter);
        loadOverview();
      });
      actions.append(editBtn, deleteBtn);
      item.appendChild(actions);

      list.appendChild(item);
    });
  }

  /* ---------------- Grades ---------------- */

  // Grade (100%) is entered directly by staff, not derived from
  // Attendance/Class work/Home work/Examination — those four stay as
  // their own record but don't feed into the total. The letter grade
  // is still suggested from whatever total you type in (unless you've
  // picked one yourself), using these thresholds.
  const LETTER_THRESHOLDS = [['A', 80], ['B', 70], ['C', 60], ['F', 0]];
  // GPA is no longer typed in by hand — a subject's grade is now one
  // of several per student, so a manually-entered GPA on every one of
  // them stopped meaning anything. It's derived from the letter grade
  // on save, and shown once per student (an average across their
  // subjects) instead of repeated on every subject row.
  const GPA_FOR_LETTER = { A: 4.0, B: 3.0, C: 2.0, F: 0.0 };

  function suggestLetter(total) {
    for (const [letter, min] of LETTER_THRESHOLDS) {
      if (total >= min) return letter;
    }
    return 'F';
  }

  // Live-formats a subject name as the person types: collapses runs of
  // spaces down to one, drops a leading space, and title-cases each
  // word — so "computer  SCIENCE" becomes "Computer Science" without
  // staff having to clean it up themselves. Keeps the cursor where it
  // was rather than jumping to the end on every keystroke.
  function formatSubjectValue(raw) {
    let formatted = raw.replace(/ {2,}/g, ' ');
    if (formatted.startsWith(' ')) formatted = formatted.slice(1);
    formatted = formatted.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
    return formatted;
  }
  function wireSubjectFormatting(input) {
    input.addEventListener('input', () => {
      const raw = input.value;
      const cursor = input.selectionStart;
      const formatted = formatSubjectValue(raw);
      if (formatted === raw) return;
      const diff = raw.length - formatted.length;
      input.value = formatted;
      const pos = Math.max(0, cursor - diff);
      input.setSelectionRange(pos, pos);
    });
    input.addEventListener('blur', () => { input.value = input.value.trim(); });
  }

  let currentGradesCourse = '';
  let currentGradesStudents = [];
  let currentGradesByStudent = new Map(); // student_id -> array of grade rows (one per subject)

  async function loadGrades(courseCode) {
    currentGradesCourse = courseCode;
    const tbody = document.getElementById('gradesTbody');
    currentGradesStudents = [];
    currentGradesByStudent = new Map();
    if (!courseCode) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Select a course to input grades.</td></tr>'; return; }
    tbody.innerHTML = '<tr><td colspan="8"><div class="skeleton skeleton-line"></div></td></tr>';

    const [studentsRes, gradesRes] = await Promise.all([
      supabaseClient
        .from('profiles')
        .select('id, full_name, student_id')
        .eq('course_code', courseCode)
        .eq('role', 'student')
        .order('full_name'),
      supabaseClient
        .from('grades')
        .select('id, student_id, subject, attendance, class_work, home_work, examination, total_grade, gpa, letter_grade')
        .eq('course_code', courseCode)
        .order('subject'),
    ]);

    if (studentsRes.error) {
      console.error('Loading students for grades failed:', studentsRes.error);
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Could not load students.</td></tr>';
      return;
    }
    if (gradesRes.error) console.error('Loading existing grades failed:', gradesRes.error);

    currentGradesStudents = studentsRes.data || [];
    currentGradesByStudent = new Map();
    (gradesRes.data || []).forEach((g) => {
      if (!currentGradesByStudent.has(g.student_id)) currentGradesByStudent.set(g.student_id, []);
      currentGradesByStudent.get(g.student_id).push(g);
    });
    renderGradesTable();
  }

  function renderGradesTable() {
    const tbody = document.getElementById('gradesTbody');
    tbody.innerHTML = '';

    if (!currentGradesStudents.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No students are on this course yet.</td></tr>';
      return;
    }

    const q = document.getElementById('gradesSearch').value.trim().toLowerCase();
    const rows = q
      ? currentGradesStudents.filter((s) => (s.full_name || '').toLowerCase().includes(q) || (s.student_id || '').toLowerCase().includes(q))
      : currentGradesStudents;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No matching students.</td></tr>';
      return;
    }

    rows.forEach((s) => renderStudentGradeBlock(s, currentGradesByStudent.get(s.id) || []));
  }

  function renderStudentGradeBlock(student, existingRows) {
    const tbody = document.getElementById('gradesTbody');

    const headerRow = document.createElement('tr');
    headerRow.className = 'grades-student-row';
    const headerTd = document.createElement('td');
    headerTd.colSpan = 8;

    const inner = document.createElement('div');
    inner.className = 'grades-student-row-inner';

    const idBlock = document.createElement('div');
    idBlock.className = 'grades-student-id-block';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'grades-student-name';
    nameSpan.textContent = student.full_name || '—';
    const idSpan = document.createElement('span');
    idSpan.className = 'grades-student-idtext';
    idSpan.textContent = student.student_id ? `ID ${student.student_id}` : '';
    idBlock.append(nameSpan, idSpan);

    // GPA averaged from this student's saved subjects — shown once
    // here, not repeated on every subject row below.
    const graded = existingRows.filter((r) => r.gpa != null);
    if (graded.length) {
      const gpa = graded.reduce((sum, r) => sum + Number(r.gpa), 0) / graded.length;
      const gpaBadge = document.createElement('span');
      gpaBadge.className = 'badge badge-gpa';
      gpaBadge.textContent = 'GPA ' + gpa.toFixed(2);
      idBlock.appendChild(gpaBadge);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary btn-sm';
    addBtn.textContent = '+ Add subject';

    inner.append(idBlock, addBtn);
    headerTd.appendChild(inner);
    headerRow.appendChild(headerTd);
    tbody.appendChild(headerRow);

    // Tracks the most recently inserted row for this student, so
    // "+ Add subject" always inserts right after it — including after
    // a subject added earlier in the same session, not just the last
    // one that came from the database.
    const anchor = { el: headerRow };
    const rowsToRender = existingRows.length ? existingRows : [null];
    rowsToRender.forEach((existing) => {
      const tr = renderGradeSubjectRow(student, existing);
      anchor.el.insertAdjacentElement('afterend', tr);
      anchor.el = tr;
    });

    addBtn.addEventListener('click', () => {
      const tr = renderGradeSubjectRow(student, null);
      anchor.el.insertAdjacentElement('afterend', tr);
      anchor.el = tr;
      tr.querySelector('input[type="text"]').focus();
    });
  }

  function renderGradeSubjectRow(student, existing) {
    const tr = document.createElement('tr');

    const subjectTd = document.createElement('td');
    const subjectInput = document.createElement('input');
    subjectInput.type = 'text';
    subjectInput.maxLength = 100;
    subjectInput.placeholder = 'e.g., Computer Programming';
    subjectInput.value = (existing && existing.subject) || '';
    wireSubjectFormatting(subjectInput);
    subjectTd.appendChild(subjectInput);
    tr.appendChild(subjectTd);

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
    actionsTd.style.whiteSpace = 'nowrap';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      const subject = subjectInput.value.trim();
      if (!subject) {
        subjectInput.focus();
        toast('Enter a subject first.', 'error');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const letter = letterSelect.value;
      const payload = {
        student_id: student.id,
        course_code: currentGradesCourse,
        course_name: courseNameFor(currentGradesCourse),
        subject,
        attendance: attendanceInput.value === '' ? 0 : Number(attendanceInput.value),
        class_work: classWorkInput.value === '' ? 0 : Number(classWorkInput.value),
        home_work: homeWorkInput.value === '' ? 0 : Number(homeWorkInput.value),
        examination: examInput.value === '' ? 0 : Number(examInput.value),
        total_grade: totalInput.value === '' ? 0 : Number(totalInput.value),
        gpa: letter ? GPA_FOR_LETTER[letter] : null,
        letter_grade: letter,
        updated_by: currentUserId,
        updated_at: new Date().toISOString(),
      };

      const { error } = existing && existing.id
        ? await supabaseClient.from('grades').update(payload).eq('id', existing.id)
        : await supabaseClient.from('grades').insert(payload);

      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      if (error) {
        console.error('Saving grade failed:', error);
        toast('Could not save this grade.', 'error');
        return;
      }
      toast(`Saved ${subject} for ${student.full_name || 'student'}.`, 'success');
      loadGrades(currentGradesCourse);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-danger btn-sm';
    removeBtn.textContent = 'Remove';
    removeBtn.style.marginLeft = '8px';
    removeBtn.addEventListener('click', async () => {
      if (!existing || !existing.id) { tr.remove(); return; }
      if (!confirm(`Remove ${existing.subject ? `"${existing.subject}"` : 'this subject'} for ${student.full_name || 'this student'}?`)) return;
      const { error } = await supabaseClient.from('grades').delete().eq('id', existing.id);
      if (error) { toast('Could not remove this subject.', 'error'); return; }
      toast('Subject removed.', 'success');
      loadGrades(currentGradesCourse);
    });

    actionsTd.append(saveBtn, removeBtn);
    tr.appendChild(actionsTd);

    return tr;
  }

  document.getElementById('gradesCourseSelect').addEventListener('change', (e) => loadGrades(e.target.value));
  document.getElementById('gradesRefresh').addEventListener('click', () => loadGrades(currentGradesCourse));
  document.getElementById('gradesSearch').addEventListener('input', renderGradesTable);

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
  function renderTicketItem(t, { who, extraContent, isNew } = {}) {
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
      if (isNew) {
        const newTag = document.createElement('span');
        newTag.className = 'badge badge-staff ticket-new-tag';
        newTag.style.marginRight = '6px';
        newTag.textContent = 'New';
        reply.appendChild(newTag);
      }
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
      .select('id, subject, body, status, attachment_url, admin_response, responded_at, created_at')
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
    lastMyTicketsRows = rows;

    if (!rows.length) {
      list.innerHTML = '<li class="empty-state">No tickets submitted yet.</li>';
      updateSupportBadge(0);
      return;
    }

    const unseen = getUnseenResponses(rows);
    const unseenIds = new Set(unseen.map((t) => t.id));
    updateSupportBadge(unseen.length);

    rows.forEach((t) => list.appendChild(renderTicketItem(t, { isNew: unseenIds.has(t.id) })));

    // Only nudge with a toast the first time this loads with something
    // unseen — clicking into Support (see the nav listener below)
    // clears them, so this won't re-fire on every reload.
    if (unseen.length === 1) {
      toast(`You have a new response on "${unseen[0].subject}".`, 'info', 6000);
    } else if (unseen.length > 1) {
      toast(`You have new responses on ${unseen.length} tickets.`, 'info', 6000);
    }
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

  // Opening the Support tab means they've seen their responses —
  // clear the nav badge and the per-ticket "New" tags right away
  // rather than waiting for a data refetch.
  const supportNavItem = document.querySelector('.nav-item[data-tab="support"]');
  if (supportNavItem) {
    supportNavItem.addEventListener('click', () => markResponsesSeen(lastMyTicketsRows));
  }

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
    // Root/super admin only — being a plain "admin" is no longer
    // enough to see this link. (admin.js enforces the same rule on
    // admin.html itself, in case someone bookmarks or types the URL
    // directly instead of clicking this link.)
    document.getElementById('adminPanelLink').hidden = !currentUserIsSuperAdmin;

    populateCourseSelects();
    populateStudentCourseFilter();
    document.getElementById('timetableCourseSelect').addEventListener('change', (e) => loadTimetable(e.target.value));
    document.getElementById('resourceCourseFilter').addEventListener('change', (e) => loadResources(e.target.value));
    markUploadedTimetableCourses();

    loadingMessage.hidden = true;
    appShell.hidden = false;
    signOutButton.hidden = false;

    await Promise.all([
      loadOverview(),
      loadStudents(),
      loadAnnouncements(),
      loadTimetable(document.getElementById('timetableCourseSelect').value),
      loadResources(document.getElementById('resourceCourseFilter').value),
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