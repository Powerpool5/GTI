/* Dark mode. Loaded in <head>, right after styles.css, so the theme is
   set before the page paints (avoids a flash of the wrong theme) —
   this has to be a real external file rather than an inline <script>
   because every page's CSP blocks inline scripts. */
(function () {
  let stored = null;
  try { stored = localStorage.getItem("gti-theme"); } catch {}
  const theme = stored === "dark" || stored === "light"
    ? stored
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("gti-theme", next); } catch {}
  updateThemeToggleIcon();
}

function updateThemeToggleIcon() {
  const btn = document.getElementById("themeToggleBtn");
  if (!btn) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  btn.textContent = isDark ? "☀" : "☾";
  btn.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
}

document.addEventListener("DOMContentLoaded", () => {
  updateThemeToggleIcon();
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.addEventListener("click", toggleTheme);
});