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
      // modal or the tab's filter dropdown. Same for announcementCourse
      // (see buildAnnouncementCourseOptions, which rebuilds this select
      // from scratch anyway, so its own "no Staff" filter is what
      // actually governs the modal — this just keeps the select's
      // initial, pre-modal-open state consistent) — staff already have
      // "Staff only" as an audience option instead.
      // studentCourseSelect still gets every group, including Staff,
      // since assigning "Staff" as someone's course is a real thing.
      const NO_STAFF_GROUP_SELECTS = ['gradesCourseSelect', 'attendanceCourseSelect', 'announcementCourse'];
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

    // Now that the tab defaults to showing every course (with an
    // explicit "Show all" reset), this needs a real blank placeholder
    // so clearing the filter can land on an empty, disabled option —
    // it used to have none, back when picking a course was mandatory.
    // Staff still isn't a real course with a schedule, so it's excluded.
    const timetableSelect = document.getElementById('timetableCourseSelect');
    timetableSelect.innerHTML = '';
    const timetablePlaceholder = document.createElement('option');
    timetablePlaceholder.value = '';
    timetablePlaceholder.disabled = true;
    timetablePlaceholder.selected = true;
    timetablePlaceholder.textContent = '-- Search for a course --';
    timetableSelect.appendChild(timetablePlaceholder);
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
    enhanceCourseSelect(timetableSelect, { disableTypingOnMobile: true });

    // Same standalone treatment as timetableCourseSelect above — a
    // plain filter (with an "All courses" option), not part of the
    // searchable course-select-target widget.
    const resetCourseSelect = document.getElementById('attendanceResetCourse');
    const keepFirst = resetCourseSelect.querySelector('option'); // "All courses"
    resetCourseSelect.innerHTML = '';
    if (keepFirst) resetCourseSelect.appendChild(keepFirst);
    COURSES.filter((g) => g.label !== 'Staff').forEach((group) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      group.options.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        optgroup.appendChild(option);
      });
      resetCourseSelect.appendChild(optgroup);
    });
  }

  function courseNameFor(code) {
    for (const group of COURSES) {
      const found = group.options.find((o) => o.value === code);
      if (found) return found.label;
    }
    return code;
  }

  // Resources are uploaded per department rather than per specific
  // course (a lecturer covering "Natural Sciences" resources shouldn't
  // have to re-upload the same textbook once per course in that
  // department) — this maps a course code to its department the same
  // way courseNameFor() above maps it to a course name.
  function departmentFor(code) {
    const group = COURSES.find((g) => g.options.some((o) => o.value === code));
    return group ? group.label : code;
  }

  const DEPARTMENTS = COURSES.filter((g) => g.label !== 'Staff').map((g) => g.label);

  // Flat department lists for the Resources tab's course/filter pickers
  // — separate from populateCourseSelects() above (which builds the
  // full per-course optgroup pickers used everywhere else) since these
  // two need only the six department names, not every course under
  // them, and don't need the searchable course-combo UI for a list
  // this short.
  function populateDepartmentSelects() {
    document.querySelectorAll('select.department-select-target').forEach((select) => {
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

  /* ---------------- My Classes (weekly schedule) ----------------
     staff_class_schedule holds at most one row per (staff_id,
     day_of_week), day_of_week using JS's Date#getDay() numbering
     (0 = Sunday … 6 = Saturday) so "today" is a direct lookup with
     no remapping. This never restricts anything a staff account can
     see or do — has_staff_access() already covers all of that — it
     only feeds a "your classes" priority sort/quick-pick layered on
     top in a few places (Students search, Timetable, Attendance). */
  const WEEKDAYS = [
    { day: 1, label: 'Mon' },
    { day: 2, label: 'Tue' },
    { day: 3, label: 'Wed' },
    { day: 4, label: 'Thu' },
    { day: 5, label: 'Fri' },
  ];
  let mySchedule = new Map(); // day_of_week -> array of course_codes
  let myPriorityCourses = new Set(); // every distinct course_code across mySchedule

  function todaysScheduledCourse() {
    const list = mySchedule.get(new Date().getDay());
    return (list && list[0]) || '';
  }

  async function loadStudents() {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, full_name, student_id, email, course_code, course_name, role, job_title, verified, last_active_at, deactivated_at, created_at, is_super_admin')
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

      // Students' names open a read-only detail view (course, timetable,
      // full attendance). Staff/admin names open a similar read-only
      // view of their own info instead — the classes they teach and the
      // announcements they've posted. See openStudentDetail() /
      // openStaffDetail() below.
      if (p.role === 'student') {
        const nameTd = tr.firstElementChild;
        const nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'name-link';
        nameBtn.textContent = p.full_name || '—';
        nameBtn.title = 'View course, timetable and attendance';
        nameBtn.addEventListener('click', () => openStudentDetail(p));
        nameTd.textContent = '';
        nameTd.appendChild(nameBtn);
      } else if (p.role === 'staff' || p.role === 'admin') {
        const nameTd = tr.firstElementChild;
        const nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'name-link';
        nameBtn.textContent = p.full_name || '—';
        nameBtn.title = 'View classes and announcements';
        nameBtn.addEventListener('click', () => openStaffDetail(p));
        nameTd.textContent = '';
        nameTd.appendChild(nameBtn);
      }

      const roleTd = document.createElement('td');
      const roleBadge = document.createElement('span');
      roleBadge.className = 'badge ' + (p.role === 'admin' ? 'badge-admin' : p.role === 'staff' ? 'badge-staff' : 'badge-student');
      // Admins/technicians with a job_title show that (e.g. "Principal")
      // instead of the generic role name — see displayRoleLabel() in app.js.
      roleBadge.textContent = displayRoleLabel(p);
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

    // Students on one of this staff account's own classes (see "My
    // Classes") float to the top of whatever search/filter is
    // already applied — nothing is hidden or excluded, just
    // reordered, and admins (who never set up a schedule) see the
    // list in its normal order since myPriorityCourses is empty for
    // them.
    if (myPriorityCourses.size) {
      rows.sort((a, b) => {
        const aPriority = myPriorityCourses.has(a.course_code) ? 0 : 1;
        const bPriority = myPriorityCourses.has(b.course_code) ? 0 : 1;
        return aPriority - bPriority;
      });
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
    document.getElementById('studentJobTitleSelect').value = p.job_title || '';

    const roleSelect = document.getElementById('studentRoleSelect');
    const roleHint = document.getElementById('roleFieldHint');
    const jobTitleWrap = document.getElementById('jobTitleWrap');
    if (!currentUserIsAdmin) {
      roleSelect.disabled = true;
      roleHint.textContent = "Only an admin can change roles. You can still update course, verification, and other details.";
    } else {
      roleSelect.disabled = false;
      roleHint.textContent = "Admins can sign in to this dashboard and manage everything here, including other people's roles. Staff can sign in too, and can verify students, post announcements, and manage the timetable — but can't change anyone's role.";
    }
    // Job title only means anything for admin-tier accounts — hide it
    // entirely for student/staff rows rather than show a field that
    // does nothing.
    jobTitleWrap.hidden = roleSelect.value !== 'admin';

    const reactivateWrap = document.getElementById('studentReactivateWrap');
    const deactivateWrap = document.getElementById('studentDeactivateWrap');
    if (p.deactivated_at) {
      const remaining = 30 - Math.floor((Date.now() - new Date(p.deactivated_at).getTime()) / (1000 * 60 * 60 * 24));
      document.getElementById('studentDeactivatedNote').textContent =
        `Deactivated on ${fmtDate(p.deactivated_at)}. ` +
        (remaining > 0 ? `Will be permanently deleted in ${remaining} day(s) unless reactivated.` : 'Past the reactivation window — will be deleted soon.');
      reactivateWrap.hidden = false;
      deactivateWrap.hidden = true;
    } else {
      reactivateWrap.hidden = true;
      // Root and admins only, and never against your own account — no
      // reason a plain lecturer or an admin mid-edit-of-themselves
      // should be able to start their own deletion clock.
      deactivateWrap.hidden = !(currentUserIsAdmin || currentUserIsSuperAdmin) || p.id === currentUserId;
    }

    setStatus(document.getElementById('studentEditStatus'), '', null);
    openModal('studentModalBackdrop');
  }

  document.getElementById('studentRoleSelect').addEventListener('change', (e) => {
    document.getElementById('jobTitleWrap').hidden = e.target.value !== 'admin';
  });

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

  document.getElementById('studentDeactivateBtn').addEventListener('click', async () => {
    if (!editingStudentId) return;
    const p = allProfiles.find((x) => x.id === editingStudentId);
    if (!confirm(`Force ${(p && p.full_name) || 'this account'} into the 30-day pending-deletion phase? They'll keep normal access until they sign in again (which cancels it), or an admin reactivates it sooner.`)) return;
    const btn = document.getElementById('studentDeactivateBtn');
    btn.disabled = true;
    const { error } = await supabaseClient.rpc('deactivate_account', { p_user_id: editingStudentId });
    btn.disabled = false;
    if (error) { toast(error.message || 'Could not deactivate this account.', 'error'); return; }
    toast('Account moved into the pending-deletion phase.', 'success');
    document.getElementById('studentDeactivateWrap').hidden = true;
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

  /* ---------------- Student detail (click a name on the Students tab) ----
     Read-only snapshot of one student: their course, that course's
     timetable, and every attendance record on file — archived ones
     included, flagged as such. */

  let studentDetailToken = 0; // guards against a slow response landing after the modal was reopened for someone else

  document.getElementById('studentDetailClose').addEventListener('click', () => {
    studentDetailToken += 1;
    closeModal('studentDetailModal');
  });
  document.getElementById('studentDetailModal').addEventListener('click', (e) => {
    if (e.target.id === 'studentDetailModal') {
      studentDetailToken += 1;
      closeModal('studentDetailModal');
    }
  });

  function sdEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function sdSection(title, ...children) {
    const section = sdEl('section', 'sd-section');
    section.appendChild(sdEl('h3', 'sd-section-title', title));
    children.forEach((c) => section.appendChild(c));
    return section;
  }

  function sdFact(label, value) {
    const wrap = sdEl('div', 'sd-fact');
    wrap.append(sdEl('div', 'sd-fact-label', label), sdEl('div', 'sd-fact-value', value || '—'));
    return wrap;
  }

  function sdTable(headers, rows, scroll) {
    const wrap = sdEl('div', 'table-wrap sd-table-wrap' + (scroll ? ' sd-scroll' : ''));
    const table = sdEl('table', 'admin-table sd-table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach((text) => headRow.appendChild(sdEl('th', null, text)));
    thead.appendChild(headRow);
    const tbody = document.createElement('tbody');
    rows.forEach((cells) => {
      const tr = document.createElement('tr');
      cells.forEach((cell) => {
        const td = document.createElement('td');
        if (cell instanceof Node) td.appendChild(cell); else td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function sdPill(status) {
    const known = status === 'present' || status === 'absent' || status === 'late';
    return sdEl('span', 'sd-pill' + (known ? ' ' + status : ''), status ? status.charAt(0).toUpperCase() + status.slice(1) : '—');
  }

  async function openStudentDetail(p) {
    const token = ++studentDetailToken;
    const body = document.getElementById('studentDetailBody');
    const displayName = p.full_name || p.email || 'Student';
    document.getElementById('studentDetailTitle').textContent = displayName;
    document.getElementById('studentDetailAvatar').textContent = displayName.trim().charAt(0).toUpperCase();
    document.getElementById('studentDetailSub').textContent = [p.student_id, p.course_code].filter(Boolean).join(' · ');
    body.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line" style="width:60%;"></div>';
    openModal('studentDetailModal');

    const [ttRes, attRes] = await Promise.all([
      p.course_code
        ? supabaseClient.from('timetable').select('file_name, file_url, updated_at, table_data, display_mode').eq('course_code', p.course_code).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabaseClient
        .from('attendance')
        .select('subject, status, class_date, archived, marker:profiles!attendance_marked_by_fkey(full_name)')
        .eq('student_id', p.id)
        .order('class_date', { ascending: false })
        .limit(2000),
    ]);
    if (token !== studentDetailToken) return; // closed or switched to another student meanwhile

    body.innerHTML = '';
    body.scrollTop = 0;

    // ---- Course ----
    const facts = sdEl('div', 'sd-facts');
    facts.append(
      sdFact('Course', p.course_name || (p.course_code ? courseLabel(p.course_code) : 'Not selected')),
      sdFact('Course code', p.course_code),
      sdFact('Department', p.course_code ? departmentFor(p.course_code) : ''),
      sdFact('Student ID', p.student_id),
      sdFact('Email', p.email),
    );
    body.appendChild(sdSection('Course', facts));

    // ---- Timetable ----
    const ttSection = sdSection('Timetable');
    body.appendChild(ttSection);
    if (!p.course_code) {
      ttSection.appendChild(sdEl('p', 'sd-note', 'This student has no course selected, so there is no timetable to show.'));
    } else if (ttRes.error) {
      console.error('Loading student timetable failed:', ttRes.error);
      ttSection.appendChild(sdEl('p', 'sd-note', 'Could not load the timetable.'));
    } else if (ttRes.data && ttRes.data.file_url && /^https?:\/\//i.test(ttRes.data.file_url)) {
      const link = sdEl('a', 'sd-file');
      link.href = ttRes.data.file_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(sdEl('span', 'sd-file-name', ttRes.data.file_name || 'View timetable'), sdEl('span', 'sd-file-open', 'Open ↗'));
      ttSection.appendChild(link);
      if (ttRes.data.updated_at) ttSection.appendChild(sdEl('p', 'sd-note sd-note-gap', `Updated ${fmtDate(ttRes.data.updated_at)}`));
      if (ttRes.data.display_mode === 'table' && ttRes.data.table_data && ttRes.data.table_data.length) {
        const tableWrap = sdEl('div', 'tt-view-table-wrap sd-note-gap');
        TimetableEditor.renderTimetableView(tableWrap, ttRes.data.table_data);
        ttSection.appendChild(tableWrap);
        const openTabBtn = document.createElement('button');
        openTabBtn.type = 'button';
        openTabBtn.className = 'btn btn-sm';
        openTabBtn.textContent = 'Open in new tab ↗';
        openTabBtn.addEventListener('click', () => {
          TimetableEditor.openTimetablePopup(ttRes.data.table_data, ttRes.data.file_name || 'Timetable', 'view');
        });
        ttSection.appendChild(openTabBtn);
      }
    } else {
      ttSection.appendChild(sdEl('p', 'sd-note', 'No timetable has been uploaded for this course yet.'));
    }

    // ---- Attendance ----
    const attSection = sdSection('Attendance');
    body.appendChild(attSection);
    if (attRes.error) {
      console.error('Loading student attendance failed:', attRes.error);
      attSection.appendChild(sdEl('p', 'sd-note', 'Could not load attendance records.'));
      return;
    }
    const records = attRes.data || [];
    if (!records.length) {
      attSection.appendChild(sdEl('p', 'sd-note', 'No attendance has been recorded for this student yet.'));
      return;
    }

    const totals = { present: 0, absent: 0, late: 0 };
    const bySubject = new Map();
    records.forEach((r) => {
      if (totals[r.status] != null) totals[r.status] += 1;
      const subject = r.subject || 'No subject';
      if (!bySubject.has(subject)) bySubject.set(subject, { present: 0, absent: 0, late: 0 });
      const c = bySubject.get(subject);
      if (c[r.status] != null) c[r.status] += 1;
    });
    const pctOf = (c) => {
      const total = c.present + c.absent + c.late;
      return total ? `${Math.round((c.present / total) * 1000) / 10}%` : '—';
    };

    const stats = sdEl('div', 'sd-stats');
    [
      [totals.present, 'Present', 'present'],
      [totals.absent, 'Absent', 'absent'],
      [totals.late, 'Late', 'late'],
      [pctOf(totals), 'Attendance', 'rate'],
    ].forEach(([value, label, cls]) => {
      const stat = sdEl('div', 'sd-stat ' + cls);
      stat.append(sdEl('div', 'sd-stat-value', String(value)), sdEl('div', 'sd-stat-label', label));
      stats.appendChild(stat);
    });
    attSection.appendChild(stats);

    if (totals.present + totals.absent + totals.late > 0) {
      const bar = sdEl('div', 'sd-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `${totals.present} present, ${totals.late} late, ${totals.absent} absent`);
      ['present', 'late', 'absent'].forEach((key) => {
        if (!totals[key]) return;
        const seg = sdEl('span', key);
        seg.style.flex = String(totals[key]);
        bar.appendChild(seg);
      });
      attSection.appendChild(bar);
    }

    attSection.appendChild(sdEl('h4', 'sd-subtitle', 'By subject'));
    attSection.appendChild(sdTable(
      ['Subject', 'Present', 'Absent', 'Late', 'Attendance'],
      [...bySubject.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([subject, c]) => [subject, String(c.present), String(c.absent), String(c.late), pctOf(c)]),
    ));

    attSection.appendChild(sdEl('h4', 'sd-subtitle', `All records (${records.length})`));
    attSection.appendChild(sdTable(
      ['Date', 'Subject', 'Status', 'Marked by', ''],
      records.map((r) => [
        fmtDateLong(r.class_date) || '—',
        r.subject || '—',
        sdPill(r.status),
        r.marker?.full_name || '—',
        r.archived ? sdEl('span', 'sd-pill archived', 'Archived') : '',
      ]),
      true,
    ));
  }

  // Staff/admin equivalent of openStudentDetail above — reuses the same
  // modal and sdEl/sdSection/sdTable helpers, just with different
  // sections: the classes on this account's weekly schedule (see "My
  // Classes"), and the announcements they've posted (see the
  // Announcements tab). Read-only, same as the student view.
  async function openStaffDetail(p) {
    const token = ++studentDetailToken;
    const body = document.getElementById('studentDetailBody');
    const displayName = p.full_name || p.email || 'Staff';
    document.getElementById('studentDetailTitle').textContent = displayName;
    document.getElementById('studentDetailAvatar').textContent = displayName.trim().charAt(0).toUpperCase();
    document.getElementById('studentDetailSub').textContent = [displayRoleLabel(p), p.email].filter(Boolean).join(' · ');
    body.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line" style="width:60%;"></div>';
    openModal('studentDetailModal');

    const [scheduleRes, annRes] = await Promise.all([
      supabaseClient.from('staff_class_schedule').select('day_of_week, course_code').eq('staff_id', p.id),
      supabaseClient
        .from('announcements')
        .select('id, title, message, audience, course_code, created_at')
        .eq('created_by', p.id)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    if (token !== studentDetailToken) return; // closed or switched to someone else meanwhile

    body.innerHTML = '';
    body.scrollTop = 0;

    // ---- Classes ----
    const classesSection = sdSection('Classes');
    body.appendChild(classesSection);
    if (scheduleRes.error) {
      console.error('Loading staff schedule failed:', scheduleRes.error);
      classesSection.appendChild(sdEl('p', 'sd-note', 'Could not load this account\u2019s classes.'));
    } else {
      const byDay = new Map();
      (scheduleRes.data || []).forEach((row) => {
        if (!row.course_code) return;
        const list = byDay.get(row.day_of_week) || [];
        list.push(row.course_code);
        byDay.set(row.day_of_week, list);
      });
      if (!byDay.size) {
        classesSection.appendChild(sdEl('p', 'sd-note', 'No classes set up on this account\u2019s schedule yet.'));
      } else {
        classesSection.appendChild(sdTable(
          ['Day', 'Classes'],
          WEEKDAYS.filter(({ day }) => byDay.has(day)).map(({ day, label }) => [label, byDay.get(day).map(courseLabel).join(', ')]),
        ));
      }
    }

    // ---- Announcements ----
    const annSection = sdSection('Announcements');
    body.appendChild(annSection);
    if (annRes.error) {
      console.error('Loading staff announcements failed:', annRes.error);
      annSection.appendChild(sdEl('p', 'sd-note', 'Could not load announcements.'));
      return;
    }
    const anns = annRes.data || [];
    if (!anns.length) {
      annSection.appendChild(sdEl('p', 'sd-note', 'No announcements posted yet.'));
      return;
    }
    annSection.appendChild(sdTable(
      ['Date', 'Audience', 'Title', 'Message'],
      anns.map((a) => [
        fmtDate(a.created_at) || '—',
        a.audience === 'everyone' ? 'Everyone' :
          a.audience === 'all_students' ? 'All students' :
          a.audience === 'staff' ? 'Staff only' : courseLabel(a.course_code),
        a.title,
        a.message,
      ]),
      true,
    ));
  }

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
      // Only meaningful for admin-tier accounts — cleared for anyone
      // else so a title can't linger on a demoted account.
      job_title: newRole === 'admin' ? (document.getElementById('studentJobTitleSelect').value || null) : null,
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

  /* ---------------- My Classes (weekly schedule) ---------------- */

  async function loadMySchedule() {
    const { data, error } = await supabaseClient
      .from('staff_class_schedule')
      .select('day_of_week, course_code')
      .eq('staff_id', currentUserId);

    mySchedule = new Map();
    myPriorityCourses = new Set();
    if (error) {
      console.error('Loading your class schedule failed:', error);
    } else {
      (data || []).forEach((row) => {
        if (row.course_code) {
          const list = mySchedule.get(row.day_of_week) || [];
          list.push(row.course_code);
          mySchedule.set(row.day_of_week, list);
          myPriorityCourses.add(row.course_code);
        }
      });
    }

    renderMyClassesForm();
    renderScheduleQuickPicks('timetableQuickPicks', 'timetableQuickPicksCard', (courseCode) => {
      const select = document.getElementById('timetableCourseSelect');
      select.value = courseCode;
      syncCourseSelectDisplay(select);
      renderTimetableRows(courseCode);
    });
    renderScheduleQuickPicks('attendanceQuickPicks', null, (courseCode) => {
      const select = document.getElementById('attendanceCourseSelect');
      select.value = courseCode;
      syncCourseSelectDisplay(select);
      onAttendanceCourseChange(courseCode);
    });

    // First time the schedule loads on this page view, and nothing's
    // been picked on the Attendance tab yet: default it to today's
    // class so a lecturer landing there doesn't have to pick it
    // themselves every morning. Doesn't fight with a manual choice
    // made later in the session.
    const attendanceSelect = document.getElementById('attendanceCourseSelect');
    if (!attendanceSelect.value && todaysScheduledCourse()) {
      attendanceSelect.value = todaysScheduledCourse();
      syncCourseSelectDisplay(attendanceSelect);
      onAttendanceCourseChange(attendanceSelect.value);
    }
  }

  // Renders one chip per distinct course in mySchedule (deduped —
  // teaching the same course on three different days only needs one
  // quick-pick for it, not three). `cardId`, if given, is a wrapping
  // card that stays hidden while nobody has any classes set up yet.
  function renderScheduleQuickPicks(containerId, cardId, onPick) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    const card = cardId ? document.getElementById(cardId) : null;

    if (!myPriorityCourses.size) {
      if (card) { card.hidden = true; return; }
      const empty = document.createElement('span');
      empty.className = 'chip chip-empty';
      empty.textContent = 'No classes set up yet — see "My Classes".';
      container.appendChild(empty);
      return;
    }
    if (card) card.hidden = false;

    [...myPriorityCourses].forEach((code) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = courseNameFor(code);
      chip.addEventListener('click', () => onPick(code));
      container.appendChild(chip);
    });
  }

  function buildDayCourseSelect(value) {
    const select = document.createElement('select');
    const noClassOpt = document.createElement('option');
    noClassOpt.value = '';
    noClassOpt.textContent = '-- No class --';
    select.appendChild(noClassOpt);
    // Staff isn't a real course with a schedule of its own, same
    // reasoning as gradesCourseSelect/timetableCourseSelect above.
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
    select.value = value || '';
    return select;
  }

  // Adds one class pick (select + remove button) to a day's list,
  // inserted just before that day's "+ Add class" button. Removing the
  // last remaining pick on a day just clears it instead of deleting the
  // row, so every day always has at least one (possibly empty) pick to
  // choose a class in.
  function addClassPick(picksWrap, addBtn, value) {
    const pick = document.createElement('div');
    pick.className = 'day-schedule-pick';

    const select = buildDayCourseSelect(value);
    pick.appendChild(select);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'day-schedule-remove';
    removeBtn.setAttribute('aria-label', 'Remove this class');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      if (picksWrap.querySelectorAll('.day-schedule-pick').length > 1) {
        pick.remove();
      } else {
        select.value = '';
      }
    });
    pick.appendChild(removeBtn);

    picksWrap.insertBefore(pick, addBtn);
  }

  function renderMyClassesForm() {
    const wrap = document.getElementById('myClassesRows');
    wrap.innerHTML = '';

    const today = new Date().getDay();
    WEEKDAYS.forEach(({ day, label }) => {
      const row = document.createElement('div');
      row.className = 'day-schedule-row';
      if (day === today) row.classList.add('is-today');
      row.dataset.day = String(day);

      const dayLabel = document.createElement('span');
      dayLabel.className = 'day-label';
      dayLabel.textContent = label;
      if (day === today) {
        const todayTag = document.createElement('span');
        todayTag.className = 'day-label-today-tag';
        todayTag.textContent = 'Today';
        dayLabel.appendChild(todayTag);
      }
      row.appendChild(dayLabel);

      const picksWrap = document.createElement('div');
      picksWrap.className = 'day-schedule-picks';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'day-schedule-add';
      addBtn.textContent = '+ Add class';
      addBtn.addEventListener('click', () => addClassPick(picksWrap, addBtn, ''));
      picksWrap.appendChild(addBtn);

      const existing = mySchedule.get(day) || [];
      if (existing.length) {
        existing.forEach((code) => addClassPick(picksWrap, addBtn, code));
      } else {
        addClassPick(picksWrap, addBtn, '');
      }

      row.appendChild(picksWrap);
      wrap.appendChild(row);
    });
  }

  document.getElementById('myClassesSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('myClassesStatus');
    const btn = document.getElementById('myClassesSaveBtn');

    // One row per distinct (day, course) pick — a day can now have more
    // than one, so duplicate picks on the same day are deduped rather
    // than saved twice.
    const rows = [];
    document.querySelectorAll('#myClassesRows .day-schedule-row').forEach((row) => {
      const day = Number(row.dataset.day);
      const codes = new Set();
      row.querySelectorAll('select').forEach((select) => {
        if (select.value) codes.add(select.value);
      });
      codes.forEach((code) => rows.push({ staff_id: currentUserId, day_of_week: day, course_code: code }));
    });

    btn.disabled = true;
    setStatus(status, '', null);

    // A day can now hold several rows, so a plain upsert keyed on
    // (staff_id, day_of_week) can no longer tell "replace this day's
    // class" from "add another one alongside it" — replace the whole
    // set in one delete-then-insert instead. This requires the
    // staff_class_schedule table's unique constraint to be on
    // (staff_id, day_of_week, course_code) rather than just
    // (staff_id, day_of_week) — update that in Supabase if it hasn't
    // been already, or inserts here will fail.
    const { error: deleteError } = await supabaseClient
      .from('staff_class_schedule')
      .delete()
      .eq('staff_id', currentUserId);

    if (deleteError) {
      console.error('Clearing old class schedule failed:', deleteError);
      setStatus(status, 'Could not save your classes. Please try again.', 'error');
      btn.disabled = false;
      return;
    }

    if (rows.length) {
      const { error: insertError } = await supabaseClient
        .from('staff_class_schedule')
        .insert(rows);

      if (insertError) {
        console.error('Saving class schedule failed:', insertError);
        setStatus(status, 'Could not save your classes. Please try again.', 'error');
        btn.disabled = false;
        return;
      }
    }

    btn.disabled = false;
    setStatus(status, 'Saved.', 'success');
    toast('Your classes have been saved.', 'success');
    await loadMySchedule();
    // Both feed off myPriorityCourses/mySchedule, so refresh right
    // away rather than waiting for the next search keystroke.
    renderStudents();
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

  // Admins can post a course-specific announcement to any course, so
  // they get the full picker. Lecturers can only post to a single
  // course/class (see restrictAnnouncementAudienceForStaff below), and
  // that class has to be one of theirs — otherwise the picker still
  // listed every course in the institute, which didn't match what the
  // RLS policy actually allows them to publish. `keepCode`, when
  // editing an existing announcement, keeps that announcement's course
  // selectable even if it's since dropped off the lecturer's schedule
  // (so they don't lose sight of what they're editing) without adding
  // it to the picker for a brand-new announcement.
  //
  // "Staff" is left off the picker for everyone, admins included —
  // it isn't a real course with students on it, and staff already
  // have their own "Staff only" audience option above for that.
  //
  // Starts on a blank, disabled placeholder rather than defaulting to
  // whatever course happens to sort first, so picking a course is a
  // real choice — the submit handler's "Choose a course…" check (below)
  // only ever fires because this can now actually be left blank.
  function buildAnnouncementCourseOptions(keepCode) {
    const select = document.getElementById('announcementCourse');
    const hint = document.getElementById('announcementCourseHint');
    select.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = '-- Select a course --';
    select.appendChild(placeholder);

    const withoutStaff = COURSES.filter((g) => g.label !== 'Staff');
    const groups = currentUserIsAdmin ? withoutStaff : (() => {
      const allowed = new Set(myPriorityCourses);
      if (keepCode) allowed.add(keepCode);
      return withoutStaff
        .map((group) => ({ label: group.label, options: group.options.filter((opt) => allowed.has(opt.value)) }))
        .filter((group) => group.options.length);
    })();

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

    if (hint) hint.hidden = currentUserIsAdmin || groups.some((g) => g.options.length);
  }

  // Lecturers (staff, not admin) can only post to a single course/class —
  // everything wider (all students, staff only, everyone) stays
  // admin/root territory. A UX-layer lock like the role select above;
  // the real gate is the announcements RLS policy.
  function restrictAnnouncementAudienceForStaff() {
    if (currentUserIsAdmin) return;
    [...announcementAudience.options].forEach((opt) => {
      if (opt.value !== 'course') opt.hidden = true;
    });
    announcementAudience.value = 'course';
    announcementAudience.disabled = true;
    document.getElementById('announcementAudienceHint').hidden = false;
  }

  function openAnnouncementModal(existing) {
    if (existing && !currentUserIsAdmin && existing.audience !== 'course') return; // see canManage above
    announcementForm.reset();
    document.getElementById('announcementId').value = existing ? existing.id : '';
    document.getElementById('announcementModalTitle').textContent = existing ? 'Edit announcement' : 'New announcement';
    buildAnnouncementCourseOptions(existing ? existing.course_code : '');
    if (existing) {
      announcementAudience.value = existing.audience;
      document.getElementById('announcementCourse').value = existing.course_code || '';
      document.getElementById('announcementTitle').value = existing.title;
      document.getElementById('announcementMessage').value = existing.message;
    } else if (!currentUserIsAdmin && todaysScheduledCourse()) {
      // Default to today's class, if this lecturer has one set up —
      // they can still pick a different one of their classes from the
      // course picker either way.
      document.getElementById('announcementCourse').value = todaysScheduledCourse();
    }
    restrictAnnouncementAudienceForStaff();
    syncCourseSelectDisplay(document.getElementById('announcementCourse'));
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
      .select('id, title, message, audience, course_code, created_at, created_by')
      .order('created_at', { ascending: false })
      .limit(50);

    list.innerHTML = '';
    if (error) { console.error('Loading announcements failed:', error); list.innerHTML = emptyState('Could not load announcements.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No announcements yet.'); return; }

    const posterIds = [...new Set(rows.map((a) => a.created_by).filter(Boolean))];
    // Role label ("Lecturer", "Admin", a job title) comes from the
    // shared fetchPosterLabels (also used by ticket/feedback lists,
    // which want role only) — full_name isn't part of that, so it's
    // fetched separately here and the two are combined below into
    // "Role Name" (e.g. "Lecturer Jane Doe") for this list specifically.
    const [posterLabels, posterNames] = await Promise.all([
      fetchPosterLabels(posterIds),
      posterIds.length
        ? supabaseClient.from('profiles').select('id, full_name').in('id', posterIds)
            .then(({ data }) => new Map((data || []).map((p) => [p.id, p.full_name])))
        : Promise.resolve(new Map()),
    ]);

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

      const posterText = [posterLabels.get(a.created_by), posterNames.get(a.created_by)].filter(Boolean).join(' ');
      if (posterText) {
        const posterSpan = document.createElement('span');
        posterSpan.className = 'badge badge-admin';
        posterSpan.textContent = posterText;
        meta.appendChild(posterSpan);
      }

      headText.append(title, meta);
      headMain.append(recordIcon('bell'), headText);
      head.appendChild(headMain);

      const body = document.createElement('div');
      body.className = 'record-body';
      body.textContent = a.message;

      item.append(head, body);

      // Lecturers can only manage 'course' audience announcements
      // (the RLS policy enforces this too) — for anything wider,
      // show it read-only rather than an Edit/Delete that would
      // just fail server-side.
      const canManage = currentUserIsAdmin || a.audience === 'course';
      if (canManage) {
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
        item.appendChild(actions);
      }

      list.appendChild(item);
    });
  }

  /* ---------------- Timetable ---------------- */
  let currentTimetableCourse = null;
  let allTimetableEntries = []; // last fetch, merged with every course in COURSES so gaps show up
  let currentTimetableFilter = null;
  const timetableModal = document.getElementById('timetableModal');
  const timetableForm = document.getElementById('timetableForm');

  // Same OCR/editable-table pattern as admin.js's Timetable tab — see
  // the comments there for how the extraction and export pieces work.
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

  function openTimetableModal(existing, courseCodeForNew) {
    currentTimetableCourse = existing ? existing.course_code : courseCodeForNew;
    timetableForm.reset();
    document.getElementById('timetableEntryId').value = existing ? existing.id : '';
    document.getElementById('timetableModalTitle').textContent = existing ? 'Edit entry' : 'New timetable entry';
    document.getElementById('timetableOcrBtn').hidden = true;
    document.getElementById('timetableOcrProgress').textContent = '';
    hideTimetableEditor();
    if (existing) {
      document.getElementById('timetableFileUrl').value = existing.file_url || '';
      document.getElementById('timetableFileName').value = existing.file_name || '';
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
  document.getElementById('timetableModalClose').addEventListener('click', () => timetableModal.hidden = true);

  document.getElementById('timetableFileUpload').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    document.getElementById('timetableOcrBtn').hidden = !file;
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

  document.getElementById('timetableOpenInTabBtn').addEventListener('click', () => {
    if (!timetableEditorHandle) return;
    TimetableEditor.openTimetablePopup(timetableEditorHandle.getRows(), timetableEntryTitle(), 'edit', (newRows) => {
      timetableEditorHandle.setRows(newRows);
      currentTimetableTableData = newRows;
    });
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

    const tableData = timetableEditorHandle ? timetableEditorHandle.getRows() : null;
    const displayMode = document.getElementById('timetableDisplayModeTable').checked ? 'table' : 'image';

    const payload = {
      course_code: currentTimetableCourse,
      file_url: fileUrl,
      file_name: fileName,
      table_data: tableData,
      display_mode: tableData ? displayMode : 'image',
    };

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
    loadAllTimetables();
    loadOverview();
    markUploadedTimetableCourses();
  });

  async function loadAllTimetables() {
    const tbody = document.getElementById('timetableTableBody');
    tbody.innerHTML = '<tr><td colspan="4"><div class="skeleton skeleton-line"></div></td></tr>';

    const { data, error } = await supabaseClient
      .from('timetable')
      .select('id, course_code, file_name, file_url, updated_at, table_data, display_mode');

    if (error) {
      console.error('Loading timetable failed:', error);
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Could not load timetable.</td></tr>';
      return;
    }

    const byCourse = new Map((data || []).map((row) => [row.course_code, row]));
    // Every real course (Staff excluded — it has no class schedule),
    // whether or not it has a timetable yet, so a missing one shows up
    // as its own row instead of just being absent from the list.
    allTimetableEntries = COURSES.filter((g) => g.label !== 'Staff').flatMap((group) =>
      group.options.map((opt) => byCourse.get(opt.value) || { id: null, course_code: opt.value, file_name: null, file_url: null, updated_at: null })
    );

    renderTimetableRows(currentTimetableFilter);
  }

  function renderTimetableRows(filterCode) {
    currentTimetableFilter = filterCode || null;
    const tbody = document.getElementById('timetableTableBody');
    const hint = document.getElementById('timetableFilterHint');
    const showAllBtn = document.getElementById('timetableShowAllBtn');
    showAllBtn.hidden = !currentTimetableFilter;

    const rows = currentTimetableFilter
      ? allTimetableEntries.filter((e) => e.course_code === currentTimetableFilter)
      : allTimetableEntries;

    if (currentTimetableFilter) {
      hint.textContent = `Showing ${courseLabel(currentTimetableFilter)} (${currentTimetableFilter}).`;
    } else {
      const missingCount = allTimetableEntries.filter((e) => !e.file_url).length;
      hint.textContent = `Showing every course (${allTimetableEntries.length}) — ${missingCount} missing a timetable.`;
    }

    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No matching course.</td></tr>';
      return;
    }
    rows.forEach((entry) => tbody.appendChild(renderTimetableRow(entry)));
  }

  document.getElementById('timetableShowAllBtn').addEventListener('click', () => {
    const select = document.getElementById('timetableCourseSelect');
    select.value = '';
    syncCourseSelectDisplay(select);
    renderTimetableRows(null);
  });

  function renderTimetableRow(entry) {
    const tr = document.createElement('tr');

    const courseTd = document.createElement('td');
    courseTd.dataset.label = 'Course';
    courseTd.textContent = `${courseLabel(entry.course_code)} (${entry.course_code})`;
    tr.appendChild(courseTd);

    const fileTd = document.createElement('td');
    fileTd.dataset.label = 'Timetable';
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
      if (entry.table_data && entry.table_data.length) {
        const modeBadge = document.createElement('span');
        modeBadge.className = 'badge ' + (entry.display_mode === 'table' ? 'badge-verified' : 'badge-course');
        modeBadge.style.marginLeft = '8px';
        modeBadge.textContent = entry.display_mode === 'table' ? 'Table' : 'Image';
        fileTd.appendChild(modeBadge);
      }
    } else {
      const badge = document.createElement('span');
      badge.className = 'badge badge-inactive';
      badge.textContent = 'Missing';
      fileTd.appendChild(badge);
    }
    tr.appendChild(fileTd);

    const updatedTd = document.createElement('td');
    updatedTd.dataset.label = 'Updated';
    updatedTd.textContent = entry.updated_at ? fmtDate(entry.updated_at) : '—';
    tr.appendChild(updatedTd);

    const actionsTd = document.createElement('td');
    actionsTd.dataset.label = '';
    if (entry.id) {
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
        loadAllTimetables();
        loadOverview();
        markUploadedTimetableCourses();
      });
      actionsTd.append(editBtn, deleteBtn);
    } else {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-sm';
      addBtn.textContent = 'Add';
      addBtn.addEventListener('click', () => openTimetableModal(null, entry.course_code));
      actionsTd.appendChild(addBtn);
    }
    tr.appendChild(actionsTd);

    return tr;
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
     Uploaded per department rather than per specific course (see
     departmentFor()/DEPARTMENTS above) — several courses in the same
     department share the same textbooks/links, so one upload covers
     everyone in that department instead of needing one per course. */
  let currentResourceFilter = '';
  let currentAllResources = [];
  const resourceModal = document.getElementById('resourceModal');
  const resourceForm = document.getElementById('resourceForm');

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
      // Storage keys — unlike the department name shown in the UI,
      // spaces/slashes cause path issues, so slugify it here only.
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

    const payload = { department, title, author, file_url: fileUrl };
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

  async function loadResources(department) {
    currentResourceFilter = department || '';
    const list = document.getElementById('resourcesList');
    list.innerHTML = '';

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

  // While the search box has text in it, results come from here instead —
  // matched by name/ID across every course, not just the one picked above.
  // Null means "not searching"; an array (possibly empty) means a search
  // has completed. Cleared back to null when the box is emptied.
  let gradesSearchStudents = null;
  let gradesSearchByStudent = new Map();
  let gradesSearchDebounce = null;

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
        .select('id, full_name, student_id, course_code')
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

  // Cross-course search — a name or student ID could belong to a student
  // on any course, so this ignores gradesCourseSelect entirely rather
  // than filtering within whatever course happens to be picked. Grades
  // for each match still come back scoped to that student's own course,
  // via renderStudentGradeBlock/renderGradeSubjectRow's courseCode param.
  async function runGradesSearch(query) {
    const tbody = document.getElementById('gradesTbody');
    tbody.innerHTML = '<tr><td colspan="8"><div class="skeleton skeleton-line"></div></td></tr>';

    const escaped = query.replace(/[%,]/g, '');
    const { data: students, error } = await supabaseClient
      .from('profiles')
      .select('id, full_name, student_id, course_code')
      .eq('role', 'student')
      .or(`full_name.ilike.%${escaped}%,student_id.ilike.%${escaped}%`)
      .order('full_name');

    // The box may have been cleared or retyped while this was in flight —
    // only apply a result if it's still the query currently in the box.
    if (document.getElementById('gradesSearch').value.trim() !== query) return;

    if (error) {
      console.error('Searching students failed:', error);
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Could not search students.</td></tr>';
      return;
    }

    gradesSearchStudents = students || [];
    gradesSearchByStudent = new Map();
    if (gradesSearchStudents.length) {
      const ids = gradesSearchStudents.map((s) => s.id);
      const { data: grades, error: gradesError } = await supabaseClient
        .from('grades')
        .select('id, student_id, subject, attendance, class_work, home_work, examination, total_grade, gpa, letter_grade')
        .in('student_id', ids)
        .order('subject');
      if (gradesError) console.error('Loading grades for search results failed:', gradesError);
      (grades || []).forEach((g) => {
        if (!gradesSearchByStudent.has(g.student_id)) gradesSearchByStudent.set(g.student_id, []);
        gradesSearchByStudent.get(g.student_id).push(g);
      });
    }
    renderGradesTable();
  }

  // Re-loads whichever view is currently on screen after a save/remove —
  // the search results if the box has text, otherwise the picked course.
  function reloadGradesView() {
    const q = document.getElementById('gradesSearch').value.trim();
    if (q) runGradesSearch(q);
    else loadGrades(currentGradesCourse);
  }

  function renderGradesTable() {
    const tbody = document.getElementById('gradesTbody');
    tbody.innerHTML = '';

    const q = document.getElementById('gradesSearch').value.trim();
    const searching = q.length > 0;
    if (searching && gradesSearchStudents === null) return; // search in flight; skeleton is already showing

    const students = searching ? gradesSearchStudents : currentGradesStudents;
    const byStudent = searching ? gradesSearchByStudent : currentGradesByStudent;

    if (!students.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${searching ? 'No matching students.' : 'No students are on this course yet.'}</td></tr>`;
      return;
    }

    students.forEach((s) => renderStudentGradeBlock(s, byStudent.get(s.id) || [], {
      showCourse: searching,
      courseCode: s.course_code || currentGradesCourse,
    }));
  }

  function renderStudentGradeBlock(student, existingRows, options) {
    const courseCode = (options && options.courseCode) || currentGradesCourse;
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

    // Only shown for cross-course search results — in the normal
    // course-scoped view every row is already on the picked course, so
    // this would just repeat the same tag on every row for no reason.
    if (options && options.showCourse) {
      const courseBadge = document.createElement('span');
      courseBadge.className = 'badge badge-course';
      courseBadge.textContent = courseNameFor(courseCode);
      idBlock.appendChild(courseBadge);
    }

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
      const tr = renderGradeSubjectRow(student, existing, courseCode);
      anchor.el.insertAdjacentElement('afterend', tr);
      anchor.el = tr;
    });

    addBtn.addEventListener('click', () => {
      const tr = renderGradeSubjectRow(student, null, courseCode);
      anchor.el.insertAdjacentElement('afterend', tr);
      anchor.el = tr;
      tr.querySelector('input[type="text"]').focus();
    });
  }

  function renderGradeSubjectRow(student, existing, courseCode) {
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
        course_code: courseCode,
        course_name: courseNameFor(courseCode),
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
      reloadGradesView();
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
      reloadGradesView();
    });

    actionsTd.append(saveBtn, removeBtn);
    tr.appendChild(actionsTd);

    return tr;
  }

  document.getElementById('gradesCourseSelect').addEventListener('change', (e) => loadGrades(e.target.value));
  document.getElementById('gradesRefresh').addEventListener('click', () => reloadGradesView());
  document.getElementById('gradesSearch').addEventListener('input', () => {
    const q = document.getElementById('gradesSearch').value.trim();
    clearTimeout(gradesSearchDebounce);
    if (!q) {
      gradesSearchStudents = null;
      gradesSearchByStudent = new Map();
      renderGradesTable();
      return;
    }
    gradesSearchDebounce = setTimeout(() => runGradesSearch(q), 300);
  });

  /* ---------------- Attendance ----------------
     A real day-by-day present/absent/late tracker — separate from the
     Attendance *number* on the Input Grades tab (that one's a
     per-subject score staff type in themselves; this one is a daily
     mark per student, one row per (student, course, subject, date) —
     the same class can be marked separately for each subject taught
     on it). */

  const ATTENDANCE_STATUSES = [
    { value: 'present', label: 'Present' },
    { value: 'absent', label: 'Absent' },
    { value: 'late', label: 'Late' },
  ];

  let currentAttendanceCourse = '';
  let currentAttendanceSubject = '';
  let currentAttendanceDate = '';
  let currentAttendanceStudents = [];
  let currentAttendanceMarks = new Map(); // student_id -> status

  const attendanceSubjectInput = document.getElementById('attendanceSubject');
  wireSubjectFormatting(attendanceSubjectInput);

  // Datalist of subjects already used for the selected course, so a
  // subject only has to be typed out in full once — after that it's a
  // "quick complete" pick from the list for every date going forward.
  // Seeded from both this class's existing attendance rows and its
  // Input Grades subjects (which are usually entered first), then
  // topped up with whatever gets saved here in this session.
  async function refreshAttendanceSubjectOptions(courseCode) {
    const list = document.getElementById('attendanceSubjectList');
    list.innerHTML = '';
    if (!courseCode) return;

    const [attendanceRes, gradesRes] = await Promise.all([
      supabaseClient.from('attendance').select('subject').eq('course_code', courseCode),
      supabaseClient.from('grades').select('subject').eq('course_code', courseCode),
    ]);
    if (attendanceRes.error) console.error('Loading attendance subjects failed:', attendanceRes.error);
    if (gradesRes.error) console.error('Loading grade subjects failed:', gradesRes.error);

    const subjects = new Set();
    (attendanceRes.data || []).forEach((r) => { if (r.subject) subjects.add(r.subject); });
    (gradesRes.data || []).forEach((r) => { if (r.subject) subjects.add(r.subject); });

    [...subjects].sort((a, b) => a.localeCompare(b)).forEach((subject) => {
      const option = document.createElement('option');
      option.value = subject;
      list.appendChild(option);
    });
  }

  // Adds a freshly-saved subject to the datalist immediately, so it's
  // available to "quick complete" right away rather than only after
  // switching courses and back.
  function addAttendanceSubjectOption(subject) {
    const list = document.getElementById('attendanceSubjectList');
    if ([...list.options].some((o) => o.value === subject)) return;
    const option = document.createElement('option');
    option.value = subject;
    list.appendChild(option);
  }

  // Fires whenever the selected class changes — from the dropdown, a
  // quick pick, or the "today's class" default. A new class means a
  // different set of subjects, so the subject field is cleared rather
  // than carrying over a subject that may not apply here.
  function onAttendanceCourseChange(courseCode) {
    attendanceSubjectInput.value = '';
    refreshAttendanceSubjectOptions(courseCode);
    loadAttendance(courseCode, document.getElementById('attendanceDate').value, '');
    loadAttendanceOverview(courseCode);
  }

  function todayIso() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // Parsed as a local date (not via `new Date(dateStr)`, which reads
  // yyyy-mm-dd as UTC midnight and can print the wrong weekday for
  // anyone west of UTC) so it always matches the day shown in the
  // native date picker next to it.
  function weekdayLabel(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return '';
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long' });
  }
  // Same local-date parsing as weekdayLabel above, but spells the
  // month and includes the year in full — "16 September 2026" — for
  // the Attendance overview table, rather than the short "Sep 16,
  // 2026" style fmtDate() uses elsewhere.
  function fmtDateLong(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return '';
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function updateAttendanceDateWeekday() {
    document.getElementById('attendanceDateWeekday').textContent =
      weekdayLabel(document.getElementById('attendanceDate').value);
  }
  document.getElementById('attendanceDate').value = todayIso();
  updateAttendanceDateWeekday();

  async function loadAttendance(courseCode, dateStr, subject) {
    currentAttendanceCourse = courseCode || '';
    currentAttendanceSubject = subject != null ? subject : attendanceSubjectInput.value.trim();
    currentAttendanceDate = dateStr || todayIso();
    document.getElementById('attendanceDate').value = currentAttendanceDate;
    updateAttendanceDateWeekday();

    const tbody = document.getElementById('attendanceTbody');
    const summary = document.getElementById('attendanceSummary');
    currentAttendanceStudents = [];
    currentAttendanceMarks = new Map();

    if (!currentAttendanceCourse) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Select a course to take attendance.</td></tr>';
      summary.hidden = true;
      summary.innerHTML = '';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="3"><div class="skeleton skeleton-line"></div></td></tr>';

    // The class list only depends on the course, so it loads as soon
    // as one is picked — marking can start right away. Only the
    // existing-marks lookup needs a subject too (a mark without one
    // has nowhere to be saved), so that query is skipped until a
    // subject is entered, rather than holding up the whole roster.
    const [studentsRes, attendanceRes] = await Promise.all([
      supabaseClient
        .from('profiles')
        .select('id, full_name, student_id')
        .eq('course_code', currentAttendanceCourse)
        .eq('role', 'student')
        .order('full_name'),
      currentAttendanceSubject
        ? supabaseClient
            .from('attendance')
            .select('student_id, status')
            .eq('course_code', currentAttendanceCourse)
            .eq('subject', currentAttendanceSubject)
            .eq('class_date', currentAttendanceDate)
            .eq('archived', false)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (studentsRes.error) {
      console.error('Loading students for attendance failed:', studentsRes.error);
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Could not load students.</td></tr>';
      return;
    }
    if (attendanceRes.error) console.error('Loading existing attendance failed:', attendanceRes.error);

    currentAttendanceStudents = studentsRes.data || [];
    (attendanceRes.data || []).forEach((row) => currentAttendanceMarks.set(row.student_id, row.status));

    renderAttendanceTable();
  }

  function updateAttendanceSummary() {
    const summary = document.getElementById('attendanceSummary');
    const total = currentAttendanceStudents.length;

    if (!total) {
      summary.hidden = true;
      summary.innerHTML = '';
      return;
    }

    const marked = currentAttendanceMarks.size;
    const present = [...currentAttendanceMarks.values()].filter((s) => s === 'present').length;
    const absent = [...currentAttendanceMarks.values()].filter((s) => s === 'absent').length;
    const late = [...currentAttendanceMarks.values()].filter((s) => s === 'late').length;

    const courseSelect = document.getElementById('attendanceCourseSelect');
    const courseLabel = courseSelect.selectedIndex >= 0
      ? (courseSelect.options[courseSelect.selectedIndex].textContent || '').trim()
      : '';

    summary.innerHTML = '';

    const left = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'attendance-summary-title';
    title.textContent = currentAttendanceSubject
      ? `${currentAttendanceSubject} — ${courseLabel || 'Attendance'}`
      : (courseLabel || 'Attendance');
    const markedNote = document.createElement('span');
    markedNote.className = 'attendance-summary-marked';
    markedNote.textContent = `${marked} of ${total} marked · ${fmtDate(currentAttendanceDate)}`;
    left.append(title, markedNote);

    const counts = document.createElement('div');
    counts.className = 'attendance-summary-counts';
    [
      ['badge-verified', `${present} present`],
      ['badge-inactive', `${absent} absent`],
      ['badge-grade-c', `${late} late`],
    ].forEach(([cls, text]) => {
      const badge = document.createElement('span');
      badge.className = `badge ${cls}`;
      badge.textContent = text;
      counts.appendChild(badge);
    });

    summary.append(left, counts);
    summary.hidden = false;
  }

  function renderAttendanceTable() {
    const tbody = document.getElementById('attendanceTbody');
    tbody.innerHTML = '';

    if (!currentAttendanceStudents.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No students are on this course yet.</td></tr>';
      updateAttendanceSummary();
      return;
    }

    currentAttendanceStudents.forEach((student) => {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = student.full_name || '—';
      tr.appendChild(nameTd);

      const idTd = document.createElement('td');
      idTd.textContent = student.student_id || '—';
      tr.appendChild(idTd);

      const statusTd = document.createElement('td');
      const group = document.createElement('div');
      group.className = 'attendance-status-group';

      ATTENDANCE_STATUSES.forEach(({ value, label }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `attendance-status-btn ${value}` + (currentAttendanceMarks.get(student.id) === value ? ' active' : '');
        btn.textContent = label;
        btn.addEventListener('click', () => {
          currentAttendanceMarks.set(student.id, value);
          group.querySelectorAll('.attendance-status-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          updateAttendanceSummary();
        });
        group.appendChild(btn);
      });

      statusTd.appendChild(group);
      tr.appendChild(statusTd);
      tbody.appendChild(tr);
    });

    updateAttendanceSummary();
  }

  document.getElementById('attendanceCourseSelect').addEventListener('change', (e) =>
    onAttendanceCourseChange(e.target.value)
  );
  // 'change' (not 'input') so this fires once the subject is settled —
  // picked from the datalist, or typed and left — rather than on every
  // keystroke while formatting is still happening.
  attendanceSubjectInput.addEventListener('change', () => {
    loadAttendance(currentAttendanceCourse, document.getElementById('attendanceDate').value, attendanceSubjectInput.value.trim());
  });
  document.getElementById('attendanceDate').addEventListener('change', (e) =>
    loadAttendance(currentAttendanceCourse, e.target.value, currentAttendanceSubject)
  );
  document.getElementById('attendanceRefresh').addEventListener('click', () =>
    loadAttendance(document.getElementById('attendanceCourseSelect').value, document.getElementById('attendanceDate').value, attendanceSubjectInput.value.trim())
  );

  document.getElementById('attendanceSaveAll').addEventListener('click', async () => {
    const status = document.getElementById('attendanceStatus');
    const btn = document.getElementById('attendanceSaveAll');

    if (!currentAttendanceCourse) { setStatus(status, 'Select a course first.', 'error'); return; }
    if (!currentAttendanceSubject) { setStatus(status, 'Enter a subject first.', 'error'); return; }
    if (!currentAttendanceMarks.size) { setStatus(status, 'Mark at least one student before saving.', 'error'); return; }

    const rows = [...currentAttendanceMarks.entries()].map(([studentId, markStatus]) => ({
      student_id: studentId,
      course_code: currentAttendanceCourse,
      subject: currentAttendanceSubject,
      class_date: currentAttendanceDate,
      status: markStatus,
      marked_by: currentUserId,
      // Explicit, not just relying on the column default — an upsert
      // only touches columns it's given, so if this date/subject was
      // previously archived, re-marking it here needs to say so
      // itself or the old row would silently stay archived.
      archived: false,
      archived_at: null,
    }));

    btn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient
      .from('attendance')
      .upsert(rows, { onConflict: 'student_id,course_code,subject,class_date' });

    btn.disabled = false;

    if (error) {
      console.error('Saving attendance failed:', error);
      // 23505 (unique_violation) here almost always means the table's
      // constraint doesn't match this upsert's onConflict target (e.g.
      // an old, pre-subject constraint is still sitting alongside the
      // new one) — that's a schema issue, not something re-clicking
      // Save fixes, so say so rather than the generic message.
      const message = error.code === '23505'
        ? "Could not save — the attendance table's constraints need updating (contact your admin)."
        : 'Could not save attendance. Please try again.';
      setStatus(status, message, 'error');
      return;
    }

    const savedFor = `${currentAttendanceSubject} — ${fmtDate(currentAttendanceDate)}`;
    setStatus(status, `Attendance saved for ${savedFor}.`, 'success');
    toast(`Attendance saved for ${savedFor}.`, 'success');
    addAttendanceSubjectOption(currentAttendanceSubject);
    loadAttendanceOverview(currentAttendanceCourse);
  });

  /* ---------------- Attendance reset / archive ----------
     "Reset" (admin/root only) never deletes — it calls the
     archive_attendance() RPC, which flags matching rows as archived so
     they drop out of the register and the overview above but stay
     readable in the viewer below. The archived viewer itself is
     read-only and visible to ALL staff. See attendance-archive.sql for
     the RPC + archived column. */

  document.getElementById('attendanceResetBtn').addEventListener('click', async () => {
    if (!currentUserIsAdmin) return; // staff can view archives, not create them
    const status = document.getElementById('attendanceResetStatus');
    const btn = document.getElementById('attendanceResetBtn');
    const courseCode = document.getElementById('attendanceResetCourse').value || null;
    const dateFrom = document.getElementById('attendanceResetFrom').value || null;
    const dateTo = document.getElementById('attendanceResetTo').value || null;

    const courseLabel = courseCode
      ? document.getElementById('attendanceResetCourse').selectedOptions[0].textContent
      : 'every course';
    const rangeLabel = dateFrom || dateTo
      ? `from ${dateFrom ? fmtDate(dateFrom) : 'the beginning'} to ${dateTo ? fmtDate(dateTo) : 'now'}`
      : 'for all dates';
    if (!confirm(`Archive attendance for ${courseLabel}, ${rangeLabel}? Records are archived, not deleted — you'll still be able to view them below.`)) return;

    btn.disabled = true;
    setStatus(status, '', null);

    const { data, error } = await supabaseClient.rpc('archive_attendance', {
      p_course_code: courseCode,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    });

    btn.disabled = false;

    if (error) {
      console.error('Archiving attendance failed:', error);
      setStatus(status, 'Could not archive attendance. Please try again.', 'error');
      return;
    }

    setStatus(status, `Archived ${data} record${data === 1 ? '' : 's'}.`, 'success');
    toast(`Archived ${data} attendance record${data === 1 ? '' : 's'}.`, 'success');
    // Refresh whatever's currently on screen so the archived rows drop
    // out of view immediately rather than waiting for the next reload.
    if (currentAttendanceCourse) {
      loadAttendance(currentAttendanceCourse, currentAttendanceDate, currentAttendanceSubject);
      loadAttendanceOverview(currentAttendanceCourse);
    }
  });

  // Course code -> display label, for the per-week course filters.
  // Falls back to the raw code for anything not found (e.g. if a
  // record's course was since renamed or removed from COURSES).
  function courseLabel(code) {
    for (const group of COURSES) {
      const match = group.options.find((o) => o.value === code);
      if (match) return match.label;
    }
    return code;
  }

  // Monday-start week bucket for a class_date, with friendly labels
  // for the two most recent weeks and a date range for anything older.
  function weekBucketFor(dateStr) {
    const d = new Date(`${dateStr}T00:00:00`);
    const monday = new Date(d);
    monday.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const mondayIso = monday.toISOString().slice(0, 10);

    const now = new Date();
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() + (now.getDay() === 0 ? -6 : 1 - now.getDay()));
    const thisMondayIso = thisMonday.toISOString().slice(0, 10);
    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(thisMonday.getDate() - 7);
    const lastMondayIso = lastMonday.toISOString().slice(0, 10);

    let label;
    if (mondayIso === thisMondayIso) label = 'This week';
    else if (mondayIso === lastMondayIso) label = 'Last week';
    else label = `${fmtDateLong(mondayIso)} – ${fmtDateLong(sunday.toISOString().slice(0, 10))}`;

    return { key: mondayIso, label };
  }

  async function loadAttendanceArchive() {
    const container = document.getElementById('attendanceArchiveGroups');
    const dateFrom = document.getElementById('attendanceArchiveFrom').value || null;
    const dateTo = document.getElementById('attendanceArchiveTo').value || null;

    container.innerHTML = '<div class="card"><div class="skeleton skeleton-line"></div></div>';

    // Aliased ("student:"/"marker:") since both embeds point at
    // profiles via different foreign keys (student_id vs marked_by) —
    // without distinct aliases they'd collide under the same key.
    let query = supabaseClient
      .from('attendance')
      .select(`
        course_code, subject, class_date, status, archived_at,
        student:profiles!attendance_student_id_fkey(full_name, student_id),
        marker:profiles!attendance_marked_by_fkey(full_name)
      `)
      .eq('archived', true)
      .order('class_date', { ascending: false })
      .limit(1000);
    if (dateFrom) query = query.gte('class_date', dateFrom);
    if (dateTo) query = query.lte('class_date', dateTo);

    const { data, error } = await query;

    if (error) {
      console.error('Loading archived attendance failed:', error);
      container.innerHTML = '<div class="card empty-state">Could not load archived attendance.</div>';
      return;
    }

    const rows = data || [];
    if (!rows.length) {
      const filtered = !!(dateFrom || dateTo);
      container.innerHTML = `<div class="card empty-state">${filtered ? 'No archived records in that date range.' : 'No archived attendance yet.'}</div>`;
      return;
    }

    // Group by the week each record's class was held, newest week
    // first — courses within a week are filtered client-side (below)
    // once a group is opened, rather than re-querying per click.
    const weeks = new Map(); // key -> { label, rows: [] }
    rows.forEach((row) => {
      const { key, label } = weekBucketFor(row.class_date);
      if (!weeks.has(key)) weeks.set(key, { label, rows: [] });
      weeks.get(key).rows.push(row);
    });

    container.innerHTML = '';
    [...weeks.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .forEach(([key, week], i) => {
        container.appendChild(renderArchiveWeekGroup(key, week, i === 0));
      });
  }

  function renderArchiveWeekGroup(key, week, openByDefault) {
    const details = document.createElement('details');
    details.className = 'card archive-week-group';
    if (openByDefault) details.open = true;

    const summary = document.createElement('summary');
    const labelSpan = document.createElement('span');
    labelSpan.className = 'archive-week-label';
    labelSpan.innerHTML = `<strong>${week.label}</strong>`;
    const countSpan = document.createElement('span');
    countSpan.className = 'record-meta';
    countSpan.textContent = `${week.rows.length} record${week.rows.length === 1 ? '' : 's'}`;
    summary.append(labelSpan, countSpan);

    const body = document.createElement('div');
    body.className = 'archive-week-group-body';

    // Course filter, scoped to this one week — options are only the
    // courses that actually appear in this group, not the full list.
    const courses = [...new Set(week.rows.map((r) => r.course_code).filter(Boolean))]
      .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b)));

    const filterWrap = document.createElement('div');
    filterWrap.style.marginBottom = '12px';
    const filterLabel = document.createElement('label');
    filterLabel.textContent = 'Filter this week by course';
    const select = document.createElement('select');
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = `All courses (${week.rows.length})`;
    select.appendChild(allOption);
    courses.forEach((code) => {
      const option = document.createElement('option');
      option.value = code;
      const count = week.rows.filter((r) => r.course_code === code).length;
      option.textContent = `${courseLabel(code)} (${count})`;
      select.appendChild(option);
    });
    filterWrap.append(filterLabel, select);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    const table = document.createElement('table');
    table.className = 'admin-table';
    table.innerHTML = '<thead><tr><th>Name</th><th>Student ID</th><th>Course</th><th>Subject</th><th>Date</th><th>Status</th><th>Marked by</th><th>Archived on</th></tr></thead><tbody></tbody>';
    tableWrap.appendChild(table);

    function renderRows(courseFilter) {
      const tbody = table.querySelector('tbody');
      tbody.innerHTML = '';
      const filteredRows = courseFilter ? week.rows.filter((r) => r.course_code === courseFilter) : week.rows;
      filteredRows.forEach((row) => {
        const student = row.student || {};
        const tr = document.createElement('tr');
        [
          student.full_name || '—',
          student.student_id || '—',
          row.course_code || '—',
          row.subject || '—',
          fmtDate(row.class_date),
          row.status || '—',
          row.marker?.full_name || '—',
          row.archived_at ? fmtDate(row.archived_at) : '—',
        ].forEach((text) => {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
    select.addEventListener('change', () => renderRows(select.value));
    renderRows('');

    body.append(filterWrap, tableWrap);
    details.append(summary, body);
    return details;
  }

  document.getElementById('attendanceArchiveRefresh').addEventListener('click', loadAttendanceArchive);

  /* ---------------- Yearly attendance-archive prompt (admin only) ---
     Shown once per login (not repeated within the same page load) when
     unarchived records exist from over a year ago. "Not now" just
     closes it for this session — it's asked again next time there's
     something to ask about. */

  async function offerAttendanceArchivePrompt() {
    if (!currentUserIsAdmin) return; // archiving is admin/root only
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    const { data: count, error } = await supabaseClient.rpc('count_unarchived_attendance_older_than', { p_cutoff: cutoffIso });
    if (error) { console.error('Checking for old attendance failed:', error); return; }
    if (!count) return;

    const modal = document.getElementById('attendanceArchivePromptModal');
    document.getElementById('attendanceArchivePromptText').textContent =
      `You have ${count} attendance record${count === 1 ? '' : 's'} from over a year ago (before ${fmtDate(cutoffIso)}) that haven't been archived yet.`;
    setStatus(document.getElementById('attendanceArchivePromptStatus'), '', null);
    modal.hidden = false;

    document.getElementById('attendanceArchivePromptDismiss').onclick = () => { modal.hidden = true; };
    document.getElementById('attendanceArchivePromptConfirm').onclick = async () => {
      const status = document.getElementById('attendanceArchivePromptStatus');
      const confirmBtn = document.getElementById('attendanceArchivePromptConfirm');
      confirmBtn.disabled = true;
      const { data, error: archiveError } = await supabaseClient.rpc('archive_attendance', {
        p_course_code: null,
        p_date_from: null,
        p_date_to: cutoffIso,
      });
      confirmBtn.disabled = false;
      if (archiveError) {
        console.error('Archiving old attendance failed:', archiveError);
        setStatus(status, 'Could not archive. Please try again.', 'error');
        return;
      }
      toast(`Archived ${data} old attendance record${data === 1 ? '' : 's'}.`, 'success');
      modal.hidden = true;
      if (currentAttendanceCourse) {
        loadAttendance(currentAttendanceCourse, currentAttendanceDate, currentAttendanceSubject);
        loadAttendanceOverview(currentAttendanceCourse);
      }
    };
  }

  /* ---------------- Attendance overview ----------------
     A per-class rollup — every date recorded for the selected course,
     broken down by subject per student (so "Computer Programming" and
     "Data Structures" show as separate lines for the same student)
     rather than the single subject/date view above. Refreshes
     whenever the class changes or attendance is saved. */

  async function loadAttendanceOverview(courseCode) {
    const tbody = document.getElementById('attendanceOverviewTbody');
    if (!courseCode) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Select a course to see its attendance overview.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="9"><div class="skeleton skeleton-line"></div></td></tr>';

    const [studentsRes, attendanceRes] = await Promise.all([
      supabaseClient
        .from('profiles')
        .select('id, full_name, student_id')
        .eq('course_code', courseCode)
        .eq('role', 'student')
        .order('full_name'),
      supabaseClient
        .from('attendance')
        .select('student_id, subject, status, class_date, profiles!attendance_marked_by_fkey(full_name)')
        .eq('course_code', courseCode)
        .eq('archived', false),
    ]);

    if (studentsRes.error) {
      console.error('Loading students for attendance overview failed:', studentsRes.error);
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Could not load students.</td></tr>';
      return;
    }
    if (attendanceRes.error) console.error('Loading attendance overview failed:', attendanceRes.error);

    const students = studentsRes.data || [];
    // Keyed by "student_id||subject" rather than just student_id, so
    // each subject gets its own line instead of being folded into one
    // combined total per student. Rows with no subject (saved before
    // the subject column existed) land under "No subject".
    const bySubject = new Map(); // key -> { studentId, subject, present, absent, late, lastDate, lastMarkedBy }
    (attendanceRes.data || []).forEach((row) => {
      const subject = row.subject || 'No subject';
      const key = `${row.student_id}||${subject}`;
      if (!bySubject.has(key)) bySubject.set(key, { studentId: row.student_id, subject, present: 0, absent: 0, late: 0, lastDate: null, lastMarkedBy: null });
      const counts = bySubject.get(key);
      if (counts[row.status] != null) counts[row.status] += 1;
      // class_date sorts fine as a plain "yyyy-mm-dd" string, so the
      // latest date for this subject can just be tracked with a string
      // comparison rather than parsing dates on every row. Whoever
      // marked that latest date travels with it, same idea as
      // "Last recorded" — it's the most recent marker, not a list of
      // everyone who's ever touched this subject/student.
      if (row.class_date && (!counts.lastDate || row.class_date > counts.lastDate)) {
        counts.lastDate = row.class_date;
        counts.lastMarkedBy = row.profiles?.full_name || null;
      }
    });

    renderAttendanceOverviewTable(students, bySubject);
  }

  function renderAttendanceOverviewTable(students, bySubject) {
    const tbody = document.getElementById('attendanceOverviewTbody');
    tbody.innerHTML = '';

    if (!students.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No students are on this course yet.</td></tr>';
      return;
    }

    // Group this class's subject rows by student, in the same order as
    // the (name-sorted) student list, so a student's subjects stay
    // together rather than being interleaved with other students'.
    const rowsByStudent = new Map(students.map((s) => [s.id, []]));
    [...bySubject.values()]
      .sort((a, b) => a.subject.localeCompare(b.subject))
      .forEach((row) => {
        if (rowsByStudent.has(row.studentId)) rowsByStudent.get(row.studentId).push(row);
      });

    let rendered = false;
    students.forEach((student) => {
      const subjectRows = rowsByStudent.get(student.id) || [];
      if (!subjectRows.length) {
        appendAttendanceOverviewRow(tbody, student, { subject: 'No attendance yet', present: 0, absent: 0, late: 0, lastDate: null, lastMarkedBy: null }, true);
        rendered = true;
        return;
      }
      subjectRows.forEach((row, i) => {
        appendAttendanceOverviewRow(tbody, student, row, false, i === 0 ? subjectRows.length : 0);
        rendered = true;
      });
    });

    if (!rendered) tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No attendance recorded for this class yet.</td></tr>';
  }

  // rowSpanCount, when set on a student's first subject row, spans the
  // Name/Student ID cells down over all of that student's subject rows
  // so the name isn't repeated on every line.
  function appendAttendanceOverviewRow(tbody, student, row, isEmptyRow, rowSpanCount) {
    const total = row.present + row.absent + row.late;
    const pct = total ? Math.round((row.present / total) * 1000) / 10 : null;

    const tr = document.createElement('tr');

    if (rowSpanCount) {
      const nameTd = document.createElement('td');
      nameTd.textContent = student.full_name || '—';
      nameTd.rowSpan = rowSpanCount;
      const idTd = document.createElement('td');
      idTd.textContent = student.student_id || '—';
      idTd.rowSpan = rowSpanCount;
      tr.append(nameTd, idTd);
    }

    [
      row.subject,
      isEmptyRow ? '—' : String(row.present),
      isEmptyRow ? '—' : String(row.absent),
      isEmptyRow ? '—' : String(row.late),
      isEmptyRow || pct == null ? '—' : `${pct}%`,
      isEmptyRow || !row.lastDate ? '—' : fmtDateLong(row.lastDate),
      isEmptyRow || !row.lastMarkedBy ? '—' : row.lastMarkedBy,
    ].forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }

  document.getElementById('attendanceOverviewRefresh').addEventListener('click', () =>
    loadAttendanceOverview(document.getElementById('attendanceCourseSelect').value)
  );

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

  /* ---------------- Activity Log (admin only) ----------------
     Reads profile_change_log, which is written automatically by a
     database trigger whenever a profiles row changes (full name,
     student ID, course, verified status, role, job title) — not by
     this page. That's what lets it capture edits made by any staff
     account, not just the ones made through this dashboard, and why
     there's no client-side insert here. See the schema migration for
     the trigger and the admin-only RLS policy that gates SELECT. */
  async function loadActivityLog() {
    const list = document.getElementById('activityLogList');
    if (!currentUserIsAdmin) return;
    list.innerHTML = '<li class="empty-state">Loading…</li>';

    const { data, error } = await supabaseClient
      .from('profile_change_log')
      .select('id, target_id, changed_by, field, old_value, new_value, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('Loading activity log failed:', error);
      list.innerHTML = emptyState('Could not load the activity log.');
      return;
    }

    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No changes logged yet.'); return; }

    const ids = [...new Set(rows.flatMap((r) => [r.target_id, r.changed_by]).filter(Boolean))];
    const names = new Map();
    if (ids.length) {
      const { data: people } = await supabaseClient.from('profiles').select('id, full_name, email').in('id', ids);
      (people || []).forEach((p) => names.set(p.id, p.full_name || p.email || 'Unknown'));
    }

    const FIELD_LABELS = {
      full_name: 'name', student_id: 'student ID', course_code: 'course',
      verified: 'verified status', role: 'role', job_title: 'job title',
    };

    list.innerHTML = '';
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
      const changerName = names.get(r.changed_by) || 'Someone';
      const targetName = names.get(r.target_id) || 'this account';
      const fieldLabel = FIELD_LABELS[r.field] || r.field;
      title.textContent = `${changerName} changed ${targetName}'s ${fieldLabel}`;

      const meta = document.createElement('div');
      meta.className = 'record-meta';
      const dateSpan = document.createElement('span');
      dateSpan.textContent = new Date(r.created_at).toLocaleString();
      meta.appendChild(dateSpan);

      headText.append(title, meta);
      headMain.append(recordIcon('person'), headText);
      head.appendChild(headMain);

      const body = document.createElement('div');
      body.className = 'record-body';
      const fmt = (v) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));
      body.textContent = `${fmt(r.old_value)} → ${fmt(r.new_value)}`;

      item.append(head, body);
      list.appendChild(item);
    });
  }

  document.getElementById('activityLogRefresh').addEventListener('click', loadActivityLog);

  /* ---------------- Feedback ---------------- */

  // "Give feedback on a student" course picker — Staff left out, same
  // as every other course picker on this page (COURSES.filter above).
  populateCourseSelect(
    document.getElementById('studentFeedbackCourse'),
    COURSES.filter((g) => g.label !== 'Staff'),
    '-- Select a course --',
    true
  );
  enhanceCourseSelect(document.getElementById('studentFeedbackCourse'));

  async function loadStudentFeedbackStudents(courseCode) {
    const select = document.getElementById('studentFeedbackStudent');
    select.innerHTML = '';
    if (!courseCode) {
      select.innerHTML = '<option value="">-- Select a course first --</option>';
      return;
    }
    select.innerHTML = '<option value="">Loading…</option>';
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, full_name, student_id')
      .eq('course_code', courseCode)
      .eq('role', 'student')
      .order('full_name');

    if (error) {
      console.error('Loading students for feedback failed:', error);
      select.innerHTML = '<option value="">Could not load students</option>';
      return;
    }

    const rows = data || [];
    select.innerHTML = rows.length
      ? '<option value="">-- Select a student --</option>'
      : '<option value="">No students on this course</option>';
    rows.forEach((s) => {
      const option = document.createElement('option');
      option.value = s.id;
      option.textContent = s.full_name + (s.student_id ? ' (' + s.student_id + ')' : '');
      select.appendChild(option);
    });
  }
  document.getElementById('studentFeedbackCourse').addEventListener('change', (e) => loadStudentFeedbackStudents(e.target.value));

  // Admin-only: whether the *course/lecturer* feedback form (student
  // portal, home.js) is locked — read here purely to drive the admin
  // toggle card below, since that lock now lives on the other portal's
  // form, not this page's "Give feedback on a student" (which is always
  // open — see the field-hint on that form).
  let courseFeedbackLocked = false;

  async function refreshCourseFeedbackLockState() {
    const { data, error } = await supabaseClient
      .from('feedback_settings')
      .select('lecturer_feedback_locked')
      .eq('id', 1)
      .maybeSingle();
    if (error) { console.error('Loading feedback lock state failed:', error); return; }
    courseFeedbackLocked = !!(data && data.lecturer_feedback_locked);
  }

  document.getElementById('studentFeedbackForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('studentFeedbackStatus');
    const submitBtn = document.getElementById('studentFeedbackSubmit');

    const courseCode = document.getElementById('studentFeedbackCourse').value;
    const studentId = document.getElementById('studentFeedbackStudent').value;
    const rating = document.getElementById('studentFeedbackRating').value;
    const comments = document.getElementById('studentFeedbackComments').value.trim();

    if (!courseCode) { setStatus(status, 'Please select a course.', 'error'); return; }
    if (!studentId) { setStatus(status, 'Please select a student.', 'error'); return; }
    if (!rating) { setStatus(status, 'Please select a rating.', 'error'); return; }
    if (!comments) { setStatus(status, 'Please add a comment.', 'error'); return; }

    submitBtn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient.from('student_feedback').insert({
      lecturer_id: currentUserId,
      student_id: studentId,
      course_code: courseCode,
      rating: Number(rating),
      comments,
    });

    submitBtn.disabled = false;

    if (error) {
      console.error('Submitting student feedback failed:', error);
      setStatus(status, 'Could not submit feedback. Please try again.', 'error');
      return;
    }

    setStatus(status, 'Feedback submitted.', 'success');
    toast('Student feedback submitted.', 'success');
    document.getElementById('studentFeedbackForm').reset();
    loadStudentFeedbackStudents('');
  });

  function renderFeedbackItem(list, { headline, meta, rating, comments, empty }) {
    if (empty) { list.innerHTML = emptyState(empty); return; }
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
    title.textContent = headline;
    const metaRow = document.createElement('div');
    metaRow.className = 'record-meta';
    const metaSpan = document.createElement('span');
    metaSpan.textContent = meta;
    const ratingBadge = document.createElement('span');
    ratingBadge.className = 'badge ' + (rating >= 4 ? 'badge-verified' : rating <= 2 ? 'badge-unverified' : 'badge-course');
    ratingBadge.textContent = rating + '/5';
    metaRow.append(metaSpan, ratingBadge);
    headText.append(title, metaRow);
    headMain.append(recordIcon('bell'), headText);
    head.appendChild(headMain);

    const body = document.createElement('div');
    body.className = 'record-body';
    body.textContent = comments || '(no comments left)';

    item.append(head, body);
    list.appendChild(item);
  }

  async function loadMyCourseFeedback() {
    const list = document.getElementById('myCourseFeedbackList');
    const { data, error } = await supabaseClient
      .from('course_feedback')
      .select('id, course_code, rating, comments, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    list.innerHTML = '';
    if (error) { console.error('Loading your feedback failed:', error); list.innerHTML = emptyState('Feedback is not available right now.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No feedback yet.'); return; }
    rows.forEach((r) => renderFeedbackItem(list, {
      headline: courseNameFor(r.course_code),
      meta: fmtDate(r.created_at),
      rating: r.rating,
      comments: r.comments,
    }));
  }

  /* Admin-only: all reports + the lock toggle. */

  async function loadAllCourseFeedback() {
    const list = document.getElementById('allCourseFeedbackList');
    const { data, error } = await supabaseClient
      .from('course_feedback')
      .select('id, course_code, lecturer_id, rating, comments, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    list.innerHTML = '';
    if (error) { console.error('Loading all course feedback failed:', error); list.innerHTML = emptyState('Could not load feedback.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No feedback yet.'); return; }

    const ids = [...new Set(rows.map((r) => r.lecturer_id))];
    const [{ data: people }, labels] = await Promise.all([
      supabaseClient.from('profiles').select('id, full_name').in('id', ids),
      fetchPosterLabels(ids),
    ]);
    const nameById = new Map((people || []).map((p) => [p.id, p.full_name]));

    rows.forEach((r) => renderFeedbackItem(list, {
      headline: (nameById.get(r.lecturer_id) || 'Unknown lecturer') + ' — ' + courseNameFor(r.course_code),
      meta: fmtDate(r.created_at) + (labels.get(r.lecturer_id) ? ' • ' + labels.get(r.lecturer_id) : ''),
      rating: r.rating,
      comments: r.comments,
    }));
  }

  async function loadAllStudentFeedback() {
    const list = document.getElementById('allStudentFeedbackList');
    const { data, error } = await supabaseClient
      .from('student_feedback')
      .select('id, lecturer_id, student_id, course_code, rating, comments, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    list.innerHTML = '';
    if (error) { console.error('Loading all student feedback failed:', error); list.innerHTML = emptyState('Could not load feedback.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No feedback yet.'); return; }

    const ids = [...new Set(rows.flatMap((r) => [r.lecturer_id, r.student_id]))];
    const { data: people } = await supabaseClient.from('profiles').select('id, full_name').in('id', ids);
    const nameById = new Map((people || []).map((p) => [p.id, p.full_name]));

    rows.forEach((r) => renderFeedbackItem(list, {
      headline: (nameById.get(r.student_id) || 'Unknown student') + ' — ' + courseNameFor(r.course_code),
      meta: fmtDate(r.created_at) + ' • by ' + (nameById.get(r.lecturer_id) || 'Unknown lecturer'),
      rating: r.rating,
      comments: r.comments,
    }));
  }

  async function loadFeedbackLockCard() {
    await refreshCourseFeedbackLockState();
    document.getElementById('courseFeedbackLockState').textContent =
      courseFeedbackLocked ? 'Currently LOCKED' : 'Currently OPEN';
    document.getElementById('courseFeedbackLockToggleBtn').textContent =
      courseFeedbackLocked ? 'Unlock form' : 'Lock form';
  }

  document.getElementById('courseFeedbackLockToggleBtn').addEventListener('click', async () => {
    const status = document.getElementById('courseFeedbackLockStatus');
    const btn = document.getElementById('courseFeedbackLockToggleBtn');
    const nextValue = !courseFeedbackLocked;

    btn.disabled = true;
    setStatus(status, '', null);

    const { error } = await supabaseClient
      .from('feedback_settings')
      .update({ lecturer_feedback_locked: nextValue, updated_by: currentUserId, updated_at: new Date().toISOString() })
      .eq('id', 1);

    btn.disabled = false;

    if (error) {
      console.error('Updating feedback lock failed:', error);
      setStatus(status, 'Could not update. Please try again.', 'error');
      return;
    }

    courseFeedbackLocked = nextValue;
    document.getElementById('courseFeedbackLockState').textContent = nextValue ? 'Currently LOCKED' : 'Currently OPEN';
    btn.textContent = nextValue ? 'Unlock form' : 'Lock form';
    setStatus(status, nextValue ? 'Form locked.' : 'Form unlocked.', 'success');
    toast(nextValue ? 'Course/lecturer feedback form locked.' : 'Course/lecturer feedback form unlocked.', 'success');
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

    // Hero banner (Overview tab, all staff) — same pattern as the
    // student portal's hero in home.js: greeting + key account facts up
    // top instead of a bare "Overview" heading.
    const firstName = admin.profile.full_name ? admin.profile.full_name.split(' ')[0] : '';
    document.getElementById('heroGreeting').textContent = 'Welcome back' + (firstName ? ', ' + firstName : '');
    document.getElementById('heroSub').textContent = currentUserEmail || '';
    document.getElementById('heroRoleTag').textContent = displayRoleLabel(admin.profile);
    const heroAccessTag = document.getElementById('heroAccessTag');
    const hasElevatedAccess = currentUserIsSuperAdmin || currentUserIsAdmin;
    heroAccessTag.textContent = currentUserIsSuperAdmin ? 'Root access' : (currentUserIsAdmin ? 'Admin access' : 'Staff access');
    heroAccessTag.classList.toggle('tag-verified', hasElevatedAccess);
    heroAccessTag.classList.toggle('tag-pending', !hasElevatedAccess);

    document.getElementById('adminTicketsSection').hidden = !currentUserIsAdmin;
    document.getElementById('adminFeedbackSection').hidden = !currentUserIsAdmin;
    document.getElementById('attendanceAdminTools').hidden = !currentUserIsAdmin;
    // Root/super admin only — being a plain "admin" is no longer
    // enough to see this link. (admin.js enforces the same rule on
    // admin.html itself, in case someone bookmarks or types the URL
    // directly instead of clicking this link.)
    document.getElementById('adminPanelLink').hidden = !currentUserIsSuperAdmin;

    // Lecturers (role "staff", not "admin") get Overview, Students,
    // Announcements (course-scoped only), Resources, Attendance (incl.
    // read-only archived attendance), Timetable, Grades, My Classes, and
    // their own Support tickets. The Staff list and the Activity Log stay
    // admin/root territory, as does creating an attendance archive. This
    // is a UX-layer restriction only. Overview is the default active tab
    // and is visible to everyone here, so no landing-tab redirect is
    // needed.
    if (!currentUserIsAdmin) {
      document.querySelectorAll('[data-admin-only]').forEach((el) => {
        el.hidden = true;
        el.setAttribute('aria-hidden', 'true');
      });
    }

    // Lecturers only ever see the Announcements tab's "course" audience
    // (see restrictAnnouncementAudienceForStaff), and that course has to
    // be one of their own (see buildAnnouncementCourseOptions) — so
    // remind them up front, on the tab itself, rather than only after
    // they've opened the modal and hit the same wall.
    const announcementsStaffHint = document.getElementById('announcementsStaffHint');
    if (announcementsStaffHint) announcementsStaffHint.hidden = currentUserIsAdmin;

    populateCourseSelects();
    populateDepartmentSelects();
    populateStudentCourseFilter();

    // Land on a real course instead of the blank "-- Select a course --"
    // placeholder, so grades show up immediately rather than making the
    // lecturer pick one first. Just the first course alphabetically by
    // department (same order COURSES lists them in) — there's no
    // "assigned courses" concept for staff to default to instead.
    const gradesCourseSelect = document.getElementById('gradesCourseSelect');
    const firstGradesCourseOption = gradesCourseSelect.querySelector('option[value]:not([value=""])');
    if (firstGradesCourseOption && !gradesCourseSelect.value) {
      gradesCourseSelect.value = firstGradesCourseOption.value;
      syncCourseSelectDisplay(gradesCourseSelect);
    }

    document.getElementById('timetableCourseSelect').addEventListener('change', (e) => renderTimetableRows(e.target.value));
    document.getElementById('resourceCourseFilter').addEventListener('change', (e) => loadResources(e.target.value));
    document.getElementById('resourceSearch').addEventListener('input', renderResourcesList);
    markUploadedTimetableCourses();

    loadingMessage.hidden = true;
    appShell.hidden = false;
    signOutButton.hidden = false;

    const loaders = [
      loadAllTimetables(),
      loadSupportTab(),
      loadGrades(document.getElementById('gradesCourseSelect').value),
      loadStudents(),
      loadAnnouncements(),
      loadResources(document.getElementById('resourceCourseFilter').value),
      loadMySchedule(),
      loadAttendance(document.getElementById('attendanceCourseSelect').value, document.getElementById('attendanceDate').value, ''),
      loadAttendanceOverview(document.getElementById('attendanceCourseSelect').value),
      loadMyCourseFeedback(),
      loadOverview(),          // Overview tab is visible to all staff
      loadAttendanceArchive(), // archived attendance is read-only for all staff
    ];
    // Everything else here backs an admin-only tab — skip fetching it
    // for lecturers.
    if (currentUserIsAdmin) {
      loaders.push(
        loadAllTickets(),
        loadActivityLog(),
        loadFeedbackLockCard(),
        loadAllCourseFeedback(),
        loadAllStudentFeedback(),
      );
    }
    await Promise.all(loaders);
    // Runs after everything else settles, once per login — a modal
    // popping up mid-load would compete with the rest of the page for
    // attention.
    if (currentUserIsAdmin) offerAttendanceArchivePrompt();
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