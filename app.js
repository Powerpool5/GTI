/* =========================================================
   GTI Student Portal — shared client script (v3)
   Loaded on index.html, home.html, lecturer-login.html, and
   lecturer-home.html.

   IMPORTANT — about "rate limiting" from the browser:
   Nothing in this file can stop an attacker who calls the
   Supabase API directly, skipping the page entirely. The
   throttle below only slows down someone using the *form*,
   as a UX nicety. Real brute-force protection has to be
   enabled server-side — see SECURITY.md.
   ========================================================= */

// The anon key below is meant to be public — Supabase's security model
// relies on Row Level Security (RLS) policies on the database, not on
// hiding this key. Never put a service_role key in client code.
const SUPABASE_URL = "https://iqcwrberwzumxxjktgux.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_bD6Za9HNb0bu72OfMylG1g_J_0yWV0K";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/* -------------------------------------------------------
   Status message helper (always textContent, never
   innerHTML — nothing rendered here can execute markup)
   ------------------------------------------------------- */
function setStatus(el, message, kind) {
  if (!el) return;
  el.textContent = message;
  el.classList.remove("error", "success", "visible");
  if (message) el.classList.add("visible", kind === "error" ? "error" : "success");
}

/* -------------------------------------------------------
   Toasts — non-blocking notifications, replaces alert().
   ------------------------------------------------------- */
function toast(message, kind = "info", duration = 4000) {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message; // textContent only — message may include user-entered text
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  window.setTimeout(() => {
    el.classList.remove("visible");
    window.setTimeout(() => el.remove(), 300);
  }, duration);
}

/* -------------------------------------------------------
   Client-side attempt throttle (UX layer only — see notice
   above). Escalating delay after repeated failures, stored
   per-browser in localStorage.
   ------------------------------------------------------- */
class AttemptThrottle {
  constructor(key, { maxFreeAttempts = 3, baseDelayMs = 2000, maxDelayMs = 60000 } = {}) {
    this.storageKey = `throttle:${key}`;
    this.maxFreeAttempts = maxFreeAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }
  _read() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : { count: 0, lockedUntil: 0 };
    } catch {
      return { count: 0, lockedUntil: 0 };
    }
  }
  _write(state) {
    try { localStorage.setItem(this.storageKey, JSON.stringify(state)); } catch {}
  }
  msUntilAllowed() {
    return Math.max(0, this._read().lockedUntil - Date.now());
  }
  recordFailure() {
    const state = this._read();
    state.count += 1;
    if (state.count > this.maxFreeAttempts) {
      const extra = state.count - this.maxFreeAttempts;
      const delay = Math.min(this.baseDelayMs * 2 ** (extra - 1), this.maxDelayMs);
      state.lockedUntil = Date.now() + delay;
    }
    this._write(state);
  }
  reset() { this._write({ count: 0, lockedUntil: 0 }); }
}

/* -------------------------------------------------------
   Tab switching (nav-item <-> tab-content), wired up via
   data-tab attributes rather than inline onclick (the CSP
   on every page blocks inline event handlers).
   ------------------------------------------------------- */
function switchTab(tabId, triggerEl) {
  document.querySelectorAll(".tab-content").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.remove("active");
    el.setAttribute("aria-selected", "false");
  });
  const panel = document.getElementById(tabId);
  if (panel) panel.classList.add("active");
  if (triggerEl) {
    triggerEl.classList.add("active");
    triggerEl.setAttribute("aria-selected", "true");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab, btn));
  });
});

/* -------------------------------------------------------
   Tiny shared read cache — every page loads this file, so it's the
   one place a cache can actually be shared across the functions that
   independently ask for the same thing. Two things land here:

   1. system_status — checkLockdownBlock() below, the maintenance
      poll further down, and admin.js's own System tab were each
      firing their own independent read of the same single row,
      often within the same second of each other on page load.
   2. has_staff_access / is_admin / is_super_admin — cheap RPCs, but
      requireAdmin() alone calls all three, and lecturer-login.js
      calls two of them again right after sign-in. The role behind
      them doesn't change mid-session in practice.

   Deliberately NOT a general-purpose data cache — announcements,
   grades, timetable etc. are personalized/RLS-scoped and only ever
   fetched once per page load anyway, so there's nothing to dedupe
   there. TTLs are short; callers that need certainty immediately
   after a write (admin.js publishing a banner, toggling lockdown)
   call invalidateCache() for that key rather than trust the TTL.
   ------------------------------------------------------- */
const _cache = new Map(); // key -> { value: Promise, expires: number }

function cached(key, ttlMs, fetcher) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = Promise.resolve().then(fetcher).catch((err) => { _cache.delete(key); throw err; });
  _cache.set(key, { value, expires: now + ttlMs });
  return value;
}

function invalidateCache(key) {
  if (key) _cache.delete(key);
  else _cache.clear();
}

const SYSTEM_STATUS_CACHE_TTL_MS = 4000; // just under the 5s banner poll below, so it stays effectively live
const ROLE_CACHE_TTL_MS = 30000;

/** The single system_status row (id=1), used by the lockdown check,
 *  the maintenance/lockdown banner poll, and admin.html's System tab. */
function getSystemStatus() {
  return cached("system_status", SYSTEM_STATUS_CACHE_TTL_MS, async () => {
    const { data, error } = await supabaseClient
      .from("system_status")
      .select("maintenance_mode, maintenance_message, banner_style, lockdown_enabled, lockdown_message, lockdown_style")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;
    return data;
  });
}

