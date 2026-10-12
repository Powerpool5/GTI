(function () {
  const wrap = document.getElementById('offlineContent');
  const status = document.getElementById('offlineStatus');
  const retry = document.getElementById('offlineRetry');

  function fmt(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function empty(text) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = text;
    wrap.appendChild(p);
  }

  const rec = GTITimetableCache.load();

  if (!rec) {
    document.getElementById('offlineTitle').textContent = "You're offline";
    empty('There is no saved timetable on this device yet. Open the portal once while connected and view the Timetable tab, and it will be available here next time.');
  } else {
    const data = rec.data;
    document.getElementById('offlineTitle').textContent = data.file_name || 'Timetable';
    const meta = document.createElement('div');
    meta.className = 'record-meta';
    const parts = [];
    if (data.updated_at) parts.push('Timetable updated ' + fmt(data.updated_at));
    parts.push('Saved on this device ' + fmt(rec.savedAt));
    meta.textContent = parts.join(' · ');
    wrap.appendChild(meta);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'tt-view-table-wrap';
    wrap.appendChild(tableWrap);
    TimetableEditor.renderTimetableView(tableWrap, data.table_data);
  }

  status.textContent = 'This may not be the latest version. It refreshes the next time you open the portal while connected.';
  status.classList.add('visible', 'info');

  retry.addEventListener('click', () => { window.location.href = 'home.html'; });
  window.addEventListener('online', () => { window.location.replace('home.html'); });
})();