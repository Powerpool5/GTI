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
  enhanceCourseSelect(document.getElementById('courseChange'), { disableTypingOnMobile: true });

  // Feedback tab's "course this relates to" picker — same course list
  // as "change course" above (Staff left out, a student isn't giving
  // feedback "for" the Staff pseudo-course).
  populateCourseSelect(
    document.getElementById('feedbackCourse'),
    COURSES.filter((g) => g.label !== 'Staff'),
    '-- Select a Course --',
    false
  );
  enhanceCourseSelect(document.getElementById('feedbackCourse'));

  // Resources are uploaded per department (see lecturer-home.js), not
  // per specific course — a student's own course_code isn't what's
  // stored on the resource row, so this maps it to the department
  // first. Falls back to the raw code if it's somehow not in COURSES
  // (e.g. "STAFF"), same as courseNameFor()-style helpers elsewhere.
  function departmentFor(code) {
    const group = COURSES.find((g) => g.options.some((o) => o.value === code));
    return group ? group.label : code;
  }

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
      loadPromotionResult(account.course_code),
      loadOverviewSummary(account.course_code),
    ]);
  }

  // Small stroke icons matching the sidebar nav's own icon style (18x18
  // viewBox, currentColor strokes) so each record echoes the tab it
  // lives in instead of introducing a new icon language.
  const ICONS = {
    bell: '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" aria-hidden="true"><path d="M9 3C7.1 3 5.6 4.6 5.6 6.5V9.3L4.2 11.4H13.8L12.4 9.3V6.5C12.4 4.6 10.9 3 9 3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7.4 13.4C7.4 14.3 8.1 15 9 15C9.9 15 10.6 14.3 10.6 13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    calendar: '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 7H15.5" stroke="currentColor" stroke-width="1.4"/><path d="M6 2V5M12 2V5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    resource: '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" aria-hidden="true"><path d="M3.5 3.5H10.5C11.6 3.5 12.5 4.4 12.5 5.5V14.5H5.5C4.4 14.5 3.5 13.6 3.5 12.5V3.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M12.5 5.5H13.5C13.5 5.5 14.5 5.5 14.5 6.5V13.5C14.5 13.5 14.5 14.5 13.5 14.5H5.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 6.5H10M6 9H10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    grade: '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" aria-hidden="true"><path d="M4 14.5V10M9 14.5V6M14 14.5V3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
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
      .select('id, title, message, audience, course_code, created_at, created_by')
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

    // Students should know who an announcement is from — role
    // ("Lecturer", "Admin", a job title) via the shared
    // fetchPosterLabels (app.js), name via a direct profiles lookup
    // (that helper deliberately doesn't include full_name — see its
    // comment), combined below into "Role Name" (e.g. "Lecturer Jane
    // Doe"), same as the staff dashboard's own announcement list.
    const posterIds = [...new Set(rows.map((a) => a.created_by).filter(Boolean))];
    const [posterLabels, posterNames] = await Promise.all([
      fetchPosterLabels(posterIds),
      posterIds.length
        ? supabaseClient.from('profiles').select('id, full_name').in('id', posterIds)
            .then(({ data }) => new Map((data || []).map((p) => [p.id, p.full_name])))
        : Promise.resolve(new Map()),
    ]);

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
      list.appendChild(item);
    });
  }

  async function loadTimetable(courseCode) {
    const list = document.getElementById('timetableList');
    if (!courseCode) { list.innerHTML = emptyState('No course has been selected yet.'); return; }

    const { data, error } = await supabaseClient
      .from('timetable')
      .select('file_name, file_url, updated_at, table_data, display_mode')
      .eq('course_code', courseCode)
      .maybeSingle();

    list.innerHTML = '';
    if (error) { console.error('Loading timetable failed:', error); list.innerHTML = emptyState('Timetable is not available right now.'); return; }
    const hasTable = data && data.display_mode === 'table' && data.table_data && data.table_data.length;
    if (!data || (!data.file_url && !hasTable)) { list.innerHTML = emptyState('No timetable has been uploaded for this course yet.'); return; }

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

    // The raw file is only offered when there is one, and/or when it's
    // the version the course has been set to show — a converted table
    // with no original link (or one the admin chose to keep hidden)
    // shouldn't offer a broken/irrelevant "Open" pill.
    if (data.file_url && (!hasTable || data.display_mode !== 'table')) {
      const fileLink = document.createElement('a');
      fileLink.className = 'record-action';
      fileLink.href = data.file_url;
      fileLink.target = '_blank';
      fileLink.rel = 'noopener noreferrer';
      fileLink.textContent = 'Open ↗';
      head.appendChild(fileLink);
    }

    item.appendChild(head);

    if (hasTable) {
      const tableWrap = document.createElement('div');
      tableWrap.className = 'tt-view-table-wrap';
      tableWrap.style.marginTop = '12px';
      TimetableEditor.renderTimetableView(tableWrap, data.table_data);
      item.appendChild(tableWrap);

      const exportRow = document.createElement('div');
      exportRow.className = 'tt-export-row';
      const pdfBtn = document.createElement('button');
      pdfBtn.type = 'button';
      pdfBtn.className = 'btn btn-secondary btn-sm';
      pdfBtn.textContent = 'Download as PDF';
      pdfBtn.addEventListener('click', async () => {
        pdfBtn.disabled = true;
        try { await TimetableEditor.exportTimetablePdf(data.table_data, data.file_name || 'Timetable'); }
        catch (err) { console.error('PDF export failed:', err); toast('Could not create the PDF.', 'error'); }
        finally { pdfBtn.disabled = false; }
      });
      const docxBtn = document.createElement('button');
      docxBtn.type = 'button';
      docxBtn.className = 'btn btn-secondary btn-sm';
      docxBtn.textContent = 'Download as Word';
      docxBtn.addEventListener('click', async () => {
        docxBtn.disabled = true;
        try { await TimetableEditor.exportTimetableDocx(data.table_data, data.file_name || 'Timetable'); }
        catch (err) { console.error('Word export failed:', err); toast('Could not create the Word document.', 'error'); }
        finally { docxBtn.disabled = false; }
      });
      exportRow.append(pdfBtn, docxBtn);
      item.appendChild(exportRow);
    } else if (data.file_url && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(data.file_url)) {
      // Show it inline if it looks like an image; otherwise the header's
      // "Open ↗" pill above is the only way in (e.g. a PDF).
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
      .eq('department', departmentFor(courseCode))
      .order('title');

    list.innerHTML = '';
    if (error) { console.error('Loading resources failed:', error); list.innerHTML = emptyState('Resources are not available right now.'); return; }
    const rows = data || [];
    if (!rows.length) { list.innerHTML = emptyState('No resources have been uploaded for this department yet.'); return; }

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

  // Grade (100%) is entered directly by staff (lecturer-home.js)
  // rather than derived from Attendance/Class work/Home work/Examination —
  // this just displays whatever was saved.
  const LETTER_LABEL = { A: 'A', B: 'B', C: 'C', F: 'F' };

  // Final Grade for a course = the average of the student's subject
  // scores (Grade 100%), turned into a letter with the same cut-offs
  // staff use when entering grades (lecturer-home.js): A 80+, B 70+,
  // C 60+, F below that. Kept here as its own copy — separate script.
  const FINAL_LETTER_THRESHOLDS = [['A', 80], ['B', 70], ['C', 60], ['F', 0]];
  function finalLetterFor(rows) {
    const scores = rows.map((r) => r.total_grade).filter((v) => v != null).map(Number).filter((n) => !Number.isNaN(n));
    if (!scores.length) return null;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    for (const [letter, min] of FINAL_LETTER_THRESHOLDS) if (avg >= min) return letter;
    return 'F';
  }
  function courseOption(code) {
    for (const group of COURSES) {
      const found = group.options.find((o) => o.value === code);
      if (found) return found;
    }
    return null;
  }
  // "Next level" = the same course code with its trailing number + 1
  // (ODCS1 -> ODCS2, TEC3 -> TEC4), if such a course exists. null means
  // there's no higher level (e.g. a Part 2 / final-year course).
  function nextLevelFor(code) {
    const m = /^(.*?)(\d+)$/.exec(code || '');
    if (!m) return null;
    return courseOption(m[1] + (Number(m[2]) + 1));
  }

  // One "Final Grade" card per course: the letter (A/B/C/F) and whether
  // staff have promoted the student to the next level of the course.
  function renderFinalGradeSummary(rows, promotions, finals) {
    const wrap = document.getElementById('finalGradeSummary');
    wrap.innerHTML = '';
    // Released final grades only (the database never returns the rest).
    (finals || []).forEach((fin) => {
      const courseCode = fin.course_code;
      const courseRows = rows.filter((r) => r.course_code === courseCode);
      const promo = promotions.get(courseCode);
      const next = nextLevelFor(courseCode);
      const courseName = (courseRows[0] && courseRows[0].course_name) || (courseOption(courseCode) || {}).label || courseCode;

      const card = document.createElement('div');
      card.className = 'card';
      const heading = document.createElement('h3');
      heading.style.margin = '0 0 12px';
      heading.textContent = 'Final Grade \u2014 ' + courseName;
      card.appendChild(heading);

      function row(label, valueNode) {
        const d = document.createElement('div');
        d.className = 'detail-row';
        const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
        const v = document.createElement('span'); v.className = 'value';
        v.appendChild(valueNode);
        d.append(l, v);
        card.appendChild(d);
      }

      const gradeBadge = document.createElement('span');
      gradeBadge.className = 'badge badge-grade-' + fin.letter_grade.toLowerCase();
      gradeBadge.textContent = 'Grade ' + fin.letter_grade + (fin.final_score != null ? ' (' + Number(fin.final_score) + '%)' : '');
      row('Final Grade', gradeBadge);

      let text; let cls = '';
      if (!promo) { text = 'Pending \u2014 not decided yet'; }
      else if (promo.promoted) {
        text = next ? `Promoted to ${next.label}` : 'Promoted \u2014 course completed';
        cls = 'badge-grade-a';
      } else {
        text = next ? `Not promoted to ${next.label}` : 'Not promoted';
        cls = 'badge-grade-f';
      }
      const promoNode = document.createElement('span');
      if (cls) promoNode.className = 'badge ' + cls;
      promoNode.textContent = text;
      row('Next level', promoNode);

      wrap.appendChild(card);
    });
  }

  // Overview "Result" — hidden while a promotion decision is pending
  // (no row in student_promotions). Once staff decide:
  //   promoted     -> "Course completed"
  //   not promoted -> "Not promoted – course failed"
  // Uses the student's current course; falls back to their most recent
  // decision if there isn't one for it.
  async function loadPromotionResult(courseCode) {
    const stat = document.getElementById('heroResultStat');
    const tag = document.getElementById('heroResultTag');
    stat.style.display = 'none';

    const { data, error } = await supabaseClient
      .from('student_promotions')
      .select('course_code, promoted, decided_at')
      .eq('student_id', currentUserId)
      .order('decided_at', { ascending: false });
    if (error) { console.warn('Loading promotion result failed:', error); return; }

    const rows = data || [];
    const decision = rows.find((r) => r.course_code === courseCode) || rows[0];
    if (!decision) return; // pending — stays hidden

    tag.classList.remove('tag-verified', 'tag-pending');
    tag.style.color = '';
    if (decision.promoted) {
      tag.textContent = 'Course completed';
      tag.classList.add('tag-verified');
    } else {
      tag.textContent = 'Not promoted – course failed';
      tag.style.color = '#F2B8B5';
    }
    stat.style.display = '';
  }

  /* ---------------- Overview summary ----------------
     Four click-through cards (average grade, new announcements, resources,
     timetable) plus a "Latest grades" panel. Own light queries so the
     existing tab loaders stay untouched; each one fails on its own. */

  const SO_LETTER_COLOR = { A: 'var(--success)', B: 'var(--blueprint)', C: 'var(--brass)', F: 'var(--danger)' };

  function soActivatable(el, handler, label) {
    el.classList.add('so-link');
    el.setAttribute('role', 'link');
    el.tabIndex = 0;
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  }

  function soGoTab(tabId) {
    const btn = document.querySelector('.nav-item[data-tab="' + tabId + '"]');
    if (!btn) return;
    switchTab(tabId, btn);
    window.scrollTo(0, 0);
  }

  function soScrollToAnnouncements() {
    const el = document.getElementById('announcementsSection');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function soRenderKpis(k) {
    const wrap = document.getElementById('soKpis');
    wrap.replaceChildren();
    k.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'card so-kpi';
      if (item.go) soActivatable(card, item.go, 'Open: ' + item.label);
      const l = document.createElement('div'); l.className = 'so-label'; l.textContent = item.label;
      const v = document.createElement('div'); v.className = 'so-value'; v.textContent = item.value;
      const s = document.createElement('div'); s.className = 'so-sub'; s.textContent = item.sub || '';
      card.append(l, v, s);
      wrap.appendChild(card);
    });
  }

  function soRenderGrades(rows, failed) {
    const list = document.getElementById('soGrades');
    list.replaceChildren();
    const note = (text) => { const p = document.createElement('p'); p.className = 'so-empty'; p.textContent = text; list.appendChild(p); };
    if (failed) { note('Grades are not available right now.'); return; }
    if (!rows.length) { note('No grades have been entered yet.'); return; }
    rows.slice(0, 4).forEach((r) => {
      const li = document.createElement('li');
      const top = document.createElement('div');
      top.className = 'so-bar-top';
      const name = document.createElement('span');
      name.textContent = r.subject || r.course_name || r.course_code || 'Subject';
      name.title = name.textContent;
      const score = document.createElement('span');
      score.className = 'so-score';
      const num = document.createElement('strong');
      num.textContent = r.total_grade == null ? '\u2014' : String(r.total_grade);
      score.appendChild(num);
      if (r.letter_grade) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-grade-' + String(r.letter_grade).toLowerCase();
        badge.textContent = r.letter_grade;
        score.appendChild(badge);
      }
      top.append(name, score);
      const track = document.createElement('div');
      track.className = 'so-track';
      track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('div');
      fill.className = 'so-fill';
      fill.style.background = SO_LETTER_COLOR[r.letter_grade] || 'var(--blueprint)';
      track.appendChild(fill);
      li.append(top, track);
      list.appendChild(li);
      const pct = Math.max(0, Math.min(100, Number(r.total_grade) || 0));
      requestAnimationFrame(() => { fill.style.width = pct + '%'; });
    });
  }

  async function loadOverviewSummary(courseCode) {
    const state = { avg: null, graded: 0, newAnn: null, resources: null, timetable: undefined };
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const filter = courseCode
      ? `audience.eq.everyone,audience.eq.all_students,and(audience.eq.course,course_code.eq.${courseCode})`
      : 'audience.eq.everyone,audience.eq.all_students';

    const [gradesRes, annRes, resRes, ttRes] = await Promise.allSettled([
      supabaseClient.from('grades')
        .select('course_code, course_name, subject, total_grade, letter_grade, updated_at')
        .eq('student_id', currentUserId).order('updated_at', { ascending: false }).limit(100),
      supabaseClient.from('announcements').select('id', { count: 'exact', head: true }).or(filter).gte('created_at', since),
      courseCode
        ? supabaseClient.from('resources').select('id', { count: 'exact', head: true }).eq('department', departmentFor(courseCode))
        : Promise.resolve({ count: null, error: null }),
      courseCode
        ? supabaseClient.from('timetable').select('updated_at, file_url, table_data, display_mode').eq('course_code', courseCode).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const ok = (r) => r.status === 'fulfilled' && !r.value.error;

    let gradeRows = [];
    const gradesFailed = !ok(gradesRes);
    if (!gradesFailed) {
      gradeRows = gradesRes.value.data || [];
      const scored = gradeRows.filter((r) => r.total_grade != null && !Number.isNaN(Number(r.total_grade)));
      state.graded = gradeRows.length;
      if (scored.length) state.avg = scored.reduce((sum, r) => sum + Number(r.total_grade), 0) / scored.length;
    }
    if (ok(annRes)) state.newAnn = annRes.value.count ?? 0;
    if (ok(resRes)) state.resources = resRes.value.count ?? 0;
    if (ok(ttRes)) {
      const t = ttRes.value.data;
      const has = t && (t.file_url || (t.display_mode === 'table' && t.table_data && t.table_data.length));
      state.timetable = has ? (t.updated_at || true) : null;
    }

    const dash = '\u2014';
    const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    soRenderKpis([
      { label: 'Average grade', value: state.avg == null ? dash : Math.round(state.avg) + '%',
        sub: gradesFailed ? 'Not available' : (state.graded ? 'across ' + state.graded + (state.graded === 1 ? ' subject' : ' subjects') : 'No grades yet'),
        go: () => soGoTab('grades') },
      { label: 'New announcements', value: state.newAnn == null ? dash : String(state.newAnn), sub: 'in the last 3 days', go: soScrollToAnnouncements },
      { label: 'Resources', value: state.resources == null ? dash : String(state.resources), sub: courseCode ? 'for your department' : 'Pick a course first', go: () => soGoTab('resources') },
      { label: 'Timetable',
        value: state.timetable === undefined ? dash : (state.timetable === null ? 'None' : (state.timetable === true ? 'Ready' : shortDate(state.timetable))),
        sub: state.timetable === null ? 'not uploaded yet' : (state.timetable ? 'last updated' : ''), go: () => soGoTab('timetable') },
    ]);
    soRenderGrades(gradeRows, gradesFailed);
  }

  (function wireGradesPanel() {
    const panel = document.getElementById('soGradesPanel');
    if (panel) soActivatable(panel, () => soGoTab('grades'), 'Open: Latest grades');
  })();

  async function loadGrades() {
    const list = document.getElementById('gradesList');
    document.getElementById('finalGradeSummary').innerHTML = '';

    const { data, error } = await supabaseClient
      .from('grades')
      .select('course_code, course_name, subject, attendance, class_work, home_work, examination, total_grade, letter_grade, updated_at')
      .eq('student_id', currentUserId)
      .order('updated_at', { ascending: false });

    list.innerHTML = '';
    if (error) {
      console.error('Loading grades failed:', error);
      list.innerHTML = emptyState('Grades are not available right now.');
      return;
    }

    const rows = data || [];
    if (!rows.length) {
      list.innerHTML = emptyState('No grades have been entered yet.');
      return;
    }

    // Promotion decisions are set by staff (student_promotions table,
    // see promotions.sql). If the table isn't there yet, everything
    // just reads "Pending".
    const promotions = new Map();
    const promoRes = await supabaseClient
      .from('student_promotions')
      .select('course_code, promoted')
      .eq('student_id', currentUserId);
    if (promoRes.error) console.warn('Loading promotion status failed:', promoRes.error);
    (promoRes.data || []).forEach((p) => promotions.set(p.course_code, p));
    const finalRes = await supabaseClient
      .from('final_grades')
      .select('course_code, final_score, letter_grade')
      .eq('student_id', currentUserId)
      .eq('released', true);
    if (finalRes.error) console.warn('Loading final grades failed:', finalRes.error);
    renderFinalGradeSummary(rows, promotions, finalRes.data || []);

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
      title.textContent = r.subject || r.course_name || r.course_code;
      headText.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'record-meta';
      if (r.subject && (r.course_name || r.course_code)) {
        const courseSpan = document.createElement('span');
        courseSpan.textContent = r.course_name || r.course_code;
        meta.appendChild(courseSpan);
      }
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

      // Grade (100%) is the headline number — always visible in its
      // own row rather than buried among the four component scores
      // below.
      if (r.total_grade != null) {
        const headlineRow = document.createElement('div');
        headlineRow.className = 'headline-row';
        const stat = document.createElement('div');
        stat.className = 'headline-stat';
        stat.innerHTML = '<span class="label">Grade (100%)</span>';
        const v = document.createElement('span'); v.className = 'value'; v.textContent = r.total_grade;
        stat.appendChild(v);
        headlineRow.appendChild(stat);
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
  }

  // Lecturer picker for the Feedback tab — any staff/admin account is a
  // valid feedback target, not just people teaching the student's own
  // course, since a student may want to leave feedback about someone
  // outside their current course. Loaded once; the list doesn't change
  // often enough to need refreshing per tab visit.
  //
  // Non-teaching job titles are excluded — technicians, the
  // administration team, the principal, and the deputy/vice principal
  // aren't rated. Kept in sync with the same exclusion enforced
  // server-side in feedback-schema.sql (course_feedback_insert policy).
  const UNRATABLE_JOB_TITLES = ['technician', 'administration', 'principal', 'deputy_principal'];

  async function loadFeedbackLecturers() {
    const select = document.getElementById('feedbackLecturer');
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, full_name, email, role, job_title')
      .in('role', ['staff', 'admin'])
      .order('full_name');

    if (error) { console.error('Loading lecturers for feedback failed:', error); return; }

    select.innerHTML = '<option value="">-- Select a lecturer --</option>';
    (data || [])
      .filter((p) => !UNRATABLE_JOB_TITLES.includes(p.job_title))
      .forEach((p) => {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = (p.full_name || p.email || 'Unnamed') + ' — ' + displayRoleLabel(p);
        select.appendChild(option);
      });
  }

  // Whether an admin has locked "Lecturer & course feedback" — checked
  // on load and re-checked right before submit, since the lock can be
  // flipped by an admin (from the Feedback tab on the staff portal) in
  // a different tab at any time. The real gate is the RLS policy on
  // course_feedback (see feedback-schema.sql); this is only so the
  // student isn't surprised by a rejected insert.
  let courseFeedbackLocked = false;

  async function refreshCourseFeedbackLockState() {
    const { data, error } = await supabaseClient
      .from('feedback_settings')
      .select('lecturer_feedback_locked')
      .eq('id', 1)
      .maybeSingle();
    if (error) { console.error('Loading feedback lock state failed:', error); return; }
    courseFeedbackLocked = !!(data && data.lecturer_feedback_locked);

    // The banner (markup in home.html) carries its own fixed message, so
    // there's nothing to set here beyond show/hide — and disabling the
    // fieldset disables every field and the submit button inside it in
    // one move, natively, rather than needing to walk each control.
    const notice = document.getElementById('courseFeedbackLockNotice');
    const fieldset = document.getElementById('feedbackFieldset');
    const pill = document.getElementById('feedbackLockedPill');
    notice.hidden = !courseFeedbackLocked;
    fieldset.disabled = courseFeedbackLocked;
    if (pill) pill.hidden = !courseFeedbackLocked;
  }

  document.getElementById('courseFeedbackForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('feedbackStatus');
    const submitBtn = document.getElementById('feedbackSubmit');

    await refreshCourseFeedbackLockState();
    if (courseFeedbackLocked) {
      setStatus(status, 'This form is currently locked by an administrator.', 'error');
      return;
    }

    const lecturerId = document.getElementById('feedbackLecturer').value;
    const courseCode = document.getElementById('feedbackCourse').value;
    const rating = document.getElementById('feedbackRating').value;
    const comments = document.getElementById('feedbackComments').value.trim();

    if (!lecturerId) { setStatus(status, 'Please select a lecturer.', 'error'); return; }
    if (!courseCode) { setStatus(status, 'Please select a course.', 'error'); return; }
    if (!rating) { setStatus(status, 'Please select a rating.', 'error'); return; }

    submitBtn.disabled = true;
    setStatus(status, '', null);

    // No student id is sent — this table has no such column, so the
    // submission is anonymous by construction, not just by convention.
    const { error } = await supabaseClient.from('course_feedback').insert({
      course_code: courseCode,
      lecturer_id: lecturerId,
      rating: Number(rating),
      comments: comments || null,
    });

    submitBtn.disabled = false;

    if (error) {
      console.error('Submitting course feedback failed:', error);
      setStatus(status, courseFeedbackLocked ? 'This form is currently locked by an administrator.' : 'Could not submit feedback. Please try again.', 'error');
      return;
    }

    setStatus(status, 'Thanks — your anonymous feedback has been submitted.', 'success');
    toast('Feedback submitted anonymously.', 'success');
    document.getElementById('courseFeedbackForm').reset();
    syncCourseSelectDisplay(document.getElementById('feedbackCourse'));
  });

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
  loadFeedbackLecturers();
  refreshCourseFeedbackLockState();
})();