(function () {
  const CALENDAR_ICON = '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 7H15.5" stroke="currentColor" stroke-width="1.4"/><path d="M6 2V5M12 2V5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const EMPTY_ICON = '<svg viewBox="0 0 32 32" width="28" height="28" fill="none" aria-hidden="true"><rect x="6" y="8" width="20" height="17" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M6 14H26M11 4V8M21 4V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  const list = document.getElementById('timetableList');

  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Header details saved by the Android app while online; the browser version
  // doesn't save them, so there the name area simply stays hidden.
  const profile = GTITimetableCache.loadProfile();
  if (profile) {
    document.getElementById('headerName').textContent = profile.name;
    const slot = document.getElementById('avatarSlot');
    const initial = document.createElement('div');
    initial.className = 'avatar-fallback';
    initial.textContent = (profile.name || '?').trim().charAt(0).toUpperCase();
    slot.appendChild(initial);
    document.getElementById('offlineUser').hidden = false;
    document.getElementById('offlineSignOut').hidden = false;
  }

  const rec = GTITimetableCache.load();
  const data = rec && rec.data;

  if (!data) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.innerHTML = EMPTY_ICON;
    const span = document.createElement('span');
    span.textContent = 'No saved timetable on this device yet. Open the portal once while connected and view the Timetable tab; it will be available here next time.';
    li.appendChild(span);
    list.appendChild(li);
  } else {
    const item = document.createElement('li');
    item.className = 'record';

    const head = document.createElement('div');
    head.className = 'record-head';
    const headMain = document.createElement('div');
    headMain.className = 'record-head-main';
    const icon = document.createElement('span');
    icon.className = 'record-icon';
    icon.innerHTML = CALENDAR_ICON;
    const headText = document.createElement('div');
    headText.className = 'record-head-text';

    const title = document.createElement('div');
    title.className = 'record-title';
    title.textContent = data.file_name || 'Timetable';
    headText.appendChild(title);

    if (data.updated_at) {
      const meta = document.createElement('div');
      meta.className = 'record-meta';
      meta.textContent = 'Updated ' + fmtDate(data.updated_at);
      headText.appendChild(meta);
    }
    const note = document.createElement('div');
    note.className = 'record-meta';
    note.textContent = 'Saved copy from ' + fmtDateTime(rec.savedAt) + '. It refreshes the next time you open the portal while connected.';
    headText.appendChild(note);

    headMain.append(icon, headText);
    head.appendChild(headMain);
    item.appendChild(head);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'tt-view-table-wrap';
    tableWrap.style.marginTop = '12px';
    TimetableEditor.renderTimetableView(tableWrap, data.table_data);
    item.appendChild(tableWrap);
    list.appendChild(item);
  }

  // Tapping any other section only tells the student they're offline.
  const notice = document.getElementById('offlineNotice');
  let noticeTimer = null;
  document.querySelectorAll('.nav-item[aria-disabled="true"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      notice.textContent = "You're offline. Connect to the internet to open " + btn.textContent.trim() + '.';
      notice.classList.add('visible', 'info');
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => notice.classList.remove('visible', 'info'), 3500);
    });
  });

  // Back to the real portal as soon as a connection exists. The browser's
  // "online" event is unreliable inside some phone web views, so also check
  // every few seconds. The Android app opens this page from its own storage
  // and sets GTI_HOME_URL to the live site's address (see gti-app/prepare.js).
  const home = window.GTI_HOME_URL || 'home.html';
  function goOnline() { window.location.replace(home); }
  window.addEventListener('online', goOnline);
  window.setInterval(() => {
    fetch(home, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' })
      .then(goOnline)
      .catch(() => {});
  }, 5000);
})();