(function () {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') === 'edit' ? 'edit' : 'view';

  const titleEl = document.getElementById('ttPopupTitle');
  const statusEl = document.getElementById('ttPopupStatus');
  const container = document.getElementById('ttPopupContainer');
  const actions = document.getElementById('ttPopupActions');

  if (!window.opener) {
    statusEl.textContent = 'This page only works when opened from the timetable editor — please go back and use "Open in new tab" there.';
    statusEl.classList.add('visible', 'error');
    return;
  }

  let editorHandle = null;
  let rows = [['']];
  let title = 'Timetable';

  function mkBtn(label, onClick, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls || 'btn btn-secondary btn-sm';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function currentRows() {
    return editorHandle ? editorHandle.getRows() : rows;
  }

  function renderActions() {
    actions.innerHTML = '';
    if (mode === 'edit') {
      actions.appendChild(mkBtn('Save changes', () => {
        window.opener.postMessage({ type: 'tt-popup-save', rows: currentRows() }, window.location.origin);
        statusEl.textContent = 'Sent back to the form — click Save there to store it for good.';
        statusEl.classList.add('visible', 'success');
      }, 'btn btn-sm'));
    }
    actions.appendChild(mkBtn('Download as PDF', async (e) => {
      e.target.disabled = true;
      try { await TimetableEditor.exportTimetablePdf(currentRows(), title); }
      finally { e.target.disabled = false; }
    }));
    actions.appendChild(mkBtn('Download as Word', async (e) => {
      e.target.disabled = true;
      try { await TimetableEditor.exportTimetableDocx(currentRows(), title); }
      finally { e.target.disabled = false; }
    }));
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin || e.source !== window.opener) return;
    if (e.data && e.data.type === 'tt-popup-init') {
      rows = (e.data.rows && e.data.rows.length) ? e.data.rows : [['']];
      title = e.data.title || 'Timetable';
      titleEl.textContent = title;
      document.title = title;
      if (mode === 'edit') {
        editorHandle = TimetableEditor.renderTimetableEditor(container, rows, {});
      } else {
        TimetableEditor.renderTimetableView(container, rows);
      }
      renderActions();
    }
  });

  // Best-effort: if they just close the tab instead of clicking "Save
  // changes", still try to hand the latest edits back to the opener.
  window.addEventListener('beforeunload', () => {
    if (mode === 'edit' && editorHandle) {
      try { window.opener.postMessage({ type: 'tt-popup-save', rows: editorHandle.getRows() }, window.location.origin); } catch {}
    }
  });

  window.opener.postMessage({ type: 'tt-popup-ready' }, window.location.origin);
})();