function getStaffAccess() {
  return cached("rpc:has_staff_access", ROLE_CACHE_TTL_MS, async () => {
    const { data } = await supabaseClient.rpc("has_staff_access");
    return data;
  });
}
function getIsAdmin() {
  return cached("rpc:is_admin", ROLE_CACHE_TTL_MS, async () => {
    const { data } = await supabaseClient.rpc("is_admin");
    return data;
  });
}
function getIsSuperAdmin() {
  return cached("rpc:is_super_admin", ROLE_CACHE_TTL_MS, async () => {
    const { data } = await supabaseClient.rpc("is_super_admin");
    return data;
  });
}

/* -------------------------------------------------------
   Lockdown mode — a root-only kill switch (system_status.lockdown_enabled)
   that blocks everyone except admins from being in the portal. Toggled
   from the "System" tab in admin.html.

   Like the maintenance/connectivity banner below, this is a UX-layer
   gate: it signs the person out and sends them back to the sign-in
   page, but a stolen token used directly against the Supabase API
   would only be stopped by an RLS policy or an Auth Hook, not by this
   function. See SECURITY.md for the real gate.
   ------------------------------------------------------- */
const DEFAULT_LOCKDOWN_MESSAGE =
  "The portal is temporarily locked down by an administrator. Please try again shortly.";

/**
 * Returns a message string if the current session belongs to someone
 * who should be turned away right now (lockdown is on and they're not
 * an admin), signing them out in the process. Returns null otherwise —
 * including when lockdown is off, or the caller is an admin/root.
 */
