(function () {
  const loadingMessage = document.getElementById('loadingMessage');
  const appShell = document.getElementById('appShell');
  const signOutButton = document.getElementById('signOutButton');
  const courseChangeForm = document.getElementById('courseChangeForm');
  // Built from COURSES (courses-data.js) instead of the old hardcoded
  // <option> markup, which had drifted out of sync with the codes
  // admin.html actually uses — see courses-data.js's own comment and
  // the matching fix in login.js. "Staff" is left out, same as
  // sign-up; a student changing course shouldn't be offered it. Not
  // marking the placeholder disabled, matching this form's original
  // (selectable, non-disabled) blank option.
  populateCourseSelect(
    document.getElementById('courseChange'),
    COURSES.filter((g) => g.label !== 'Staff'),
    '-- Select a Course --',
    false
  );
  enhanceCourseSelect(document.getElementById('courseChange'));

  // Filled in by loadAccount() once the profile is loaded.
  let currentUserId = null;
  let currentUserEmail = null;
  let currentUserProfile = {};

  async function loadAccount() {
    const session = await requireSession();
    if (!session) return;

    const user = session.user;
    await ensureProfile(user); // no-op if the DB trigger already created the row

    const wasReactivated = await touchActivity();

    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('full_name, student_id, course_code, course_name, role, verified, avatar_url')
      .eq('id', user.id)
      .single();

    const warningCard = document.getElementById('profileWarningCard');
    if (profileError) {
      // Don't silently fall back to stale signup metadata and pretend
      // everything's current — that's exactly what made "change course"
      // look broken before. Say so instead.
      console.error('Could not load full profile:', profileError);
      document.getElementById('profileWarningText').textContent =
        'Some profile data could not be loaded. Changes you make may not display correctly until this is fixed — contact an administrator.';
      warningCard.hidden = false;
    } else {
      warningCard.hidden = true;
    }

    const account = profile || user.user_metadata || {};
    currentUserId = user.id;
    currentUserEmail = user.email || null;
    currentUserProfile = account;

    document.getElementById('studentName').textContent = account.full_name || 'Student';
    document.getElementById('studentId').textContent = account.student_id || 'Not provided';
    document.getElementById('studentEmail').textContent = user.email || '';
    document.getElementById('studentCourse').textContent = account.course_name || 'Not selected';
    document.getElementById('studentVerified').textContent = account.verified ? 'Verified' : 'Pending verification';
    document.getElementById('courseChange').value = account.course_code || '';
    syncCourseSelectDisplay(document.getElementById('courseChange'));
    document.getElementById('headerName').textContent = account.full_name || user.email || '';
    renderAvatar(document.getElementById('avatarSlot'), account.full_name || user.email, account.avatar_url);

    // Hero banner (Overview tab) — same underlying data as the detail-row
    // card below it, just surfaced as the page's greeting first.
    document.getElementById('heroGreeting').textContent =
      'Welcome back' + (account.full_name ? ', ' + account.full_name.split(' ')[0] : '');
    document.getElementById('heroSub').textContent = account.student_id
      ? 'Student ID ' + account.student_id
      : 'Your student ID has not been added yet.';
    document.getElementById('heroCourseTag').textContent = account.course_name || 'No course selected';
    const heroStatusTag = document.getElementById('heroStatusTag');
    heroStatusTag.textContent = account.verified ? 'Verified' : 'Pending verification';
    heroStatusTag.classList.toggle('tag-verified', !!account.verified);
    heroStatusTag.classList.toggle('tag-pending', !account.verified);

    // Staff/admin accounts land here too (this is the one sign-in form
    // for everyone) but have no other way to find their dashboard, so
    // surface it here rather than making them remember a URL. Admins
    // go to the staff dashboard first, same as staff — the further
    // jump into the Admin Panel itself now lives over there (see the
    // nav in lecturer-home.html), not directly off the student view.
    //
    // Root outranks role — an account can be granted root without
    // being staff/admin by role (see the Root badge in admin.html /
    // lecturer-home.html, tracked separately from role) — so also show
    // this link for root even when role is plain "student", or a root
    // account would pass the dashboard's own access check but never
    // see a way to get there.
    const isSuperAdmin = await getIsSuperAdmin();
    const dashboardLink = document.getElementById('staffDashboardNavLink');
    if (account.role === 'admin' || account.role === 'staff' || isSuperAdmin === true) {
      dashboardLink.hidden = false;
    }

    loadingMessage.hidden = true;
    appShell.hidden = false;
    signOutButton.hidden = false;

    if (wasReactivated) {
      toast('Welcome back — your account has been reactivated.', 'success', 6000);
    }

    await Promise.all([
      loadAnnouncements(account.course_code),
      loadTimetable(account.course_code),
      loadResources(account.course_code),
      loadGrades(),
    ]);
  }

  // Small stroke icons matching the sidebar nav's own icon style (18x18
  // viewBox, currentColor strokes) so each record echoes the tab it
  // lives in instead of introducing a new icon language.
  const ICONS = {
    bell: '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 3C7.1 3 5.6 4.6 5.6 6.5V9.3L4.2 11.4H13.8L12.4 9.3V6.5C12.4 4.6 10.9 3 9 3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7.4 13.4C7.4 14.3 8.1 15 9 15C9.9 15 10.6 14.3 10.6 13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    calendar: '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 7H15.5" stroke="currentColor" stroke-width="1.4"/><path d="M6 2V5M12 2V5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    resource: '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3.5 3.5H10.5C11.6 3.5 12.5 4.4 12.5 5.5V14.5H5.5C4.4 14.5 3.5 13.6 3.5 12.5V3.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M12.5 5.5H13.5C13.5 5.5 14.5 5.5 14.5 6.5V13.5C14.5 13.5 14.5 14.5 13.5 14.5H5.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 6.5H10M6 9H10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    grade: '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4 14.5V10M9 14.5V6M14 14.5V3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
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

  async function loadAnnouncements(courseCode) {
    const list = document.getElementById('announcementsList');
    let query = supabaseClient
      .from('announcements')
      .select('id, title, message, audience, course_code, created_at')
      .order('created_at', { ascending: false })
      .limit(15);

    // Staff-only announcements are deliberately left out of this OR list —
    // students should never see audience = 'staff' rows.
    query = courseCode
      ? query.or(`audience.eq.everyone,audience.eq.all_students,and(audience.eq.course,course_code.eq.${courseCode})`)
      : query.or('audience.eq.everyone,audience.eq.all_students');

    const { data, error } = await query;
    list.innerHTML = '';

    if (error) { console.error('Loading announcements failed:', error); list.innerHTML = emptyState('Announcements are not available right now.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No announcements yet.'); return; }

    rows.forEach((a) => {
      const item = document.createElement('li');
      // Left-edge accent mirrors the badge color for the same
      // audience, so the card reads at a glance before the badge text
      // is even read.
      item.className = 'record' + (a.audience === 'everyone' ? ' accent-danger' : a.audience === 'all_students' ? ' accent-brass' : '');
      // A quiet "new" dot, not another badge, for anything posted in
      // the last 3 days.
      const ageMs = Date.now() - new Date(a.created_at).getTime();
      if (ageMs >= 0 && ageMs < 3 * 24 * 60 * 60 * 1000) item.classList.add('is-new');

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
      const dateSpan = document.createElement('span');
      dateSpan.textContent = new Date(a.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      const badge = document.createElement('span');
      badge.className = 'badge ' + (a.audience === 'everyone' ? 'badge-everyone' : a.audience === 'all_students' ? 'badge-all' : 'badge-course');
      badge.textContent = a.audience === 'everyone' ? 'Everyone' : a.audience === 'all_students' ? 'All students' : 'Your course';
      meta.append(dateSpan, badge);

      headText.append(title, meta);
      headMain.append(recordIcon('bell'), headText);
      head.appendChild(headMain);

      const body = document.createElement('div');
      body.className = 'record-body';
      body.textContent = a.message;

      item.append(head, body);
      list.appendChild(item);
    });
  }

  async function loadTimetable(courseCode) {
    const list = document.getElementById('timetableList');
    if (!courseCode) { list.innerHTML = emptyState('No course has been selected yet.'); return; }

    const { data, error } = await supabaseClient
      .from('timetable')
      .select('file_name, file_url, updated_at')
      .eq('course_code', courseCode)
      .maybeSingle();

    list.innerHTML = '';
    if (error) { console.error('Loading timetable failed:', error); list.innerHTML = emptyState('Timetable is not available right now.'); return; }
    if (!data || !data.file_url) { list.innerHTML = emptyState('No timetable has been uploaded for this course yet.'); return; }

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
    title.textContent = data.file_name || 'Timetable';
    headText.appendChild(title);

    if (data.updated_at) {
      const meta = document.createElement('div');
      meta.className = 'record-meta';
      meta.textContent = 'Updated ' + new Date(data.updated_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      headText.appendChild(meta);
    }

    headMain.append(recordIcon('calendar'), headText);
    head.appendChild(headMain);

    const fileLink = document.createElement('a');
    fileLink.className = 'record-action';
    fileLink.href = data.file_url;
    fileLink.target = '_blank';
    fileLink.rel = 'noopener noreferrer';
    fileLink.textContent = 'Open ↗';
    head.appendChild(fileLink);

    item.appendChild(head);

    // Show it inline if it looks like an image; otherwise the header's
    // "Open ↗" pill above is the only way in (e.g. a PDF).
    if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(data.file_url)) {
      const img = document.createElement('img');
      img.src = data.file_url;
      img.alt = data.file_name || 'Timetable';
      img.style.maxWidth = '100%';
      img.style.borderRadius = '10px';
      img.style.marginTop = '12px';
      img.style.display = 'block';
      item.appendChild(img);
    }

    list.appendChild(item);
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function loadResources(courseCode) {
    const list = document.getElementById('resourcesList');
    if (!courseCode) { list.innerHTML = emptyState('No course has been selected yet.'); return; }

    const { data, error } = await supabaseClient
      .from('resources')
      .select('title, author, file_url, created_at')
      .eq('course_code', courseCode)
      .order('title');

    list.innerHTML = '';
    if (error) { console.error('Loading resources failed:', error); list.innerHTML = emptyState('Resources are not available right now.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No resources have been uploaded for this course yet.'); return; }

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
      headText.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'record-meta';
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
      if (meta.childNodes.length) headText.appendChild(meta);

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
      list.appendChild(item);
    });
  }

  /* ---------------- Grades ---------------- */

  // Grade (100%) and GPA are entered directly by staff (lecturer-home.js)
  // rather than derived from Attendance/Class work/Home work/Examination —
  // this just displays whatever was saved.
  const LETTER_LABEL = { A: 'A', B: 'B', C: 'C', F: 'F' };

  async function loadGrades() {
    const list = document.getElementById('gradesList');
    const gpaCard = document.getElementById('gpaCard');

    const { data, error } = await supabaseClient
      .from('grades')
      .select('course_code, course_name, attendance, class_work, home_work, examination, total_grade, gpa, letter_grade, updated_at')
      .eq('student_id', currentUserId)
      .order('updated_at', { ascending: false });

    list.innerHTML = '';
    if (error) {
      console.error('Loading grades failed:', error);
      list.innerHTML = emptyState('Grades are not available right now.');
      gpaCard.hidden = true;
      return;
    }

    const rows = data || [];
    if (!rows.length) {
      list.innerHTML = emptyState('No grades have been entered yet.');
      gpaCard.hidden = true;
      return;
    }

    const ACCENT_FOR_LETTER = { A: 'accent-success', B: '', C: 'accent-brass', F: 'accent-danger' };

    rows.forEach((r) => {
      const item = document.createElement('li');
      item.className = 'record' + (r.letter_grade && ACCENT_FOR_LETTER[r.letter_grade] ? ' ' + ACCENT_FOR_LETTER[r.letter_grade] : '');

      const head = document.createElement('div');
      head.className = 'record-head';
      const headMain = document.createElement('div');
      headMain.className = 'record-head-main';

      const headText = document.createElement('div');
      headText.className = 'record-head-text';
      const title = document.createElement('div');
      title.className = 'record-title';
      title.textContent = r.course_name || r.course_code;
      headText.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'record-meta';
      if (r.updated_at) {
        const dateSpan = document.createElement('span');
        dateSpan.textContent = 'Updated ' + fmtDate(r.updated_at);
        meta.appendChild(dateSpan);
      }
      headText.appendChild(meta);

      headMain.append(recordIcon('grade'), headText);
      head.appendChild(headMain);

      if (r.letter_grade) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-grade-' + r.letter_grade.toLowerCase();
        badge.textContent = 'Grade ' + LETTER_LABEL[r.letter_grade];
        head.appendChild(badge);
      }

      item.appendChild(head);

      // Grade (100%) and GPA are the headline numbers — always visible
      // in their own row rather than buried among the four component
      // scores below.
      if (r.total_grade != null || r.gpa != null) {
        const headlineRow = document.createElement('div');
        headlineRow.className = 'headline-row';
        if (r.total_grade != null) {
          const stat = document.createElement('div');
          stat.className = 'headline-stat';
          stat.innerHTML = '<span class="label">Grade (100%)</span>';
          const v = document.createElement('span'); v.className = 'value'; v.textContent = r.total_grade;
          stat.appendChild(v);
          headlineRow.appendChild(stat);
        }
        if (r.gpa != null) {
          const stat = document.createElement('div');
          stat.className = 'headline-stat';
          stat.innerHTML = '<span class="label">GPA</span>';
          const v = document.createElement('span'); v.className = 'value'; v.textContent = r.gpa;
          stat.appendChild(v);
          headlineRow.appendChild(stat);
        }
        item.appendChild(headlineRow);
      }

      // The four component scores are supplementary — tucked behind a
      // details toggle instead of always-on clutter under every row.
      const details = document.createElement('details');
      details.className = 'grade-details';
      const summary = document.createElement('summary');
      details.appendChild(summary);
      const breakdown = document.createElement('div');
      breakdown.className = 'grade-breakdown';
      [
        ['Attendance', r.attendance],
        ['Class work', r.class_work],
        ['Home work', r.home_work],
        ['Examination', r.examination],
      ].forEach(([label, value]) => {
        const row = document.createElement('div');
        row.className = 'detail-row';
        const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
        const v = document.createElement('span'); v.className = 'value'; v.textContent = value == null ? '—' : value;
        row.append(l, v);
        breakdown.appendChild(row);
      });
      details.appendChild(breakdown);
      item.appendChild(details);

      list.appendChild(item);
    });

    // Overall GPA — average of the GPA staff entered across every
    // course on record (usually just the current one, but this holds
    // up if a student ends up with more than one row over time).
    const graded = rows.filter((r) => r.gpa != null);
    const heroGpaTag = document.getElementById('heroGpaTag');
    if (graded.length) {
      const gpa = graded.reduce((sum, r) => sum + Number(r.gpa), 0) / graded.length;
      document.getElementById('gpaValue').textContent = gpa.toFixed(2);
      // Radial gauge — a ring showing gpa/4.0 instead of a plain number,
      // in the same spirit as the caliper/compass marks on the crest.
      // Circumference of r=52: 2 * PI * 52.
      const ring = document.getElementById('gpaRing');
      const circumference = 2 * Math.PI * 52;
      const fraction = Math.max(0, Math.min(1, gpa / 4));
      ring.style.strokeDasharray = String(circumference);
      ring.style.strokeDashoffset = String(circumference * (1 - fraction));
      gpaCard.hidden = false;
      if (heroGpaTag) heroGpaTag.textContent = gpa.toFixed(2);
    } else {
      gpaCard.hidden = true;
      if (heroGpaTag) heroGpaTag.textContent = 'No grades yet';
    }
  }

  courseChangeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const courseSelect = document.getElementById('courseChange');
    const status = document.getElementById('courseStatus');
    const submitBtn = document.getElementById('courseSubmit');

    const courseCode = courseSelect.value;
    if (!courseCode) { setStatus(status, 'Please select a course.', 'error'); return; }
    const courseName = courseSelect.options[courseSelect.selectedIndex].textContent.trim();

    submitBtn.disabled = true;
    setStatus(status, '', null);

    // The real permission check happens server-side inside this RPC.
    const { error } = await supabaseClient.rpc('change_my_course', {
      p_course_code: courseCode,
      p_course_name: courseName,
    });

    submitBtn.disabled = false;

    if (error) {
      console.error('change_my_course failed:', error);
      setStatus(status, 'Course change failed. Please try again.', 'error');
      return;
    }

    setStatus(status, 'Course updated successfully. Remember: this only changes it on the site — see your Head of Department for the real thing.', 'success');
    toast('Course updated to ' + courseName, 'success');
    window.setTimeout(() => window.location.reload(), 1400);
  });

  signOutButton.addEventListener('click', async () => {
    signOutButton.disabled = true;
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      signOutButton.disabled = false;
      toast('Sign-out error: ' + friendlyAuthError(error), 'error');
      return;
    }
    window.location.href = 'index.html';
  });

  loadAccount();
})();