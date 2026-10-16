/* Staff dashboard on phones.
   - Students and Staff lists: each person becomes one compact row (name, badge,
     course). Tapping the row opens the person's detail pop-up, which on a phone
     also gets the Grades / Edit buttons that the wide table used to hold.
   Loaded by app.js on pages that have those tables; it only reshapes what
   lecturer-home.js has already drawn, so that file is untouched. */
(function () {
  const phone = window.matchMedia("(max-width: 760px)");
  const COLUMNS = ["name", "id", "email", "course", "role", "root", "status", "actions"];
  let activeRow = null;

  function decorateRow(tr) {
    if (tr.dataset.pcDone) return;
    const cells = tr.children;
    if (cells.length < COLUMNS.length || tr.querySelector(".empty-state")) return;
    tr.dataset.pcDone = "1";
    COLUMNS.forEach((name, i) => cells[i].classList.add("pc-" + name));
    const nameBtn = tr.querySelector(".name-link");
    const name = ((nameBtn ? nameBtn.textContent : cells[0].textContent) || "").trim();
    tr.dataset.initial = (name.charAt(0) || "?").toUpperCase();
    tr.classList.add("pc-row");
    tr.addEventListener("click", (e) => {
      activeRow = tr;
      if (!phone.matches) return;
      if (e.target.closest("button, a, input, select")) return; // those keep their own action
      if (nameBtn) nameBtn.click();
    });
  }

  function watchTable(tbodyId) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const table = tbody.closest("table");
    if (table) table.classList.add("compact-people");
    const run = () => Array.prototype.forEach.call(tbody.children, decorateRow);
    run();
    new MutationObserver(run).observe(tbody, { childList: true });
  }

  // On a phone the detail pop-up also carries the row's Grades / Edit buttons.
  function addActions(body) {
    if (!phone.matches || !activeRow || !activeRow.isConnected) return;
    if (body.querySelector(":scope > .sd-actions")) return;
    if (!body.children.length || body.querySelector(".skeleton")) return; // still loading
    const sources = activeRow.querySelectorAll(".pc-actions button");
    if (!sources.length) return;
    const bar = document.createElement("div");
    bar.className = "sd-actions";
    Array.prototype.forEach.call(sources, (src) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = src.className;
      btn.textContent = src.textContent;
      btn.addEventListener("click", () => src.click());
      bar.appendChild(btn);
    });
    body.insertBefore(bar, body.firstChild);
  }

  function start() {
    watchTable("studentsTbody");
    watchTable("staffTbody");
    const body = document.getElementById("studentDetailBody");
    if (body) {
      const run = () => addActions(body);
      new MutationObserver(run).observe(body, { childList: true });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