async function checkLockdownBlock() {
  try {
    const data = await getSystemStatus();
    if (!data || data.lockdown_enabled !== true) return null;

    const isAdmin = await getIsAdmin();
    if (isAdmin === true) return null; // admins and root always get through

    await supabaseClient.auth.signOut();
    const message = data.lockdown_message || DEFAULT_LOCKDOWN_MESSAGE;
    // Hand the admin's message + banner style to lockdown.html (the lockdown's own
    // page) so it can show them straight away, before it re-reads the live row.
    try {
      sessionStorage.setItem("gti-lockdown", JSON.stringify({ message, style: data.lockdown_style || "warning" }));
    } catch {}
    return message;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------
   Session / role guards
   ------------------------------------------------------- */
async function requireSession() {
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error || !session) {
    window.location.href = "index.html";
    return null;
  }

  // Checked on every authenticated page load (home, admin, staff
  // dashboard all funnel through here) so a lockdown flipped on while
  // someone is already signed in still catches them on their next
  // navigation/reload, not just at their next sign-in attempt.
  const lockdownMessage = await checkLockdownBlock();
  if (lockdownMessage) {
    window.location.href = "lockdown.html";
    return null;
  }

  return session;
}

/** Redirects visitors without staff/admin access to the staff login.
 *  Returns {session, profile, isAdmin} for staff and admins alike —
 *  isAdmin is true only for full admins, used to show/hide
 *  admin-only controls (like changing someone's role) in the UI. */
async function requireAdmin() {
  const session = await requireSession();
  if (!session) return null;

  // Single source of truth: the same has_staff_access() RPC that
  // lecturer-login.js uses, so the two checks can never disagree and
  // bounce back and forth (that disagreement used to cause a redirect
  // loop between this page and the staff login page). Root outranks
  // role though — an account can be granted root (is_super_admin)
  // without being staff/admin by role (see the Root badge in
  // admin.html / lecturer-home.html, tracked separately from role) —
  // so root always counts as access here too, even when
  // has_staff_access() alone would say no.
  let hasAccess, isSuperAdmin, accessError;
  try {
    [hasAccess, isSuperAdmin] = await Promise.all([getStaffAccess(), getIsSuperAdmin()]);
  } catch (err) {
    accessError = err;
  }

  if (accessError && isSuperAdmin !== true) {
    window.location.href = "lecturer-login.html?denied=1";
    return null;
  }
  if (hasAccess !== true && isSuperAdmin !== true) {
    // Note: this is a UX redirect only. The real gate is the RLS
    // policies on the tables the staff dashboard writes to — even if
    // someone bypassed this redirect, every insert/update/delete call
    // would still be rejected by Postgres.
    window.location.href = "lecturer-login.html?denied=1";
    return null;
  }

  const isAdmin = await getIsAdmin();
  // is_admin() also returns true for super admins (root outranks
  // role), so it alone can't tell an ordinary admin apart from a super
  // admin for UI purposes like the Root toggle — isSuperAdmin (above)
  // covers that distinction.

  // Purely for display (name/avatar in the header) — not part of the
  // gate above, so a hiccup here can't kick a real staff/admin back out.
  const { data: profile } = await supabaseClient
    .from("profiles")
    .select("role, job_title, full_name, avatar_url")
    .eq("id", session.user.id)
    .single();

  return {
    session,
    profile: profile || { role: "staff", full_name: "", avatar_url: null },
    isAdmin: isAdmin === true,
    isSuperAdmin: isSuperAdmin === true,
  };
}

/**
 * Ensures a profile row exists for the current user. Normally the
 * database trigger from supabase-schema.sql handles this and this is a
 * harmless no-op; kept as a fallback in case that trigger isn't installed.
 */
async function ensureProfile(user) {
  const { data: existing } = await supabaseClient
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (existing) return;

  const meta = user.user_metadata || {};
  await supabaseClient.from("profiles").insert({
    id: user.id,
    full_name: meta.full_name || meta.name || "",
    email: user.email || null,
  });
}

/**
 * Marks the account active (undoing deactivation if the 1-month
 * reactivation window hasn't passed) and reports whether that just
 * happened, so the caller can show a "welcome back" message.
 */
async function touchActivity() {
  try {
    const { data, error } = await supabaseClient.rpc("touch_activity");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

function friendlyAuthError(error) {
  const msg = (error && error.message || "").toLowerCase();
  if (msg.includes("invalid login credentials")) return "Incorrect email or password.";
  if (msg.includes("email not confirmed")) return "Please confirm your email before signing in.";
  if (msg.includes("user already registered")) return "An account with that email already exists.";
  if (msg.includes("rate limit")) return "Too many attempts. Please wait a moment and try again.";
  if (msg.includes("password")) return "Password does not meet the minimum requirements.";
  return "Something went wrong. Please try again.";
}

/* -------------------------------------------------------
   Small escaping-safe avatar renderer, used on home/staff headers
   ------------------------------------------------------- */
function renderAvatar(container, name, avatarUrl) {
  container.innerHTML = "";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = avatarUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    container.appendChild(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "avatar-fallback";
    fallback.textContent = (name || "?").trim().charAt(0).toUpperCase();
    container.appendChild(fallback);
  }
}

/* -------------------------------------------------------
   Job titles — display-only labels for admin-tier accounts.
   `role` ('student' | 'staff' | 'admin', plus is_super_admin for
   root) is still the only thing any permission check or RLS policy
   looks at — job_title never grants or removes access. It's purely
   what shows on badges, announcements, and ticket replies instead
   of the generic "Admin" label.

   Requires the profiles.job_title column (see the migration SQL
   shared alongside this) — falls back to the generic role label
   for any account without one, so pages don't break before that
   migration is run.
   ------------------------------------------------------- */
const JOB_TITLE_LABELS = {
  administration: "Administration Team",
  head_of_department: "Head of Department",
  principal: "Principal",
  deputy_principal: "Deputy Principal",
  technician: "Technician",
};

/** profile: { role, job_title? } → the label to show for this person.
 *  Admins/technicians with a recognized job_title show that title;
 *  everyone else falls back to a role-based label. */
function displayRoleLabel(profile) {
  if (!profile) return "";
  if (profile.job_title && JOB_TITLE_LABELS[profile.job_title]) {
    return JOB_TITLE_LABELS[profile.job_title];
  }
  if (profile.role === "admin") return "Admin";
  if (profile.role === "staff") return "Lecturer";
  return "Student";
}

/** Batch-looks-up the display label (see displayRoleLabel above) for a
 *  list of profile ids in one query — used wherever a list of records
 *  (announcements, ticket replies) needs to show who posted each one
 *  without a query per row. Returns a Map(id -> label); ids that fail
 *  to load or don't exist are simply absent from the map. */
async function fetchPosterLabels(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const labels = new Map();
  if (!unique.length) return labels;
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, role, job_title, full_name")
    .in("id", unique);
  if (error || !data) return labels;
  data.forEach((p) => labels.set(p.id, displayRoleLabel(p)));
  return labels;
}

/* -------------------------------------------------------
   Course picker — searchable combobox.

   The course <select> (built from COURSES in courses-data.js)
   shows up on sign-up, "change course", the admin/staff student
   editor, the grading picker, the announcement composer, and the
   timetable picker — 7 departments and 60+ courses in one long
   native list every time. This wraps a course <select> with a
   type-to-filter text box instead, while leaving the original
   <select> in the DOM (just visually hidden) as the one source of
   truth, so every existing `.value` read and 'change' listener
   elsewhere in the app keeps working completely unchanged.

   If code elsewhere sets `select.value = ...` directly (not via a
   user click), call syncCourseSelectDisplay(select) right after so
   the visible text box picks up the new value — programmatic value
   changes don't fire 'change' or mutate the DOM, so there's nothing
   else for this to observe.
   ------------------------------------------------------- */

/* -------------------------------------------------------
   Password show/hide toggle
   Markup: wrap the <input type="password"> in a .password-field div,
   with a sibling <button class="password-toggle" data-target="INPUT_ID">
   next to it (see index.html's sign-in/sign-up passwords). Just
   dropping that markup on a page is enough — this wires itself up on
   DOMContentLoaded (see the bottom of this file) and again for any
   markup added later via initPasswordToggles(), same pattern
   enhanceCourseSelect() uses for course pickers added after load.
   ------------------------------------------------------- */
const EYE_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.4 21.4 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.4 21.4 0 0 1-3.22 4.6M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function initPasswordToggles(scope) {
  (scope || document).querySelectorAll(".password-toggle").forEach((btn) => {
    if (btn.dataset.bound) return; // don't double-bind if called again later
    btn.dataset.bound = "1";
    btn.innerHTML = EYE_ICON;
    btn.setAttribute("aria-label", "Show password");
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.getAttribute("data-target"));
      if (!input) return;
      const willShow = input.type === "password";
      input.type = willShow ? "text" : "password";
      btn.innerHTML = willShow ? EYE_OFF_ICON : EYE_ICON;
      btn.setAttribute("aria-label", willShow ? "Hide password" : "Show password");
    });
  });
}

