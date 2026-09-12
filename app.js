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
    const { data, error } = await supabaseClient
      .from("system_status")
      .select("lockdown_enabled, lockdown_message")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data || data.lockdown_enabled !== true) return null;

    const { data: isAdmin } = await supabaseClient.rpc("is_admin");
    if (isAdmin === true) return null; // admins and root always get through

    await supabaseClient.auth.signOut();
    return data.lockdown_message || DEFAULT_LOCKDOWN_MESSAGE;
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
    try { sessionStorage.setItem("gti-lockout-message", lockdownMessage); } catch {}
    window.location.href = "index.html";
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
  // loop between this page and the staff login page).
  const { data: hasAccess, error: accessError } = await supabaseClient.rpc("has_staff_access");

  if (accessError || hasAccess !== true) {
    // Note: this is a UX redirect only. The real gate is the RLS
    // policies on the tables the staff dashboard writes to — even if
    // someone bypassed this redirect, every insert/update/delete call
    // would still be rejected by Postgres.
    window.location.href = "lecturer-login.html?denied=1";
    return null;
  }

  const { data: isAdmin } = await supabaseClient.rpc("is_admin");

  // is_admin() now returns true for super admins too (root outranks
  // role), so it alone can't tell an ordinary admin apart from a super
  // admin for UI purposes like the Root toggle. Fetch that separately.
  const { data: isSuperAdmin } = await supabaseClient.rpc("is_super_admin");

  // Purely for display (name/avatar in the header) — not part of the
  // gate above, so a hiccup here can't kick a real staff/admin back out.
  const { data: profile } = await supabaseClient
    .from("profiles")
    .select("role, full_name, avatar_url")
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
   gets its own (darker) info/warning/danger colors plus a bottom amber
   stripe. See styles.css for the actual variants.
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

const DEFAULT_MAINTENANCE_MESSAGE =
  "The database is restarting for scheduled maintenance - please save your work. Some pages may be briefly unavailable.";
const CONNECTIVITY_DOWN_MESSAGE =
  "The database is currently down for maintenance - Data cannot be saved or accessed at this time. We apologize for any inconvenience. For safety all accounts have been logged out until our systems are back online.";
const DEFAULT_LOCKDOWN_BANNER_MESSAGE =
  "Lockdown mode is active. Only admins can sign in right now — everyone else will be signed out shortly.";

function ensureStatusBanner() {
  if (statusBanner) return statusBanner;
  statusBanner = document.createElement("div");
  statusBanner.className = "db-down-banner";
  statusBanner.hidden = true;
  statusBanner.setAttribute("role", "alert");
  statusBannerTrack = document.createElement("div");
  statusBannerTrack.className = "db-down-track";
  statusBanner.appendChild(statusBannerTrack);
  document.body.prepend(statusBanner);
  return statusBanner;
}

function renderStatusBanner(message, variant) {
  const banner = ensureStatusBanner();
  const padded = "       " + message + "       ";
  statusBannerTrack.textContent = padded + padded; // repeated so the scroll loop has no gap
  banner.className = "db-down-banner"; // reset any previous variant class
  if (variant) banner.classList.add(variant);
  banner.hidden = false;
}

function hideStatusBanner() {
  if (statusBanner) statusBanner.hidden = true;
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
const DB_HEALTHY_RECHECK_MS = 8000;  // how often to check while things look fine
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
  window.setTimeout(checkDbHealth, healthy ? DB_HEALTHY_RECHECK_MS : DB_RETRY_RECHECK_MS);
}

/* --- 2. Maintenance watchdog (manual, admin-triggered) --- */
const MAINTENANCE_POLL_MS = 5000;

async function checkMaintenanceMode() {
  try {
    const { data, error } = await supabaseClient
      .from("system_status")
      .select("maintenance_mode, maintenance_message, banner_style, lockdown_enabled, lockdown_message, lockdown_style")
      .eq("id", 1)
      .maybeSingle();
    maintenanceActive = !error && !!data && data.maintenance_mode === true;
    maintenanceMessage = (data && data.maintenance_message) || "";
    maintenanceStyle = (data && data.banner_style) || "warning";
    lockdownActive = !error && !!data && data.lockdown_enabled === true;
    lockdownMessage = (data && data.lockdown_message) || "";
    lockdownStyle = (data && data.lockdown_style) || "warning";
  } catch {
    maintenanceActive = false;
    lockdownActive = false;
  }
  updateStatusBanner();
  window.setTimeout(checkMaintenanceMode, MAINTENANCE_POLL_MS);
}

document.addEventListener("DOMContentLoaded", () => {
  checkDbHealth();
  checkMaintenanceMode();
});