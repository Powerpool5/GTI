/* Keeps what the offline view needs on this device: the last timetable the
   student successfully loaded, and (in the Android app only) a small snapshot
   of the header details (name) so the offline page can look like the online one.
   Both are removed on sign-out so a shared phone doesn't keep showing the
   previous student's details. Only table-style timetables are stored (the rows
   are plain text); an uploaded image or PDF is not cached. */
const GTITimetableCache = (function () {
  const KEY = 'gti-offline-timetable';
  const PROFILE_KEY = 'gti-offline-profile';

  function isApp() {
    const cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  }

  function save(userId, courseCode, data) {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        userId: userId || null,
        courseCode: courseCode || null,
        savedAt: new Date().toISOString(),
        data,
      }));
    } catch {}
  }

  function load(userId, courseCode) {
    try {
      const raw = localStorage.getItem(KEY);
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
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({
        name: String(profile.name || '').slice(0, 120),
        savedAt: new Date().toISOString(),
      }));
    } catch {}
  }

  function loadProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && typeof p.name === 'string' ? p : null;
    } catch {
      return null;
    }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch {}
    try { localStorage.removeItem(PROFILE_KEY); } catch {}
  }

  if (typeof supabaseClient !== 'undefined' && supabaseClient && supabaseClient.auth) {
    supabaseClient.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') clear();
    });
  }

  return { save, load, saveProfile, loadProfile, clear, isApp };
})();