/* -------------------------------------------------------
   Clearable search inputs — clicking/tapping into a search box
   that already has a query in it clears it right away, instead of
   just dropping the cursor somewhere inside the old text. Applies
   to every <input type="search"> automatically, plus anything
   opted in with class="search-clearable" (for the handful of
   plain text inputs used as search boxes, like admin.html's
   studentSearch). Re-callable for markup added after page load,
   same pattern as initPasswordToggles() below.
   ------------------------------------------------------- */
function initClearableSearchInputs(scope) {
  (scope || document).querySelectorAll('input[type="search"], input.search-clearable').forEach((input) => {
    if (input.dataset.clearBound) return; // don't double-bind if called again later
    input.dataset.clearBound = "1";
    input.addEventListener("focus", () => {
      if (!input.value) return;
      input.value = "";
      // Fire the same event the rest of the app already listens on
      // (studentSearch/staffSearch/gradesSearch etc. are wired to
      // 'input'), so clearing here re-runs whatever filter was
      // narrowing the list, without every caller needing its own
      // focus listener.
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
}

/**
 * Fills a course <select> with <optgroup>/<option> elements built
 * straight from COURSES (courses-data.js) — the one source of truth
 * course codes/names are supposed to come from everywhere. Call this
 * before enhanceCourseSelect() so the combobox it builds reflects the
 * same list.
 *
 * `groups` defaults to the full COURSES list; pass a filtered copy to
 * leave some out (e.g. sign-up and "change course" exclude the
 * "Staff" group, same as the timetable picker in admin.js does, since
 * it isn't a real course a student would pick).
 *
 * `placeholderText`, if given, adds a leading empty option (selected
 * by default); pass `placeholderDisabled: true` to make it
 * unselectable once a real choice is made, matching how sign-up's
 * placeholder behaved before this was hardcoded markup.
 */
function populateCourseSelect(select, groups, placeholderText, placeholderDisabled) {
  if (!select) return;
  select.innerHTML = "";
  if (placeholderText !== undefined) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.selected = true;
    if (placeholderDisabled) placeholder.disabled = true;
    placeholder.textContent = placeholderText;
    select.appendChild(placeholder);
  }
  (groups || COURSES).forEach((group) => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    group.options.forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      optgroup.appendChild(option);
    });
    select.appendChild(optgroup);
  });
}

