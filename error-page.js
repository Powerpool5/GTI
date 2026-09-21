/* Custom error pages (404.html, 403.html, 500.html, 503.html, error.html).
   Static text is already in each page's HTML (so it works without JavaScript);
   this script adds the parts that need the browser:
     - shows which address was requested (404)
     - wires "Go back" / "Try again"
     - error.html?code=NNN (or ?code=offline) picks any message below
     - a reference + time to quote when reporting a problem
   Everything is written with textContent — nothing from the URL is ever inserted as HTML. */
(function () {
  const MESSAGES = {
  "400": {
    "title": "That request didn't look right",
    "msg": "The link or form that brought you here was incomplete or garbled. Go back and try again.",
    "actions": [
      "back",
      "portal"
    ]
  },
  "401": {
    "title": "Please sign in",
    "msg": "You need to be signed in to see this page. Sign in and you'll be able to continue.",
    "actions": [
      "signin",
      "back"
    ]
  },
  "403": {
    "title": "Access denied",
    "msg": "Your account doesn't have permission to open this page. If you think it should, ask your department or an administrator.",
    "actions": [
      "portal",
      "signin"
    ]
  },
  "404": {
    "title": "Page not found",
    "msg": "This page doesn't exist, has moved, or the link is out of date.",
    "actions": [
      "portal",
      "back"
    ]
  },
  "408": {
    "title": "That took too long",
    "msg": "The connection timed out before the page could load. Check your internet and try again.",
    "actions": [
      "retry",
      "portal"
    ]
  },
  "429": {
    "title": "Slow down for a moment",
    "msg": "Too many requests were sent in a short time. Wait a minute, then try again.",
    "actions": [
      "retry",
      "portal"
    ]
  },
  "500": {
    "title": "Something went wrong",
    "msg": "Something broke on our side — it isn't anything you did. Try again in a moment.",
    "actions": [
      "retry",
      "portal"
    ]
  },
  "502": {
    "title": "Server not responding",
    "msg": "The portal couldn't get a proper answer from the server. This usually clears up quickly — try again shortly.",
    "actions": [
      "retry",
      "portal"
    ]
  },
  "503": {
    "title": "Temporarily unavailable",
    "msg": "The portal is being updated or is temporarily down. Please check back in a little while.",
    "actions": [
      "retry",
      "portal"
    ]
  },
  "504": {
    "title": "The server took too long",
    "msg": "The server didn't answer in time. Wait a moment and try again.",
    "actions": [
      "retry",
      "portal"
    ]
  },
  "offline": {
    "title": "You're offline",
    "msg": "Your device isn't connected to the internet. Check your connection — this page will reload by itself when you're back online.",
    "actions": [
      "retry"
    ]
  }
};
  const GENERIC = {
  "title": "Something went wrong",
  "msg": "An unexpected error happened. Try again, or go back to the portal.",
  "actions": [
    "retry",
    "portal"
  ]
};

  const body = document.body;
  const params = new URLSearchParams(window.location.search);
  const $ = (id) => document.getElementById(id);

  let code = body.dataset.code || '';
  const generic = body.dataset.generic === 'true';

  if (generic) {
    // error.html?code=NNN — only known codes are shown; anything else gets the generic message.
    const requested = (params.get('code') || '').toLowerCase();
    if (!requested && navigator.onLine === false) code = 'offline';
    else code = Object.prototype.hasOwnProperty.call(MESSAGES, requested) ? requested : '';
    const info = MESSAGES[code] || GENERIC;
    const shownCode = code === 'offline' ? '!' : (code || (/^\d{3}$/.test(requested) ? requested : '!'));
    $('errorCode').textContent = shownCode;
    $('errorTitle').textContent = info.title;
    $('errorMessage').textContent = info.msg;
    document.title = (code && code !== 'offline' ? code + ' · ' : '') + info.title + ' - GTI Portal';
    const wanted = info.actions;
    const container = $('errorActions');
    document.querySelectorAll('#errorActions [data-action]').forEach((el) => { el.hidden = !wanted.includes(el.dataset.action); });
    // Put the actions in the message's own order; the first one is the primary (filled) button.
    wanted.slice().reverse().forEach((key) => {
      const el = container.querySelector('[data-action="' + key + '"]');
      if (el) container.insertBefore(el, container.firstChild);
    });
    container.querySelectorAll('[data-action]').forEach((el) => el.classList.add('btn-secondary'));
    const first = container.querySelector('[data-action]:not([hidden])');
    if (first) first.classList.remove('btn-secondary');
  }

  // 404: show the address that was asked for (so it's easy to spot a typo).
  if (code === '404') {
    const path = (window.location.pathname + window.location.search).slice(0, 200);
    const box = $('errorPath');
    box.textContent = path;
    box.hidden = false;
  }

  // "Go back" only when there is somewhere on this site to go back to.
  const back = document.querySelector('[data-action="back"]');
  if (back) {
    const cameFromSite = document.referrer && (function () { try { return new URL(document.referrer).origin === window.location.origin; } catch (e) { return false; } })();
    if (!cameFromSite && window.history.length <= 1) back.hidden = true;
    back.addEventListener('click', () => { window.history.back(); });
  }

  const retry = document.querySelector('[data-action="retry"]');
  if (retry) retry.addEventListener('click', () => { window.location.reload(); });

  // Offline: come back by itself as soon as the connection returns.
  if (code === 'offline') window.addEventListener('online', () => { window.location.reload(); });

  // A short reference + time for server-side problems, so a report can be matched up.
  if (/^(5\d\d|408|429|offline)$/.test(code) || (generic && !code)) {
    const stamp = new Date();
    const ref = (code || 'ERR').toUpperCase() + '-' + stamp.getTime().toString(36).toUpperCase().slice(-5);
    $('errorMeta').textContent = 'Reference ' + ref + ' · ' + stamp.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
})();