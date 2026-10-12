/* Keeps the last timetable the student successfully loaded, so offline.html
   (and home.js, if the database is briefly unreachable) can still show it.
   One entry, tied to the signed-in user and their course. It is removed on
   sign-out so a shared phone doesn't keep showing the previous student's
   timetable. Only table-style timetables are stored (the rows are plain
   text); an uploaded image or PDF is not cached. */
const GTITimetableCache = (function () {
  const KEY = 'gti-offline-timetable';

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

  function clear() {
    try { localStorage.removeItem(KEY); } catch {}
  }

  if (typeof supabaseClient !== 'undefined' && supabaseClient && supabaseClient.auth) {
    supabaseClient.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') clear();
    });
  }

  return { save, load, clear };
})();