function enhanceCourseSelect(select, options) {
  if (!select || select.dataset.enhanced) return;
  select.dataset.enhanced = "1";
  // Scoped per-select, not a global setting — only passed by whichever
  // select actually asked for it (currently just the Timetable tab's
  // course search in lecturer-home.js).
  const disableTypingOnMobile = !!(options && options.disableTypingOnMobile);

  const wrapper = document.createElement("div");
  wrapper.className = "course-combo";
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.classList.add("course-combo-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "course-combo-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.placeholder = "Search for a course…";
  wrapper.appendChild(input);

  // On mobile, typing to search competes with the on-screen keyboard
  // eating half the viewport right as the panel needs room to show
  // results — readOnly keeps the input tappable (focus still opens the
  // panel below) without inviting a keyboard, so browsing the plain
  // department list is the only path there. Re-evaluated on resize /
  // orientation change, not just once at setup.
  if (disableTypingOnMobile) {
    const mobileQuery = window.matchMedia("(max-width: 760px)");
    const applyMobileMode = () => {
      input.readOnly = mobileQuery.matches;
      input.placeholder = mobileQuery.matches ? "Tap to choose a course" : "Search for a course…";
    };
    applyMobileMode();
    mobileQuery.addEventListener("change", applyMobileMode);
  }

  const panel = document.createElement("div");
  panel.className = "course-combo-panel";
  panel.hidden = true;
  document.body.appendChild(panel);

  select.__comboInput = input;

  function entries() {
    const list = [];
    Array.from(select.children).forEach((child) => {
      if (child.tagName === "OPTGROUP") {
        Array.from(child.children).forEach((opt) => {
          if (!opt.disabled) list.push({ value: opt.value, label: opt.textContent, group: child.label });
        });
      } else if (child.tagName === "OPTION" && !child.disabled) {
        list.push({ value: child.value, label: child.textContent, group: null });
      }
    });
    return list;
  }

  // Which department groups are expanded, e.g. "Natural Sciences" — by
  // group label, so it's the same set no matter which select this is
  // (picking one course's department open shouldn't reset on re-render).
  // Starts with whichever group holds the current value already open.
  const expandedGroups = new Set();

  function groupOfValue(value) {
    const found = entries().find((e) => e.value === value);
    return found ? found.group : null;
  }
  const startGroup = groupOfValue(select.value);
  if (startGroup) expandedGroups.add(startGroup);

  function currentLabel() {
    const opt = select.options[select.selectedIndex];
    if (!opt || opt.disabled) return "";
    return opt.value ? `${opt.textContent} (${opt.value})` : opt.textContent;
  }

  let highlighted = -1;

  function positionPanel() {
    const rect = wrapper.getBoundingClientRect();
    panel.style.width = rect.width + "px";
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 240 && rect.top > spaceBelow) {
      panel.style.top = "";
      panel.style.bottom = (window.innerHeight - rect.top + 4) + "px";
    } else {
      panel.style.bottom = "";
      panel.style.top = (rect.bottom + 4) + "px";
    }
    panel.style.left = rect.left + "px";
  }

  function makeOptionButton(e, isHighlighted, indented) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "course-combo-option" + (indented ? " indented" : "");
    if (e.value === select.value) item.classList.add("active");
    if (isHighlighted) item.classList.add("highlighted");

    const nameSpan = document.createElement("span");
    nameSpan.className = "course-combo-option-name";
    nameSpan.textContent = e.label;
    item.appendChild(nameSpan);
    if (e.value) {
      const codeSpan = document.createElement("span");
      codeSpan.className = "course-combo-option-code";
      codeSpan.textContent = e.value;
      item.appendChild(codeSpan);
    }

    item.addEventListener("mousedown", (ev) => {
      ev.preventDefault(); // fires before input's blur would close the panel
      select.value = e.value;
      input.value = e.value ? `${e.label} (${e.value})` : e.label;
      closePanel();
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return item;
  }

  // No search text: a compact accordion, one row per department — click
  // a department to open it instead of scrolling past every course in
  // every other department to find one.
  function renderAccordion() {
    const all = entries();
    const ungrouped = all.filter((e) => e.group === null);
    const groupOrder = [];
    all.forEach((e) => { if (e.group && !groupOrder.includes(e.group)) groupOrder.push(e.group); });

    ungrouped.forEach((e) => panel.appendChild(makeOptionButton(e, false, false)));

    groupOrder.forEach((groupLabel) => {
      const items = all.filter((e) => e.group === groupLabel);
      const isOpen = expandedGroups.has(groupLabel);

      const header = document.createElement("button");
      header.type = "button";
      header.className = "course-combo-group-header" + (isOpen ? " open" : "");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = groupLabel;
      const countSpan = document.createElement("span");
      countSpan.className = "course-combo-group-count";
      countSpan.textContent = items.length;
      const chevron = document.createElement("span");
      chevron.className = "course-combo-group-chevron";
      chevron.textContent = "›";
      header.append(nameSpan, countSpan, chevron);
      header.addEventListener("mousedown", (ev) => ev.preventDefault()); // don't blur the input
      header.addEventListener("click", () => {
        if (expandedGroups.has(groupLabel)) expandedGroups.delete(groupLabel);
        else expandedGroups.add(groupLabel);
        renderPanel(""); // re-render in place, panel stays open
      });
      panel.appendChild(header);

      if (isOpen) {
        items.forEach((e) => panel.appendChild(makeOptionButton(e, false, true)));
      }
    });

    highlighted = -1;
  }

  // With search text: flat, grouped-by-department results, ignoring the
  // accordion's open/closed state — narrowing the list is the point.
  function renderSearchResults(q) {
    const matches = entries().filter((e) => e.label.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "course-combo-empty";
      empty.textContent = "No matching courses.";
      panel.appendChild(empty);
      highlighted = -1;
      return;
    }
    highlighted = 0;
    let lastGroup;
    matches.forEach((e, i) => {
      if (e.group !== lastGroup) {
        lastGroup = e.group;
        if (e.group) {
          const groupEl = document.createElement("div");
          groupEl.className = "course-combo-group-label";
          groupEl.textContent = e.group;
          panel.appendChild(groupEl);
        }
      }
      panel.appendChild(makeOptionButton(e, i === highlighted, false));
    });
  }

  function renderPanel(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    panel.innerHTML = "";
    if (q) renderSearchResults(q);
    else renderAccordion();
  }

  function moveHighlight(delta) {
    const items = Array.from(panel.querySelectorAll(".course-combo-option"));
    if (!items.length) return;
    items[highlighted]?.classList.remove("highlighted");
    highlighted = (highlighted + delta + items.length) % items.length;
    items[highlighted].classList.add("highlighted");
    items[highlighted].scrollIntoView({ block: "nearest" });
  }

  function openPanel() {
    renderPanel("");
    positionPanel();
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    wrapper.classList.add("open");
    document.addEventListener("scroll", positionPanel, true);
    window.addEventListener("resize", positionPanel);
  }

  function closePanel() {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    wrapper.classList.remove("open");
    input.value = currentLabel();
    document.removeEventListener("scroll", positionPanel, true);
    window.removeEventListener("resize", positionPanel);
  }

  // Clicking/tapping in clears whatever course is currently shown,
  // same as initClearableSearchInputs() does for the plain search
  // boxes elsewhere — so you can start typing a new course right away
  // instead of having to select-all/backspace the old one first.
  // openPanel() already re-renders the (now unfiltered) accordion, so
  // there's no separate "input" event to fire here.
  input.addEventListener("focus", () => {
    input.value = "";
    openPanel();
  });
  input.addEventListener("input", () => {
    renderPanel(input.value);
    positionPanel();
    panel.hidden = false;
    wrapper.classList.add("open");
  });
  input.addEventListener("blur", () => window.setTimeout(closePanel, 150));
  input.addEventListener("keydown", (ev) => {
    if (panel.hidden && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) { openPanel(); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); moveHighlight(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); moveHighlight(-1); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      const items = panel.querySelectorAll(".course-combo-option");
      if (items[highlighted]) items[highlighted].dispatchEvent(new Event("mousedown"));
    } else if (ev.key === "Escape") {
      closePanel();
      input.blur();
    }
  });

  input.value = currentLabel();
}

/** Call after setting a course <select>'s .value from code (not from a
 *  user click on the combobox) so the visible search box picks it up. */
function syncCourseSelectDisplay(select) {
  if (select && select.__comboInput) {
    const opt = select.options[select.selectedIndex];
    select.__comboInput.value = opt && !opt.disabled ? opt.textContent : "";
  }
}

