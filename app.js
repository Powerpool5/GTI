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
   Session / role guards
   ------------------------------------------------------- */
async function requireSession() {
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error || !session) {
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
   Database connectivity watchdog — shows a red, scrolling
   banner across the top of every page when Supabase stops
   responding, and hides it again automatically once it
   recovers. Checks Supabase's own health endpoint rather
   than a table, so it isn't affected by login state or RLS.
   ------------------------------------------------------- */
let dbDownBanner = null;
let dbDownFailureStreak = 0;
const DB_DOWN_FAILURE_THRESHOLD = 2; // require 2 consecutive failed checks before alarming, to ignore a single blip
const DB_HEALTHY_RECHECK_MS = 8000;  // how often to check while things look fine
const DB_RETRY_RECHECK_MS = 1500;    // how often to recheck while a check just failed — fast, so both alarming and recovery happen quickly
const DB_HEALTH_CHECK_TIMEOUT_MS = 3000;

function ensureDbDownBanner() {
  if (dbDownBanner) return dbDownBanner;
  dbDownBanner = document.createElement("div");
  dbDownBanner.className = "db-down-banner";
  dbDownBanner.hidden = true;
  dbDownBanner.setAttribute("role", "alert");
  const track = document.createElement("div");
  track.className = "db-down-track";
  track.textContent =
    "       The database is currently down for maintenance - Data cannot be saved or accessed at this time. We apologize for any inconvenience. For safety all accounts have been logged out until our systems are back online." 
    "       The database is currently down for maintenance - Data cannot be saved or accessed at this time. We apologize for any inconvenience. For safety all accounts have been logged out until our systems are back online." 

    
  dbDownBanner.appendChild(track);
  document.body.prepend(dbDownBanner);
  return dbDownBanner;
}

function showDbDownBanner() {
  ensureDbDownBanner().hidden = false;
}

function hideDbDownBanner() {
  if (dbDownBanner) dbDownBanner.hidden = true;
}

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
    hideDbDownBanner();
  } else {
    dbDownFailureStreak += 1;
    if (dbDownFailureStreak >= DB_DOWN_FAILURE_THRESHOLD) {
      showDbDownBanner();
    }
  }

  // Recheck sooner while things are failing (to alarm fast, and to notice
  // recovery fast too) than while things are healthy (no need to hammer it).
  window.setTimeout(checkDbHealth, healthy ? DB_HEALTHY_RECHECK_MS : DB_RETRY_RECHECK_MS);
}

document.addEventListener("DOMContentLoaded", () => {
  checkDbHealth();
});