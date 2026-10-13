/* Dark mode only. The light theme and the toggle button are retired: every
   page is set to dark before it paints (this is a real external file, loaded
   in <head>, because every page's CSP blocks inline scripts). */
(function () {
  const root = document.documentElement;
  root.setAttribute("data-theme", "dark");
  root.style.backgroundColor = "#121A22";
  try { localStorage.removeItem("gti-theme"); } catch {}
})();

/* Phone behaviour.
   - In the Android app only: no long-press text selection / copy menu
     (text fields still work normally).
   - On touch screens: tapping a button leaves no focus ring behind. */
(function () {
  const root = document.documentElement;
  const cap = window.Capacitor;
  const inApp = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) || !!window.GTIStore;
  const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

  if (inApp) {
    root.classList.add("is-app");
    const block = (e) => {
      const t = e.target;
      const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
      if (el && el.closest && el.closest(EDITABLE)) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", block);
    document.addEventListener("selectstart", block);
  }

  document.addEventListener("pointerdown", (e) => {
    root.classList.toggle("using-touch", e.pointerType === "touch" || e.pointerType === "pen");
  }, true);
  document.addEventListener("keydown", () => root.classList.remove("using-touch"), true);
  document.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    const el = e.target && e.target.closest ? e.target.closest('button, a, summary, [role="tab"]') : null;
    if (el) window.setTimeout(() => { if (document.activeElement === el) el.blur(); }, 0);
  }, true);
})();