/* -------------------------------------------------------
   Status banner — one fixed, scrolling banner element shared
   by two independent watchdogs:

     1. Connectivity (automatic) — checkDbHealth() below pings
        Supabase's own health endpoint on a timer and raises
        the banner itself if it stops responding.
     2. Maintenance (manual) — checkMaintenanceMode() polls the
        system_status table for a flag an admin can flip from
        the admin panel ("Send maintenance banner"), to warn
        everyone before planned downtime rather than after.

   A third, root-only source can also raise it:

     3. Lockdown (manual, root-triggered) — checkMaintenanceMode() below
        also reads system_status.lockdown_enabled, flipped from the
        "System" tab in admin.html (Root only). It's the same table as
        maintenance, fetched in the same poll, so it doesn't need its
        own watchdog loop.

   Priority when more than one is true: lockdown outranks maintenance,
   which outranks the automatic connectivity alarm — lockdown is the
   most consequential ("you're about to be signed out"), maintenance is
   a deliberate heads-up, and connectivity-down is just an inference.
   Each of the three reads as its own situation, not just "a red bar":
   connectivity-down is the plain unmarked red, maintenance gets its own
   info/warning/danger colors plus a top caution stripe, and lockdown
   gets its own (darker) info/warning/danger colors, no stripe. See
   styles.css for the actual variants.
   ------------------------------------------------------- */
let statusBanner = null;
let statusBannerTrack = null;
let connectivityDown = false;
let maintenanceActive = false;
let maintenanceMessage = "";
let maintenanceStyle = "warning"; // 'info' | 'warning' | 'danger' — set by root from admin.html
let lockdownActive = false;
let lockdownMessage = "";
let lockdownStyle = "warning"; // 'info' | 'warning' | 'danger' — set by root from admin.html
let bannerShown = false;  // logical open/closed state — distinct from the [hidden] attribute,
                           // which is only set once the closing transition has actually finished
let bannerKey = null;     // "variant|message" of whatever's currently rendered, so a watchdog
                           // firing again with the same reason (e.g. the connectivity retry loop)
                           // doesn't restart the scroll animation or crossfade for no reason
let bannerHideTimer = null;
let bannerRepeatCount = 2; // how many copies of the message are currently in the track — see applyBannerContent

const DEFAULT_MAINTENANCE_MESSAGE =
  "The database is will be offline for a scheduled maintenance - please save your work. Some pages may be briefly unavailable.";
const CONNECTIVITY_DOWN_MESSAGE =
  "We're experiencing an unexpected system disturbance - data cannot be saved or accessed at this time. We apologize for any inconvenience. For safety all accounts have been logged out until our systems are back online.";
const DEFAULT_LOCKDOWN_BANNER_MESSAGE =
  "Lockdown mode is active. Only admins can sign in right now — everyone else will be signed out shortly.";

/* Sticky wrapper for banner + header together. Only created the first
   time a banner actually needs to show — on the (usual) banner-free
   path, .app-header keeps its own plain `position: sticky; top: 0`
   from styles.css and nothing here ever runs. Wrapping them in one
   sticky container (instead of making the banner sticky on its own)
   means the browser keeps whatever's currently inside it — header
   alone, or banner+header — pinned together as a single unit. No
   height has to be guessed or kept in sync by JS, which is what
   caused the gap bug the older fixed-banner approach had. */
function ensureStickyTopWrap() {
  let wrap = document.getElementById("stickyTopWrap");
  if (wrap) return wrap;
  wrap = document.createElement("div");
  wrap.id = "stickyTopWrap";
  wrap.className = "sticky-top-wrap";
  document.body.prepend(wrap);
  const header = document.querySelector(".app-header");
  if (header) wrap.appendChild(header); // move it in; banner is prepended ahead of it below
  return wrap;
}

/* .app-nav's sticky offset (styles.css) is a fixed --header-height
   fallback that only ever accounted for the header. Now that a banner
   can sit above the header inside the same sticky block, the sidebar
   needs to know the block's real current height, or it'll settle too
   high (overlapping the banner) whenever one is showing. Only affects
   desktop, where .app-nav is sticky at all — the mobile layout moves
   nav to a fixed bottom bar that doesn't use this variable. */
function updateHeaderHeightVar() {
  const wrap = document.getElementById("stickyTopWrap");
  const el = wrap || document.querySelector(".app-header");
  if (!el) return;
  const height = Math.round(el.getBoundingClientRect().height);
  if (height > 0) document.documentElement.style.setProperty("--header-height", height + "px");
}
window.addEventListener("resize", updateHeaderHeightVar);

function ensureStatusBanner() {
  if (statusBanner) return statusBanner;
  statusBanner = document.createElement("div");
  statusBanner.className = "db-down-banner";
  statusBanner.hidden = true;
  statusBanner.style.maxHeight = "0px"; // JS-driven (not the CSS default) — see renderStatusBanner/hideStatusBanner
  statusBanner.style.opacity = "0";
  statusBanner.setAttribute("role", "alert");
  statusBannerTrack = document.createElement("div");
  statusBannerTrack.className = "db-down-track";
  statusBanner.appendChild(statusBannerTrack);
  ensureStickyTopWrap().prepend(statusBanner); // ahead of the header, not after
  return statusBanner;
}

