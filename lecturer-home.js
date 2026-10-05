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

  /* ---------------- Overview ----------------
     Every panel loads independently (Promise.allSettled), so one failing
     query only blanks its own card. Student rows are fetched in pages of
     1000 — Supabase's default row cap — so counts stay right as the school
     grows, and the per-course bars scale to the largest course rather than
     to the total, so small courses stay readable. */

  const OVERVIEW_COLORS = {
    male: '#1f4e8c', female: '#9c4f8a', course: '#1f4e8c',
    secondary: '#1f7a4d', other: '#b7791f', none: '#8a919c',
    present: '#1f7a4d', late: '#b7791f', absent: '#b42318',
  };
  const OV_COURSE_PREVIEW = 8;
  const OV_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let ovCourseRows = [];
  let ovCoursesExpanded = false;

  const ovNum = (n) => Number(n || 0).toLocaleString();
  const ovEl = (id) => document.getElementById(id);

  // scaleTo: what a 100% bar means. Defaults to the sum of the rows' total.
  function renderOverviewBars(listEl, rows, total, scaleTo) {
    listEl.replaceChildren();
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'ov-empty';
      li.textContent = 'Nothing to show yet.';
      listEl.appendChild(li);
      return;
    }
    const scale = scaleTo || total;
    rows.forEach((row) => {
      const pct = total > 0 ? Math.round((row.count / total) * 100) : 0;
      const width = scale > 0 ? Math.max(row.count > 0 ? 2 : 0, Math.round((row.count / scale) * 100)) : 0;

      const li = document.createElement('li');
      const top = document.createElement('div');
      top.className = 'ov-bar-top';
      const label = document.createElement('span');
      label.textContent = row.label;
      label.title = row.label;
      const value = document.createElement('strong');
      value.textContent = ovNum(row.count);
      const pctEl = document.createElement('span');
      pctEl.className = 'ov-pct';
      pctEl.textContent = pct + '%';
      value.appendChild(pctEl);
      top.append(label, value);

      const track = document.createElement('div');
      track.className = 'ov-track';
      track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('div');
      fill.className = 'ov-fill';
      fill.style.background = row.color;
      track.appendChild(fill);

      li.append(top, track);
      if (row.go) makeActivatable(li, row.go, 'ov-bar-link', 'View students: ' + row.label);
      listEl.appendChild(li);
      requestAnimationFrame(() => { fill.style.width = width + '%'; });
    });
  }

  // Divs (not <button>) so the existing .card styling is untouched; still
  // reachable and usable from the keyboard.
  function makeActivatable(el, handler, cls, ariaLabel) {
    el.classList.add(cls);
    el.setAttribute('role', 'link');
    el.tabIndex = 0;
    if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  }

  function ovGoTab(tabId) {
    const btn = document.querySelector('.nav-item[data-tab="' + tabId + '"]');
    if (!btn || btn.hidden) return;
    switchTab(tabId, btn);
    window.scrollTo(0, 0);
  }

  // The Students tab doubles as the "My students" / "Unverified" / etc. page.
  const STUDENT_VIEWS = {
    all: { heading: 'Students', label: '' },
    mine: { heading: 'My students', label: 'Showing students in the courses on your weekly schedule.' },
    unverified: { heading: 'Unverified students', label: 'Showing students who are not verified yet.' },
    pending: { heading: 'Pending deletion', label: 'Showing accounts in the 30-day pending-deletion phase.' },
  };
  let studentViewMode = 'all';

  function setStudentView(mode) {
    studentViewMode = STUDENT_VIEWS[mode] ? mode : 'all';
    const v = STUDENT_VIEWS[studentViewMode];
    document.getElementById('studentsHeading').textContent = v.heading;
    document.getElementById('studentViewLabel').textContent = v.label;
    document.getElementById('studentViewBar').hidden = studentViewMode === 'all';
    renderStudents();
  }

  function ovOpenStudents(mode, courseCode) {
    document.getElementById('studentSearch').value = '';
    document.getElementById('studentCourseFilter').value = courseCode || '';
    try { syncCourseSelectDisplay(document.getElementById('studentCourseFilter')); } catch (e) { /* plain select */ }
    setStudentView(mode);
    ovGoTab('students');
  }

  document.getElementById('studentViewClear').addEventListener('click', () => setStudentView('all'));
  document.querySelectorAll('.ov-panel[data-go]').forEach((panel) => {
    const h = panel.querySelector('h3');
    makeActivatable(panel, () => ovGoTab(panel.dataset.go), 'ov-link', 'Open: ' + (h ? h.textContent.trim() : panel.dataset.go));
  });

  function renderKpis(items) {
    const wrap = ovEl('ovKpis');
    wrap.replaceChildren();
    items.forEach((k) => {
      const card = document.createElement('div');
      card.className = 'card ov-kpi';
      if (k.go) makeActivatable(card, k.go, 'ov-link', 'Open: ' + k.label);
      const label = document.createElement('div');
      label.className = 'ov-label';
      label.textContent = k.label;
      const value = document.createElement('div');
      value.className = 'ov-kpi-value';
      value.textContent = k.value;
      card.append(label, value);
      if (k.sub) {
        const sub = document.createElement('div');
        sub.className = 'ov-kpi-sub';
        sub.textContent = k.sub;
        card.appendChild(sub);
      }
      wrap.appendChild(card);
    });
  }

  async function fetchAllStudents() {
    const PAGE = 1000;
    const cols = 'id, course_code, gender, has_secondary_qualifications, has_other_qualifications, verified, deactivated_at, last_active_at, created_at';
    let all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseClient
        .from('profiles').select(cols).eq('role', 'student')
        .order('created_at', { ascending: false }).range(from, from + PAGE - 1);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < PAGE) break;
    }
    return all;
  }

  function renderCourseBars() {
    const list = ovEl('ovCourses');
    const toggle = ovEl('ovCoursesToggle');
    const rows = ovCoursesExpanded ? ovCourseRows : ovCourseRows.slice(0, OV_COURSE_PREVIEW);
    const max = ovCourseRows.length ? ovCourseRows[0].count : 0;
    const total = ovCourseRows.reduce((sum, r) => sum + r.count, 0);
    renderOverviewBars(list, rows, total, max);
    list.classList.toggle('scroll', ovCoursesExpanded);
    const hidden = ovCourseRows.length - OV_COURSE_PREVIEW;
    toggle.hidden = hidden <= 0;
    toggle.textContent = ovCoursesExpanded ? 'Show fewer' : 'Show all ' + ovCourseRows.length + ' courses';
  }
  ovEl('ovCoursesToggle').addEventListener('click', () => {
    ovCoursesExpanded = !ovCoursesExpanded;
    renderCourseBars();
  });

  function renderOverviewToday() {
    const day = new Date().getDay();
    ovEl('ovTodayDay').textContent = OV_DAYS[day];
    const box = ovEl('ovToday');
    box.replaceChildren();
    const codes = (typeof mySchedule !== 'undefined' && mySchedule && mySchedule.get(day)) || [];
    if (!codes.length) {
      const p = document.createElement('p');
      p.className = 'ov-empty';
      p.textContent = 'No classes scheduled for today. Set your weekly schedule under My Classes.';
      box.appendChild(p);
      return;
    }
    codes.forEach((code) => {
      const chip = document.createElement('span');
      chip.className = 'ov-chip';
      chip.textContent = courseNameFor(code);
      box.appendChild(chip);
    });
  }

  function ovFail(listEl) { listEl.replaceChildren(); const p = document.createElement('p'); p.className = 'ov-empty'; p.textContent = 'Could not load right now.'; listEl.appendChild(p); }

  async function loadOverviewStudents() {
    let students;
    try { students = await fetchAllStudents(); } catch (err) {
      console.error('Overview student query failed:', err);
      renderKpis([{ label: 'Students', value: '—' }]);
      ['ovGender', 'ovQuals', 'ovCourses'].forEach((id) => ovFail(ovEl(id)));
      return;
    }
    const n = students.length;
    ovStudents = students;
    renderOverviewKpis();
    loadOverviewExtras();

    const male = students.filter((s) => s.gender === 'Male').length;
    const female = students.filter((s) => s.gender === 'Female').length;
    renderOverviewBars(ovEl('ovGender'), [
      { label: 'Male', count: male, color: OVERVIEW_COLORS.male },
      { label: 'Female', count: female, color: OVERVIEW_COLORS.female },
      { label: 'Not recorded', count: Math.max(0, n - male - female), color: OVERVIEW_COLORS.none },
    ], n);

    const secondary = students.filter((s) => s.has_secondary_qualifications === true).length;
    const other = students.filter((s) => s.has_other_qualifications === true).length;
    const recorded = students.filter((s) => s.has_secondary_qualifications !== null && s.has_secondary_qualifications !== undefined).length;
    renderOverviewBars(ovEl('ovQuals'), [
      { label: 'Secondary (CSEC / CAPE)', count: secondary, color: OVERVIEW_COLORS.secondary },
      { label: 'Other qualifications', count: other, color: OVERVIEW_COLORS.other },
      { label: 'Not recorded', count: Math.max(0, n - recorded), color: OVERVIEW_COLORS.none },
    ], n);

    const byCourse = new Map();
    students.forEach((s) => {
      const key = s.course_code || '';
      byCourse.set(key, (byCourse.get(key) || 0) + 1);
    });
    ovCourseRows = [...byCourse.entries()]
      .map(([code, count]) => ({ label: code ? courseNameFor(code) : 'No course set', count, color: code ? OVERVIEW_COLORS.course : OVERVIEW_COLORS.none, go: code ? () => ovOpenStudents('all', code) : null }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    ovEl('ovCourseSummary').textContent = byCourse.size + (byCourse.size === 1 ? ' course' : ' courses') + ' \u00b7 ' + ovNum(n) + ' students \u00b7 ' + ovNum(ovMeta.new30) + ' new in 30 days';
    renderCourseBars();
  }

  let ovStudents = null;
  let ovExtras = {};
  let ovMeta = { active30: 0, new30: 0 };

  function renderOverviewKpis() {
    if (!ovStudents) return;
    const n = ovStudents.length;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const within30 = (v) => v && now - new Date(v).getTime() <= 30 * DAY;
    const active30 = ovStudents.filter((s) => within30(s.last_active_at)).length;
    const new30 = ovStudents.filter((s) => within30(s.created_at)).length;
    const fmt = (v) => (v === undefined || v === null ? '\u2014' : ovNum(v));

    ovMeta = { active30, new30 };
    const totalSub = active30 + ' active in 30 days';
    let kpis;
    if (currentUserIsAdmin) {
      // Needs-attention items first, then the headline total.
      kpis = [
        { label: 'Open tickets', value: fmt(ovExtras.openTickets), sub: 'support requests', go: () => ovGoTab('support') },
        { label: 'Unverified', value: ovNum(ovStudents.filter((s) => s.verified === false).length), sub: 'awaiting verification', go: () => ovOpenStudents('unverified') },
        { label: 'Pending deletion', value: ovNum(ovStudents.filter((s) => s.deactivated_at).length), sub: 'in the 30-day phase', go: () => ovOpenStudents('pending') },
        { label: 'Total students', value: ovNum(n), sub: totalSub, go: () => ovOpenStudents('all') },
      ];
    } else {
      const mine = typeof myPriorityCourses !== 'undefined' && myPriorityCourses ? myPriorityCourses : new Set();
      const todayCodes = (typeof mySchedule !== 'undefined' && mySchedule && mySchedule.get(new Date().getDay())) || [];
      kpis = [
        { label: 'Classes today', value: ovNum(todayCodes.length), sub: OV_DAYS[new Date().getDay()], go: () => ovGoTab('myClasses') },
        { label: 'My students', value: mine.size ? ovNum(ovStudents.filter((s) => mine.has(s.course_code)).length) : '\u2014', sub: mine.size ? 'in ' + mine.size + (mine.size === 1 ? ' course' : ' courses') : 'Set up My Classes', go: () => (mine.size ? ovOpenStudents('mine') : ovGoTab('myClasses')) },
        { label: 'Marked by me', value: fmt(ovExtras.myMarked), sub: 'attendance, last 7 days', go: () => ovGoTab('attendance') },
        { label: 'My open tickets', value: fmt(ovExtras.myTickets), sub: 'support requests', go: () => ovGoTab('support') },
      ];
    }
    renderKpis(kpis);
  }

  async function loadOverviewExtras() {
    if (currentUserIsAdmin) {
      const r = await supabaseClient.from('support_tickets').select('id', { count: 'exact', head: true }).neq('status', 'closed');
      if (r.error) console.warn('Overview ticket count failed:', r.error); else ovExtras.openTickets = r.count ?? 0;
    } else {
      const d = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const [marked, tickets] = await Promise.all([
        supabaseClient.from('attendance').select('id', { count: 'exact', head: true }).eq('marked_by', currentUserId).eq('archived', false).gte('class_date', iso),
        supabaseClient.from('support_tickets').select('id', { count: 'exact', head: true }).eq('user_id', currentUserId).neq('status', 'closed'),
      ]);
      if (marked.error) console.warn('Overview marked count failed:', marked.error); else ovExtras.myMarked = marked.count ?? 0;
      if (tickets.error) console.warn('Overview my tickets failed:', tickets.error); else ovExtras.myTickets = tickets.count ?? 0;
    }
    renderOverviewKpis();
  }

  async function loadOverviewAttendance() {
    const list = ovEl('ovAttendance');
    const since = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const iso = since.getFullYear() + '-' + String(since.getMonth() + 1).padStart(2, '0') + '-' + String(since.getDate()).padStart(2, '0');
    const q = (status) => supabaseClient.from('attendance').select('id', { count: 'exact', head: true })
      .eq('archived', false).eq('status', status).gte('class_date', iso);
    const results = await Promise.all([q('present'), q('late'), q('absent')]);
    if (results.some((r) => r.error)) { console.warn('Overview attendance failed:', results.find((r) => r.error).error); ovFail(list); return; }
    const [present, late, absent] = results.map((r) => r.count ?? 0);
    const total = present + late + absent;
    if (!total) { list.replaceChildren(); const p = document.createElement('p'); p.className = 'ov-empty'; p.textContent = 'No attendance marked in the last 7 days.'; list.appendChild(p); return; }
    renderOverviewBars(list, [
      { label: 'Present', count: present, color: OVERVIEW_COLORS.present },
      { label: 'Late', count: late, color: OVERVIEW_COLORS.late },
      { label: 'Absent', count: absent, color: OVERVIEW_COLORS.absent },
    ], total);
  }

  async function loadOverviewAnnouncements() {
    const list = ovEl('ovAnnouncements');
    const { data, error } = await supabaseClient
      .from('announcements').select('id, title, audience, course_code, created_at')
      .order('created_at', { ascending: false }).limit(5);
    if (error) { console.warn('Overview announcements failed:', error); ovFail(list); return; }
    list.replaceChildren();
    if (!data || !data.length) { const p = document.createElement('p'); p.className = 'ov-empty'; p.textContent = 'No announcements yet.'; list.appendChild(p); return; }
    data.forEach((a) => {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.textContent = a.title || 'Untitled';
      const when = document.createElement('span');
      when.textContent = new Date(a.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      li.append(title, when);
      list.appendChild(li);
    });
  }

  async function loadOverview() {
    renderOverviewToday();
    await Promise.allSettled([loadOverviewStudents(), loadOverviewAttendance(), loadOverviewAnnouncements()]);
  }

  document.getElementById('overviewRefresh').addEventListener('click', loadOverview);

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
          if (!(await confirmAction({ title: grant ? 'Grant root access?' : 'Revoke root access?', text: `${label} ${p.full_name || 'this user'}? This is a temporary arrangement while root grants go through admins — treat it carefully.`, confirmText: grant ? 'Grant root' : 'Revoke root' }))) return;
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
      if (p.role === 'student') {
        const gradesBtn = document.createElement('button');
        gradesBtn.type = 'button';
        gradesBtn.className = 'btn btn-secondary btn-sm';
        gradesBtn.textContent = 'Grades';
        gradesBtn.style.marginRight = '6px';
        gradesBtn.title = 'View and enter this student\u2019s grades';
        gradesBtn.addEventListener('click', () => openStudentGrades(p));
        actionsTd.appendChild(gradesBtn);
      }
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
      if (studentViewMode === 'mine' && !myPriorityCourses.has(p.course_code)) return false;
      if (studentViewMode === 'unverified' && p.verified !== false) return false;
      if (studentViewMode === 'pending' && !p.deactivated_at) return false;
      return matchesProfileSearch(p, q);
    });

    if (!rows.length) {
      const empty = studentViewMode === 'mine' && !myPriorityCourses.size
        ? 'You have no classes scheduled yet. Add them under My Classes.'
        : 'No matching students.';
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">' + empty + '</td></tr>';
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
    if (!(await confirmAction({ title: 'Force pending deletion?', text: `${(p && p.full_name) || 'This account'} will enter the 30-day pending-deletion phase. They'll keep normal access until they sign in again (which cancels it), or an admin reactivates it sooner.`, confirmText: 'Force pending deletion' }))) return;
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
      const ok = await confirmAction({ title: 'Remove your own admin access?', text: 'This removes your own admin access and signs you out.', confirmText: 'Remove my admin access' });
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
    renderOverviewToday();
    renderOverviewKpis();
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
          if (!(await confirmAction({ title: 'Delete this announcement?', text: 'It will disappear for everyone who can see it. This can\'t be undone.', confirmText: 'Delete' }))) return;
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

    const updatedTd = document.crea