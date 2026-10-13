/* Keeps what the offline view needs on this device: the last timetable the
   student successfully loaded, and (in the Android app only) a small snapshot
   of the header details (name) so the offline page can look like the online one.
   Both are removed on sign-out so a shared phone doesn't keep showing the
   previous student's details. Only table-style timetables are stored (the rows
   are plain text); an uploaded image or PDF is not cached.

   In the Android app a second copy goes into the app's own storage (the
   GTIStore bridge added by the app's MainActivity). Unlike the web page's
   storage, that is readable by the app's built-in offline screen, which opens
   when the portal can't be reached at all. */
const GTITimetableCache = (function () {
  const KEY = 'gti-offline-timetable';
  const PROFILE_KEY = 'gti-offline-profile';

  function appStore() {
    try { return window.GTIStore && typeof window.GTIStore.load === 'function' ? window.GTIStore : null; } catch { return null; }
  }

  function isApp() {
    const cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) || !!appStore();
  }

  function write(key, json) {
    try { localStorage.setItem(key, json); } catch {}
    const store = appStore();
    if (store) { try { store.save(key, json); } catch {} }
  }

  function read(key) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch {}
    if (raw) return raw;
    const store = appStore();
    if (store) { try { raw = store.load(key); } catch {} }
    return raw || null;
  }

  function save(userId, courseCode, data) {
    write(KEY, JSON.stringify({
      userId: userId || null,
      courseCode: courseCode || null,
      savedAt: new Date().toISOString(),
      data,
    }));
  }

  function load(userId, courseCode) {
    try {
      const raw = read(KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (!rec || !rec.data || !Array.isArray(rec.data.table_data)) return null;
      if (userId && rec.userId !== userId) return null;
      if (courseCode && rec.courseCode !== courseCode) return null;
      return rec;
    } catch {
      return null;
    }
  }

  function saveProfile(profile) {
    if (!isApp() || !profile) return;
    write(PROFILE_KEY, JSON.stringify({
      name: String(profile.name || '').slice(0, 120),
      savedAt: new Date().toISOString(),
    }));
  }

  function loadProfile() {
    try {
      const raw = read(PROFILE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && typeof p.name === 'string' ? p : null;
    } catch {
      return null;
    }
  }

  function clear() {
    for (const key of [KEY, PROFILE_KEY]) {
      try { localStorage.removeItem(key); } catch {}
      const store = appStore();
      if (store) { try { store.remove(key); } catch {} }
    }
  }

  if (typeof supabaseClient !== 'undefined' && supabaseClient && supabaseClient.auth) {
    supabaseClient.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') clear();
    });
  }

  return { save, load, saveProfile, loadProfile, clear, isApp };
})();