// How fast the banner text scrolls, in pixels per second. Slower =
// smaller number. Duration is derived from this (not a fixed seconds
// value) so a longer message doesn't go rushing past any faster than
// a short one — see startScrollAnimation below.
const BANNER_SCROLL_PX_PER_SECOND = 116;
const BANNER_SCROLL_MIN_SECONDS = 5;
// One reason (lockdown, maintenance, connectivity-down) handing off to
// another shouldn't read as the old banner vanishing and a new one
// popping in — it should read as one banner just changing what it's
// saying. So an already-open banner crossfades in place (this timing);
// only a genuine appear/disappear animates height (BANNER_OPEN_CLOSE_MS,
// kept equal to the max-height transition in styles.css).
const BANNER_CROSSFADE_MS = 220;
const BANNER_OPEN_CLOSE_MS = 380;

function startScrollAnimation() {
  // Restart cleanly rather than let new (probably different-width) text
  // inherit whatever point the previous loop happened to be mid-way
  // through — that's what used to make a swap look like a stutter.
  statusBannerTrack.style.animation = "none";
  void statusBannerTrack.offsetWidth; // force reflow so "none" actually takes before re-enabling
  statusBannerTrack.style.animation = "";
  window.requestAnimationFrame(() => {
    updateHeaderHeightVar();
    // scrollWidth is every copy together; the CSS translates by exactly
    // one copy's width (--marquee-shift) per loop, however many copies
    // that ends up being — see applyBannerContent for why the count
    // varies. Pace the duration to that one-copy distance, not the
    // full multi-copy width, or the loop reads far slower than it should.
    const shift = statusBannerTrack.scrollWidth / bannerRepeatCount;
    statusBannerTrack.style.setProperty("--marquee-shift", shift + "px");
    const seconds = Math.max(shift / BANNER_SCROLL_PX_PER_SECOND, BANNER_SCROLL_MIN_SECONDS);
    statusBannerTrack.style.animationDuration = seconds + "s";
  });
}

function applyBannerContent(message, variant) {
  // A visible separator (not just spaces) between repeats — plain spaces
  // collapse to one when rendered, which is what made two repeats look
  // like they'd been sent with no gap between them. It's a plain "·"
  // character in the measured/accessible text, but rendered as its own
  // <span> below so it can be styled smaller and dimmer than the
  // message — sharing the message's own size/weight/color is what made
  // it read as a stray typo instead of a deliberate divider.
  const separatorChar = "·";
  const gap = "    ";
  const item = message + gap + separatorChar + gap;

  // Two copies only tile seamlessly for as long as they're together at
  // least as wide as the banner — for a short message on a wide banner,
  // the two copies scroll fully past *before* the loop restarts, and
  // that empty stretch (then a hard reset once it wraps) is exactly what
  // "randomly spawns in a next one" was describing. So: render one copy,
  // measure it, and repeat however many times are actually needed to
  // keep the banner full for the whole scroll — never just a fixed two.
  statusBannerTrack.textContent = item; // measure a single (plain-text) copy first
  const itemWidth = statusBannerTrack.scrollWidth || 1;
  const bannerWidth = statusBanner.clientWidth || window.innerWidth;
  // +2 copies of buffer beyond what the banner's width alone requires,
  // so there's always at least a full extra copy still queued up behind
  // whatever's currently scrolling past, however narrow the message.
  bannerRepeatCount = Math.max(2, Math.ceil(bannerWidth / itemWidth) + 2);

  // Now build the real, repeated content as elements (not one big text
  // string) so each dot can get its own styling. The dots are marked
  // aria-hidden and the banner carries the message once via aria-label
  // instead — a screen reader reading this element (role="alert") has
  // no use for "message · message · message …" repeated a dozen times.
  statusBannerTrack.textContent = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < bannerRepeatCount; i++) {
    frag.appendChild(document.createTextNode(message + gap));
    const dot = document.createElement("span");
    dot.className = "db-down-dot";
    dot.textContent = separatorChar;
    frag.appendChild(dot);
    frag.appendChild(document.createTextNode(gap));
  }
  statusBannerTrack.appendChild(frag);
  statusBannerTrack.setAttribute("aria-hidden", "true");
  statusBanner.setAttribute("aria-label", message);

  statusBanner.className = "db-down-banner"; // reset any previous variant class
  if (variant) statusBanner.classList.add(variant);
  startScrollAnimation();
}

function renderStatusBanner(message, variant) {
  const banner = ensureStatusBanner();
  const key = variant + "|" + message;
  if (key === bannerKey && bannerShown) return; // already showing exactly this — leave it alone

  if (bannerHideTimer) { window.clearTimeout(bannerHideTimer); bannerHideTimer = null; }
  bannerKey = key;

  if (!bannerShown) {
    // Genuine appear: fill in the new content first, while still
    // collapsed (so nothing is visible yet), then animate open.
    banner.hidden = false;
    applyBannerContent(message, variant);
    bannerShown = true;
    void banner.offsetHeight; // commit the collapsed state before animating away from it
    window.requestAnimationFrame(() => {
      banner.style.maxHeight = banner.scrollHeight + "px";
      banner.style.opacity = "1";
    });
    return;
  }

  // Already open — crossfade to the new message/color in place instead
  // of closing and reopening. The banner is always a single line, so
  // height never needs to move for this; it's just a text/color dip.
  statusBannerTrack.classList.add("db-down-fade");
  window.setTimeout(() => {
    applyBannerContent(message, variant);
    statusBannerTrack.classList.remove("db-down-fade");
  }, BANNER_CROSSFADE_MS);
}

