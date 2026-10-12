(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  let installPrompt = null;

  function installButton() { return document.getElementById('installAppBtn'); }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    const btn = installButton();
    if (btn) btn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    const btn = installButton();
    if (btn) btn.hidden = true;
  });

  document.addEventListener('DOMContentLoaded', () => {
    const btn = installButton();
    if (!btn) return;
    if (installPrompt) btn.hidden = false;
    btn.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      try { await installPrompt.userChoice; } catch {}
      installPrompt = null;
      btn.hidden = true;
    });
  });
})();

(function () {
  const STYLE = [
    '.gti-net-banner{position:sticky;top:0;z-index:40;display:none;align-items:center;justify-content:center;gap:8px;',
    'padding:8px 14px;padding-top:calc(8px + env(safe-area-inset-top,0px));font-size:.88rem;font-weight:600;text-align:center;',
    'background:#fde8b0;color:#4a3200;border-bottom:1px solid rgba(74,50,0,.25)}',
    '.gti-net-banner.show{display:flex}',
    '.gti-net-banner.online{background:#d9f2e1;color:#0f5132;border-bottom-color:rgba(15,81,50,.25)}',
    '.gti-net-dot{width:9px;height:9px;border-radius:50%;background:currentColor;flex:none}',
    'html.gti-net-on .app-header{top:var(--gti-net-h,0px)}',
  ].join('');

  let banner = null;
  let textEl = null;
  let hideTimer = null;

  function build() {
    if (banner) return;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    banner = document.createElement('div');
    banner.className = 'gti-net-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    const dot = document.createElement('span');
    dot.className = 'gti-net-dot';
    dot.setAttribute('aria-hidden', 'true');
    textEl = document.createElement('span');
    banner.append(dot, textEl);
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function setOffsets(on) {
    const root = document.documentElement;
    root.classList.toggle('gti-net-on', on);
    root.style.setProperty('--gti-net-h', on ? banner.offsetHeight + 'px' : '0px');
  }

  function showOffline() {
    build();
    window.clearTimeout(hideTimer);
    banner.classList.remove('online');
    banner.classList.add('show');
    textEl.textContent = "You're offline. Saved data is shown where available, and some features won't work until you reconnect.";
    setOffsets(true);
  }

  function showOnline() {
    if (!banner || !banner.classList.contains('show')) return;
    banner.classList.add('online');
    textEl.textContent = "You're back online.";
    setOffsets(true);
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      banner.classList.remove('show', 'online');
      setOffsets(false);
    }, 3000);
  }

  function sync() { if (navigator.onLine === false) showOffline(); }

  window.addEventListener('offline', showOffline);
  window.addEventListener('online', showOnline);
  window.addEventListener('resize', () => { if (banner && banner.classList.contains('show')) setOffsets(true); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
  else sync();
})();