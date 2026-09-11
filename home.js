(function () {
  const loadingMessage = document.getElementById('loadingMessage');
  const appShell = document.getElementById('appShell');
  const signOutButton = document.getElementById('signOutButton');
  const courseChangeForm = document.getElementById('courseChangeForm');

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

    document.getElementById('studentName').textContent = account.full_name || 'Student';
    document.getElementById('studentId').textContent = account.student_id || 'Not provided';
    document.getElementById('studentEmail').textContent = user.email || '';
    document.getElementById('studentCourse').textContent = account.course_name || 'Not selected';
    document.getElementById('studentVerified').textContent = account.verified ? 'Verified' : 'Pending verification';
    document.getElementById('courseChange').value = account.course_code || '';
    document.getElementById('headerName').textContent = account.full_name || user.email || '';
    renderAvatar(document.getElementById('avatarSlot'), account.full_name || user.email, account.avatar_url);

    loadingMessage.hidden = true;
    appShell.hidden = false;
    signOutButton.hidden = false;

    if (wasReactivated) {
      toast('Welcome back — your account has been reactivated.', 'success', 6000);
    }

    await Promise.all([
      loadAnnouncements(account.course_code),
      loadTimetable(account.course_code),
    ]);
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

    if (error) { list.innerHTML = '<li class="empty-state">Announcements are not available right now.</li>'; return; }
    if (!data.length) { list.innerHTML = '<li class="empty-state">No announcements yet.</li>'; return; }

    data.forEach((a) => {
      const item = document.createElement('li');
      item.className = 'record';

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

      const body = document.createElement('div');
      body.className = 'record-body';
      body.textContent = a.message;

      item.append(title, meta, body);
      list.appendChild(item);
    });
  }

  async function loadTimetable(courseCode) {
    const list = document.getElementById('timetableList');
    if (!courseCode) { list.innerHTML = '<li class="empty-state">No course has been selected yet.</li>'; return; }

    const { data, error } = await supabaseClient
      .from('timetable')
      .select('day_name, start_time, end_time, subject, room, lecturer_name, file_name, file_url')
      .eq('course_code', courseCode)
      .order('day_name')
      .order('start_time');

    list.innerHTML = '';
    if (error) { list.innerHTML = '<li class="empty-state">Timetable is not available right now.</li>'; return; }
    if (!data.length) { list.innerHTML = '<li class="empty-state">No timetable entries for this course yet.</li>'; return; }

    data.forEach((entry) => {
      const item = document.createElement('li');
      item.className = 'record';

      const title = document.createElement('div');
      title.className = 'record-title';
      title.textContent = entry.subject;

      const meta = document.createElement('div');
      meta.className = 'record-meta';
      meta.textContent = `${entry.day_name} · ${entry.start_time}–${entry.end_time}`;

      const body = document.createElement('div');
      body.className = 'record-body';
      const bits = [];
      if (entry.room) bits.push(`Room ${entry.room}`);
      if (entry.lecturer_name) bits.push(entry.lecturer_name);
      body.textContent = bits.join(' · ');

      item.append(title, meta, body);

      if (entry.file_url) {
        const fileLink = document.createElement('a');
        fileLink.className = 'file-link';
        fileLink.href = entry.file_url;
        fileLink.target = '_blank';
        fileLink.rel = 'noopener noreferrer';
        fileLink.textContent = entry.file_name || 'Open file';
        item.appendChild(fileLink);
      }
      list.appendChild(item);
    });
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

    setStatus(status, 'Course updated successfully.', 'success');
    toast('Course updated to ' + courseName, 'success');
    window.setTimeout(() => window.location.reload(), 800);
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