function hideStatusBanner() {
  if (!statusBanner || !bannerShown) return;
  bannerShown = false;
  bannerKey = null;
  // Pin the banner's current pixel height before collapsing it, so the
  // transition has a real distance to cover instead of jumping straight
  // from "auto" to 0.
  statusBanner.style.maxHeight = statusBanner.scrollHeight + "px";
  void statusBanner.offsetHeight;
  statusBanner.style.maxHeight = "0px";
  statusBanner.style.opacity = "0";
  window.requestAnimationFrame(updateHeaderHeightVar);
  if (bannerHideTimer) window.clearTimeout(bannerHideTimer);
  bannerHideTimer = window.setTimeout(() => {
    // Only actually pull it out of the layout once the collapse has
    // visibly finished — matches how it came in.
    if (!bannerShown) statusBanner.hidden = true;
    bannerHideTimer = null;
  }, BANNER_OPEN_CLOSE_MS);
}

function updateStatusBanner() {
  if (lockdownActive) {
    renderStatusBanner(lockdownMessage || DEFAULT_LOCKDOWN_BANNER_MESSAGE, "lockdown-" + (lockdownStyle || "warning"));
  } else if (maintenanceActive) {
    renderStatusBanner(maintenanceMessage || DEFAULT_MAINTENANCE_MESSAGE, "maintenance-" + (maintenanceStyle || "warning"));
  } else if (connectivityDown) {
    renderStatusBanner(CONNECTIVITY_DOWN_MESSAGE, "down");
  } else {
    hideStatusBanner();
  }
}

/* --- 1. Connectivity watchdog (automatic) --- */
let dbDownFailureStreak = 0;
const DB_DOWN_FAILURE_THRESHOLD = 2; // require 2 consecutive failed checks before alarming, to ignore a single blip
const DB_HEALTHY_RECHECK_MS = 20000; // how often to check while things look fine
const DB_HEALTHY_RECHECK_JITTER_MS = 5000; // spread out so many open tabs don't all poll in lockstep
const DB_RETRY_RECHECK_MS = 1500;    // how often to recheck while a check just failed — fast, so both alarming and recovery happen quickly
const DB_HEALTH_CHECK_TIMEOUT_MS = 3000;

async function checkDbHealth() {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), DB_HEALTH_CHECK_TIMEOUT_MS);
  let healthy = false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      method: "GET",
      headers: { apikey: SUPABASE_ANON_KEY },
      signal: controller.signal,
    });
    window.clearTimeout(timeoutId);
    if (!res.ok) throw new Error("Unhealthy status " + res.status);
    healthy = true;
  } catch (err) {
    window.clearTimeout(timeoutId);
    healthy = false;
  }

  if (healthy) {
    dbDownFailureStreak = 0;
    connectivityDown = false;
  } else {
    dbDownFailureStreak += 1;
    if (dbDownFailureStreak >= DB_DOWN_FAILURE_THRESHOLD) {
      connectivityDown = true;
    }
  }
  updateStatusBanner();

  // Recheck sooner while things are failing (to alarm fast, and to notice
  // recovery fast too) than while things are healthy (no need to hammer it).
  const delay = healthy ? DB_HEALTHY_RECHECK_MS + Math.random() * DB_HEALTHY_RECHECK_JITTER_MS : DB_RETRY_RECHECK_MS;
  window.setTimeout(checkDbHealth, delay);
}

/* --- 2. Maintenance/lockdown watchdog (manual, admin-triggered) ---
   Used to poll system_status every 5s from every open tab — at a few
   hundred people simply having the site open, that alone was enough
   continuous request volume to keep this project's small compute
   instance running hot. Realtime pushes the row to every subscribed
   tab the moment admin.js writes to it instead, so there's no
   meaningful delay AND no per-tab polling. The slow interval below
   is just a safety net (covers a missed event or a dropped
   websocket), not the primary mechanism, so it can afford to be slow. */
const SYSTEM_STATUS_SAFETY_POLL_MS = 30000;

function applySystemStatus(data) {
  maintenanceActive = !!data && data.maintenance_mode === true;
  maintenanceMessage = (data && data.maintenance_message) || "";
  maintenanceStyle = (data && data.banner_style) || "warning";
  lockdownActive = !!data && data.lockdown_enabled === true;
  lockdownMessage = (data && data.lockdown_message) || "";
  lockdownStyle = (data && data.lockdown_style) || "warning";
  updateStatusBanner();
}

async function refreshSystemStatusOnce() {
  try {
    invalidateCache("system_status"); // always want the current row here, not a cached hit
    applySystemStatus(await getSystemStatus());
  } catch {
    maintenanceActive = false;
    lockdownActive = false;
    updateStatusBanner();
  }
}

function watchSystemStatus() {
  refreshSystemStatusOnce(); // initial state on page load

  supabaseClient
    .channel("system_status_changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "system_status", filter: "id=eq.1" },
      (payload) => {
        invalidateCache("system_status");
        applySystemStatus(payload.new);
      }
    )
    .subscribe();

  window.setInterval(refreshSystemStatusOnce, SYSTEM_STATUS_SAFETY_POLL_MS);
}

document.addEventListener("DOMContentLoaded", () => {
  checkDbHealth();
  watchSystemStatus();
  initPasswordToggles();
  initClearableSearchInputs();
});