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
   - On touch screens (and always in the Android app): no long-press text
     selection or copy menu. Text fields still work normally.
   - On touch screens: tapping anything leaves no focus ring behind. */
(function () {
  const root = document.documentElement;
  const cap = window.Capacitor;
  const inApp = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) || !!window.GTIStore;
  const touchScreen = !!(window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches);
  const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  const isEditable = (n) => !!(n && n.closest && n.closest(EDITABLE));

  if (inApp) root.classList.add("is-app");
  if (inApp || touchScreen) {
    const block = (e) => {
      const t = e.target;
      const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
      if (isEditable(el)) return;
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
    window.setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a !== root && !isEditable(a) && typeof a.blur === "function") a.blur();
    }, 0);
  }, true);
})();