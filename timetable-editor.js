/* =========================================================
   TimetableEditor — shared module for turning an uploaded
   timetable image/PDF into an editable, on-site table.

   Loaded on admin.html, lecturer-home.html (editing) and
   home.html (viewing + optional export). Everything heavy
   (Tesseract.js, pdf.js, jsPDF, docx.js) is fetched lazily
   from jsdelivr — a page that never touches the OCR/export
   buttons never downloads any of it.

   Pipeline (v5 — cell-by-cell):
     image or PDF -> (rasterize PDF page 1 if needed)
       -> grayscale -> straighten slight tilt (deskew)
       -> find the table's ruled lines (rows + columns)
       -> crop every cell, enlarge + clean it, and OCR each one
          on its own with settings that suit that kind of cell
          (times, single break letters, normal text)
       -> tidy + self-correct (time format, BREAK/LUNCH rows,
          repeated names, weekday headers)
       -> editable <table>, with any cell the reader was unsure
          about highlighted so it can be checked against the
          original picture shown alongside.
   If no ruled table can be found (e.g. a table with no lines)
   it falls back to the older whole-page reading, but ignores
   low-confidence "words" so logos and crests stop leaking in.
   The result is saved as plain JSON (array of arrays of
   strings) alongside the original file, as before.
   ========================================================= */

const TimetableEditor = (function () {
  const CDN = "https://cdn.jsdelivr.net/npm";
  // Lang-data mirror hosted on jsdelivr (via GitHub Pages) so OCR never
  // has to reach a domain outside this app's CSP allow-list.
  const TESS_LANG_PATH = "https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0";

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-tt-src="${src}"]`);
      if (existing) {
        if (existing.dataset.ttLoaded === "1") resolve();
        else existing.addEventListener("load", () => resolve());
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.dataset.ttSrc = src;
      s.onload = () => { s.dataset.ttLoaded = "1"; resolve(); };
      s.onerror = () => { s.remove(); reject(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  let ocrLibsPromise = null;
  function loadOcrLibs() {
    if (!ocrLibsPromise) {
      ocrLibsPromise = Promise.all([
        loadScript(`${CDN}/tesseract.js@5.1.1/dist/tesseract.min.js`),
        loadScript(`${CDN}/pdfjs-dist@3.11.174/build/pdf.min.js`),
      ]).then(() => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN}/pdfjs-dist@3.11.174/build/pdf.worker.min.js`;
      }).catch((err) => { ocrLibsPromise = null; throw err; });
    }
    return ocrLibsPromise;
  }

  // PDF and Word each load only their own library, so a problem with one
  // can't stop the other. A failed load is forgotten so the next tap retries.
  // (docx 8.x ships its browser build as build/index.umd.js, which defines
  // window.docx; there is no build/index.js in that version.)
  let pdfLibsPromise = null;
  function loadPdfLibs() {
    if (!pdfLibsPromise) {
      pdfLibsPromise = Promise.all([
        loadScript(`${CDN}/jspdf@2.5.2/dist/jspdf.umd.min.js`),
        loadScript(`${CDN}/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js`),
      ]).catch((err) => { pdfLibsPromise = null; throw err; });
    }
    return pdfLibsPromise;
  }

  let docxLibPromise = null;
  function loadDocxLib() {
    if (!docxLibPromise) {
      docxLibPromise = loadScript(`${CDN}/docx@8.5.0/build/index.umd.js`)
        .catch((err) => { docxLibPromise = null; throw err; });
    }
    return docxLibPromise;
  }

  function loadExportLibs() {
    return Promise.all([loadPdfLibs(), loadDocxLib()]);
  }

  /* ---------------- PDF -> canvas (first page only) ---------------- */
  async function rasterizePdfFirstPage(file) {
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    // Scaled up well past 100% — OCR accuracy on small print timetables
    // drops off fast at native PDF resolution.
    const viewport = page.getViewport({ scale: 3 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas;
  }

  /* =========================================================
     Small pure helpers (no DOM) — shared by the OCR steps below
     ========================================================= */
  function median(nums) {
    if (!nums.length) return 0;
    const s = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /* =========================================================
     STEP 1 — picture -> grayscale -> straightened -> table lines
     ========================================================= */

  // Local-contrast threshold: a pixel counts as "ink" when it is clearly
  // darker than the area around it. Works on uneven phone-photo lighting
  // where one global threshold would either lose the lines or fill the page.
  function adaptiveDark(gray, w, h) {
    const r = Math.max(8, Math.round(w / 80));
    const W1 = w + 1;
    const integral = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * W1 + (x + 1)] = integral[y * W1 + (x + 1)] + rowSum;
      }
    }
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - r), yb = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - r), xb = Math.min(w - 1, x + r);
        const sum = integral[(yb + 1) * W1 + (xb + 1)] - integral[ya * W1 + (xb + 1)]
                  - integral[(yb + 1) * W1 + xa] + integral[ya * W1 + xa];
        const mean = sum / ((xb - xa + 1) * (yb - ya + 1));
        const g = gray[y * w + x];
        if (g < mean - 20 && g < 200) bin[y * w + x] = 1;
      }
    }
    return bin;
  }

  // Pictures often have a dark frame around them (a photo border, a
  // screenshot edge). Thick, nearly-solid strips at the very edge are
  // trimmed off; a thin one (a real table border near the edge) is kept.
  function frameRegion(bin, w, h) {
    const rowFrac = (y, xa, xb) => { let c = 0; for (let x = xa; x < xb; x++) c += bin[y * w + x]; return c / (xb - xa); };
    const colFrac = (x, ya, yb) => { let c = 0; for (let y = ya; y < yb; y++) c += bin[y * w + x]; return c / (yb - ya); };
    const LIM = 0.6, MIN_THICK = 4;
    let y0 = 0, y1 = h, x0 = 0, x1 = w;
    let t = 0; while (t < h && rowFrac(t, 0, w) > LIM) t++;
    if (t >= MIN_THICK) y0 = t + 2;
    t = 0; while (t < h && rowFrac(h - 1 - t, 0, w) > LIM) t++;
    if (t >= MIN_THICK) y1 = h - t - 2;
    t = 0; while (t < w && colFrac(t, y0, y1) > LIM) t++;
    if (t >= MIN_THICK) x0 = t + 2;
    t = 0; while (t < w && colFrac(w - 1 - t, y0, y1) > LIM) t++;
    if (t >= MIN_THICK) x1 = w - t - 2;
    return { x0, y0, x1, y1 };
  }

  // Estimate how many degrees the page is tilted by checking which small
  // rotation makes the horizontal strokes (table lines, text baselines)
  // line up into the sharpest rows. Returns degrees; positive = the page
  // content slopes downward to the right (i.e. it is rotated clockwise).
  function estimateSkewDeg(bin, w, h) {
    let n = 0;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 1; x < w; x++) if (bin[o + x] && bin[o + x - 1]) n++;
    }
    if (n < 200) return 0;
    const step = Math.max(1, Math.floor(n / 150000));
    const px = [], py = [];
    let k = 0;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 1; x < w; x++) {
        if (bin[o + x] && bin[o + x - 1] && (k++ % step === 0)) { px.push(x); py.push(y); }
      }
    }
    const maxT = Math.tan(6 * Math.PI / 180);
    const off = Math.ceil(w * maxT) + 3;
    const size = h + 2 * off + 3;
    function score(deg) {
      const t = Math.tan(deg * Math.PI / 180);
      const hist = new Int32Array(size);
      for (let i = 0; i < px.length; i++) hist[Math.round(py[i] - px[i] * t) + off]++;
      let s = 0;
      for (let i = 0; i < size; i++) s += hist[i] * hist[i];
      return s;
    }
    let best = 0, bestScore = score(0);
    const zeroScore = bestScore;
    function search(from, to, stepDeg) {
      for (let a = from; a <= to + 1e-9; a += stepDeg) {
        const sc = score(a);
        if (sc > bestScore) { bestScore = sc; best = a; }
      }
    }
    search(-5, 5, 0.5);
    search(best - 0.5, best + 0.5, 0.1);
    search(best - 0.1, best + 0.1, 0.02);
    // Only trust a tilt correction if it clearly sharpens the lines.
    if (bestScore < zeroScore * 1.02) return 0;
    return Math.round(best * 100) / 100;
  }

  // Rotates a grayscale picture by deg (positive = clockwise), white fill.
  function rotateGray(gray, w, h, deg) {
    const phi = deg * Math.PI / 180;
    const c = Math.cos(phi), s = Math.sin(phi);
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx, dy = y - cy;
        const sx = c * dx + s * dy + cx;
        const sy = -s * dx + c * dy + cy;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) { out[y * w + x] = 255; continue; }
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const fx = sx - x0, fy = sy - y0;
        const top = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx;
        const bot = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx;
        out[y * w + x] = top * (1 - fy) + bot * fy;
      }
    }
    return out;
  }

  // Groups nearby indices (e.g. the 2–3 pixel rows one drawn line covers)
  // into {start, end, center}.
  function clusterIndices(indices, maxGap) {
    const out = [];
    let cur = null;
    indices.forEach((i) => {
      if (cur && i - cur.end <= maxGap) cur.end = i;
      else { cur = { start: i, end: i }; out.push(cur); }
    });
    out.forEach((c) => { c.center = (c.start + c.end) / 2; });
    return out;
  }

  // Finds the table's ruled lines. Returns { xs, ys } — the x positions of
  // the vertical lines and y positions of the horizontal ones — or null if
  // there is no recognizable ruled table.
  function findGrid(bin, w, h, region) {
    const { x0, y0, x1, y1 } = region;
    const at = (x, y) => (y < 0 || y >= h || x < 0 || x >= w) ? 0 : bin[y * w + x];

    // Horizontal lines: rows whose (slightly thickened) ink spans most of the width.
    const rowCov = new Int32Array(h);
    let maxRow = 0;
    for (let y = y0; y < y1; y++) {
      let c = 0;
      for (let x = x0; x < x1; x++) if (at(x, y - 1) || at(x, y) || at(x, y + 1)) c++;
      rowCov[y] = c;
      if (c > maxRow) maxRow = c;
    }
    if (maxRow < (x1 - x0) * 0.35) return null;
    const hRows = [];
    for (let y = y0; y < y1; y++) if (rowCov[y] >= maxRow * 0.6) hRows.push(y);
    let hLines = clusterIndices(hRows, 2);
    if (hLines.length < 2) return null;

    // Left/right edges of the table, taken from where those lines start and end.
    const firsts = [], lasts = [];
    hLines.forEach((ln) => {
      let first = -1, last = -1;
      for (let x = x0; x < x1; x++) {
        if (at(x, ln.center - 1) || at(x, ln.center) || at(x, ln.center + 1)) { if (first < 0) first = x; last = x; }
      }
      if (first >= 0) { firsts.push(first); lasts.push(last); }
    });
    const left = median(firsts), right = median(lasts);
    const top = hLines[0].center, bottom = hLines[hLines.length - 1].center;
    const span = bottom - top;
    if (span < 20 || right - left < 20) return null;

    // Vertical lines: columns whose ink covers most of the table's height.
    const colCov = new Int32Array(w);
    let maxCol = 0;
    for (let x = Math.max(x0, Math.floor(left) - 3); x < Math.min(x1, Math.ceil(right) + 4); x++) {
      let c = 0;
      for (let y = Math.floor(top) - 1; y <= Math.ceil(bottom) + 1; y++) {
        if (at(x - 1, y) || at(x, y) || at(x + 1, y)) c++;
      }
      colCov[x] = c;
      if (c > maxCol) maxCol = c;
    }
    const vCols = [];
    for (let x = 0; x < w; x++) if (colCov[x] >= span * 0.45) vCols.push(x);
    let vLines = clusterIndices(vCols, 2).map((c) => c.center);

    // Keep the table's outer edges even if the side borders are missing.
    if (!vLines.length || vLines[0] - left > 8) vLines.unshift(left);
    if (right - vLines[vLines.length - 1] > 8) vLines.push(right);

    // Drop lines that sit almost on top of each other (double rules).
    function dedupe(list) {
      const out = [];
      list.forEach((v) => { if (!out.length || v - out[out.length - 1] >= 8) out.push(v); });
      return out;
    }
    const ys = dedupe(hLines.map((c) => c.center));
    const xs = dedupe(vLines);
    if (ys.length < 3 || xs.length < 3) return null;
    return { xs, ys };
  }

  /* =========================================================
     STEP 2 — one cell -> a clean, enlarged image for the OCR
     ========================================================= */
  function otsuThreshold(values) {
    const hist = new Int32Array(256);
    for (let i = 0; i < values.length; i++) hist[values[i]]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // Value below which `frac` of the pixels fall (histogram-based; avoids sorting big arrays).
  function percentile(values, frac) {
    const hist = new Int32Array(256);
    for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, Math.round(values[i])))]++;
    const target = values.length * frac;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  function cropGray(gray, w, x0, y0, x1, y1) {
    const cw = x1 - x0, ch = y1 - y0;
    const out = new Uint8ClampedArray(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = gray[(y0 + y) * w + (x0 + x)];
    return { data: out, width: cw, height: ch };
  }

  // Is there real ink in this cell, or just an empty box / a sliver of
  // the border line left over at the edge?
  function cellInk(crop, relaxed) {
    const { data, width, height } = crop;
    const bg = percentile(data, 0.9);
    let count = 0, minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[y * width + x] < bg - 70) {
          count++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (count < (relaxed ? 6 : 12)) return false;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw <= (relaxed ? 1 : 4) || bh <= 3) return false;   // a stray line fragment, not text
    if (count / (width * height) < 0.002) return false;
    return true;
  }

  // Enlarge (bilinear) and pad with white — Tesseract reads text ~30–50px
  // tall with a margin far better than the 12–15px text found in a typical
  // timetable picture. mode "gray" keeps the shading (stretched to full
  // contrast) and lets Tesseract threshold it itself; mode "bin" black/whites
  // it first with Otsu. The two behave differently on borderline glyphs, which
  // is exactly why a second opinion catches misreadings.
  function prepareCellImage(crop, scale, mode, sharpAmount) {
    const sw = Math.max(1, Math.round(crop.width * scale));
    const sh = Math.max(1, Math.round(crop.height * scale));
    const up = new Uint8ClampedArray(sw * sh);
    for (let y = 0; y < sh; y++) {
      const fy = Math.min(crop.height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(crop.height - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < sw; x++) {
        const fx = Math.min(crop.width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(crop.width - 1, x0 + 1), wx = fx - x0;
        const a = crop.data[y0 * crop.width + x0] * (1 - wx) + crop.data[y0 * crop.width + x1] * wx;
        const b = crop.data[y1 * crop.width + x0] * (1 - wx) + crop.data[y1 * crop.width + x1] * wx;
        up[y * sw + x] = a * (1 - wy) + b * wy;
      }
    }
    const pad = 24;
    const W = sw + pad * 2, H = sh + pad * 2;
    const out = new Uint8ClampedArray(W * H).fill(255);
    if (mode === "bin") {
      const thr = otsuThreshold(up);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) out[(y + pad) * W + (x + pad)] = up[y * sw + x] > thr ? 255 : 0;
    } else {
      // Sharpen (unsharp mask) — recovers edges softened by a small or
      // blurry picture — then stretch so the background is white and the
      // ink is black.
      const sharp = unsharp(up, sw, sh, Math.max(1, Math.round(scale)), sharpAmount || 0);
      const lo = percentile(sharp, 0.01);
      const hi = percentile(sharp, 0.9);
      const range = Math.max(40, hi - lo);
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const v = (sharp[y * sw + x] - lo) / range * 255;
          out[(y + pad) * W + (x + pad)] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
    return { data: out, width: W, height: H };
  }

  // Unsharp mask with a separable box blur (fast enough for cell-sized images).
  function unsharp(data, W, H, radius, amount) {
    const tmp = new Float32Array(W * H), blur = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      let s = 0, n = 0;
      for (let x = 0; x <= radius && x < W; x++) { s += data[y * W + x]; n++; }
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = s / n;
        const a = x - radius, b = x + radius + 1;
        if (a >= 0) { s -= data[y * W + a]; n--; }
        if (b < W) { s += data[y * W + b]; n++; }
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let y = 0; y <= radius && y < H; y++) { s += tmp[y * W + x]; n++; }
      for (let y = 0; y < H; y++) {
        blur[y * W + x] = s / n;
        const a = y - radius, b = y + radius + 1;
        if (a >= 0) { s -= tmp[a * W + x]; n--; }
        if (b < H) { s += tmp[b * W + x]; n++; }
      }
    }
    const out = new Float32Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = data[i] + amount * (data[i] - blur[i]);
    return out;
  }

  /* =========================================================
     STEP 3 — read a cell, then tidy / self-correct the table
     ========================================================= */
  function cleanOcrText(text) {
    return (text || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/[|_]+/g, " ").replace(/\s+/g, " ").trim())
      .filter((l) => /[A-Za-z0-9]/.test(l))       // lines that are only stray marks
      .join("\n");
  }

  // Characters that essentially never appear in a timetable — a sign of a misread digit/letter.
  const SUSPICIOUS = /[$§¢£€¥@#%^*~`{}\[\]<>\\=]/;

  const TIME_RE = /(\d{1,2})\s*[:.;,]\s*(\d{2})\s*[-–—~_=]+\s*(\d{1,2})\s*[:.;,]\s*(\d{2})/;

  // "08:15 — 09:45", "8.15-9.45" ... -> "08:15 – 09:45" (matches the source's en dash).
  // Returns null when the text is not a recognizable, plausible time range.
  function normalizeTimeRange(text) {
    const m = TIME_RE.exec((text || "").replace(/\s+/g, " "));
    if (!m) return null;
    const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(h1)}:${p(m1)} – ${p(h2)}:${p(m2)}`;
  }

  const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
  const BREAK_WORDS = ["BREAK", "LUNCH", "RECESS"];
  const TITLES = ["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "mdm", "eng", "rev"];

  function applyCase(original, corrected) {
    if (original === original.toUpperCase()) return corrected.toUpperCase();
    return corrected.charAt(0) + corrected.slice(1).toLowerCase();
  }

  function snapWeekday(text) {
    const letters = (text || "").replace(/[^A-Za-z]/g, "").toUpperCase();
    if (letters.length < 4 || WEEKDAYS.includes(letters)) return null;
    let best = null, bestD = 99;
    WEEKDAYS.forEach((d) => {
      const dist = levenshtein(letters, d);
      if (dist < bestD) { bestD = dist; best = d; }
    });
    return bestD <= 2 ? applyCase(text.trim(), best) : null;
  }

  function tokenize(line) { return line.trim().split(/\s+/).filter(Boolean); }
  function alnum(s) { return s.replace(/[^\p{L}\p{N}]/gu, ""); }
  function isTitle(tok) { return TITLES.includes(alnum(tok).toLowerCase()); }

  // Can `rare` (seen once) safely be treated as a misreading of `freq`
  // (seen several times)? Deliberately strict — a real difference (Room 33
  // vs Room 32, Mr. J. vs Mr. K.) must never be "corrected" away. Only
  // punctuation slips, a title like "Mt." for "Mr.", or a 1–2 letter slip
  // inside a real word of 4+ letters qualify.
  function canCorrectLine(rare, freq) {
    const a = tokenize(rare), b = tokenize(freq);
    if (a.length !== b.length) return false;
    if (rare.replace(/\D/g, "") !== freq.replace(/\D/g, "")) return false;   // numbers must match
    let wordDiffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      const A = alnum(a[i]).toLowerCase(), B = alnum(b[i]).toLowerCase();
      if (A === B) continue;                                                  // punctuation only
      wordDiffs++;
      const d = levenshtein(A, B);
      const longWord = Math.min(A.length, B.length) >= 4 && !/\d/.test(A + B) && d <= 2;
      const titleSlip = i === 0 && isTitle(b[i]) && !isTitle(a[i]) && d <= 1;
      if (!(longWord || titleSlip)) return false;
    }
    return wordDiffs <= 1;
  }

  // Timetables repeat themselves (the same subject and lecturer sit in
  // several cells). If a line was read once in a slightly different way
  // from a line read several times, it is almost certainly a misreading.
  function consensusFix(rows, flags, skip) {
    const counts = new Map();   // key -> { n, forms: Map(original -> count) }
    const key = (l) => l.toLowerCase().replace(/\s+/g, " ").trim();
    rows.forEach((row, r) => row.forEach((cell, c) => {
      if (skip(r, c) || !cell) return;
      cell.split("\n").forEach((line) => {
        const k = key(line); if (!k) return;
        const e = counts.get(k) || { n: 0, forms: new Map() };
        e.n++; e.forms.set(line, (e.forms.get(line) || 0) + 1);
        counts.set(k, e);
      });
    }));
    const frequent = [...counts.entries()].filter(([, e]) => e.n >= 2);
    rows.forEach((row, r) => row.forEach((cell, c) => {
      if (skip(r, c) || !cell) return;
      const lines = cell.split("\n");
      let changed = false;
      const fixed = lines.map((line) => {
        const k = key(line);
        const e = counts.get(k);
        if (!e || e.n !== 1) return line;
        let best = null;
        frequent.forEach(([fk, fe]) => {
          if (fk === k || Math.abs(fk.length - k.length) > 3) return;
          const bestForm = [...fe.forms.entries()].sort((x, y) => y[1] - x[1])[0][0];
          if (canCorrectLine(line, bestForm) && (!best || fe.n > best.n)) best = { n: fe.n, form: bestForm };
        });
        if (best) { changed = true; return best.form; }
        return line;
      });
      if (changed) {
        rows[r][c] = fixed.join("\n");
        flags[r][c] = flags[r][c] || `Auto-corrected from "${cell.replace(/\n/g, " / ")}" to match the same text elsewhere in the table.`;
      }
    }));
  }

  // A break row is often "B | R | E | A | K" one letter per column. If most
  // of the word was read, fill in the rest (a single unreadable letter).
  function repairBreakRows(rows, flags, compactRows) {
    compactRows.forEach((r) => {
      const n = rows[r].length - 1;
      if (n < 3) return;
      let bestWord = null, bestMatches = 0;
      BREAK_WORDS.forEach((word) => {
        if (word.length !== n) return;
        let m = 0;
        for (let i = 0; i < n; i++) if ((rows[r][i + 1] || "").trim().toUpperCase() === word[i]) m++;
        if (m > bestMatches) { bestMatches = m; bestWord = word; }
      });
      if (!bestWord || bestMatches < 3) return;
      for (let i = 0; i < n; i++) {
        const cur = (rows[r][i + 1] || "").trim();
        if (cur.toUpperCase() !== bestWord[i]) {
          rows[r][i + 1] = bestWord[i];
          flags[r][i + 1] = `Filled in from the pattern "${bestWord}" (was ${cur ? `"${cur}"` : "blank"}).`;
        }
      }
    });
  }

  function parseTimeCell(text) {
    const m = TIME_RE.exec((text || "").replace(/\s+/g, " "));
    if (!m) return null;
    return { s: Number(m[1]) * 60 + Number(m[2]), e: Number(m[3]) * 60 + Number(m[4]) };
  }
  function fmtMinutes(min) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(min / 60))}:${p(min % 60)}`;
  }

  // In most timetables each period starts exactly when the previous row
  // ended (breaks are rows of their own). When that holds for most rows, a
  // time that doesn't line up is almost certainly a misread digit — fix it
  // if exactly one side can be changed by a single character and still make
  // sense, otherwise just highlight both.
  function repairTimeChain(rows, flags) {
    const times = rows.map((row, r) => (r === 0 ? null : parseTimeCell(row[0])));
    let pairs = 0, contiguous = 0;
    for (let r = 2; r < rows.length; r++) {
      if (!times[r] || !times[r - 1]) continue;
      pairs++;
      if (times[r].s === times[r - 1].e) contiguous++;
    }
    // A single period that ends before it starts is always worth a look.
    for (let r = 1; r < rows.length; r++) {
      if (times[r] && times[r].e <= times[r].s && !flags[r][0]) flags[r][0] = "This time range ends before it starts — please check it.";
    }
    if (pairs < 2 || contiguous / pairs < 0.5) return;
    const oneCharOff = (a, b) => levenshtein(fmtMinutes(a), fmtMinutes(b)) <= 1;
    for (let r = 2; r < rows.length; r++) {
      const prev = times[r - 1], cur = times[r];
      if (!prev || !cur || prev.e === cur.s) continue;
      const fixStart = oneCharOff(cur.s, prev.e) && prev.e < cur.e;          // change this row's start
      const fixEnd = oneCharOff(prev.e, cur.s) && cur.s > prev.s;            // change the previous row's end
      const rewrite = (row, t) => `${fmtMinutes(t.s)} – ${fmtMinutes(t.e)}`;
      if (fixStart && !fixEnd) {
        const was = rows[r][0];
        cur.s = prev.e;
        rows[r][0] = rewrite(r, cur);
        flags[r][0] = `Time adjusted from "${was}" so it starts when the previous row ends.`;
      } else if (fixEnd && !fixStart) {
        const was = rows[r - 1][0];
        prev.e = cur.s;
        rows[r - 1][0] = rewrite(r - 1, prev);
        flags[r - 1][0] = `Time adjusted from "${was}" so it ends when the next row starts.`;
      } else {
        const why = "This time doesn't line up with the row above/below it — please check.";
        if (!flags[r][0]) flags[r][0] = why;
        if (!flags[r - 1][0]) flags[r - 1][0] = why;
      }
    }
  }

  // Two classes that are almost word-for-word the same but not quite
  // (one has "Mr. Kareem", the other "Mr Kareem") — one of them is
  // probably misread, and only a person can tell which. Highlight both.
  function flagTwinMismatches(rows, flags, skip) {
    const cells = [];
    rows.forEach((row, r) => row.forEach((cell, c) => { if (!skip(r, c) && cell && cell.includes("\n")) cells.push({ r, c, text: cell, lines: cell.split("\n") }); }));
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        if (a.text === b.text || a.lines.length !== b.lines.length) continue;
        const same = a.lines.filter((l, k) => l === b.lines[k]).length;
        if (same < Math.ceil(a.lines.length / 2) + (a.lines.length > 2 ? 0 : 1) || same === a.lines.length) continue;
        if (levenshtein(a.text.toLowerCase(), b.text.toLowerCase()) > Math.max(3, Math.round(a.text.length * 0.15))) continue;
        const why = "Looks like the same class as another cell but reads slightly differently — check which one is right.";
        if (!flags[a.r][a.c]) flags[a.r][a.c] = why;
        if (!flags[b.r][b.c]) flags[b.r][b.c] = why;
      }
    }
  }

  function meanConf(res) {
    const c = (res.words || []).filter((w) => /[A-Za-z0-9]/.test(w.text || "")).map((w) => w.confidence);
    return c.length ? c.reduce((a, b) => a + b, 0) / c.length : 0;
  }

  // Several readings of the same cell -> one answer. Majority per line;
  // ties go to the reading Tesseract itself was most confident about.
  function voteReadings(readings) {
    const texts = readings.map((r) => cleanOcrText(r.text));
    if (texts.every((t) => t === texts[0])) return { text: texts[0], agreed: true };
    const confs = readings.map(meanConf);
    // Only readings with the most common number of lines can vote line-by-line.
    const lineCounts = texts.map((t) => (t ? t.split("\n").length : 0));
    const tally = new Map();
    lineCounts.forEach((n) => tally.set(n, (tally.get(n) || 0) + 1));
    let bestN = lineCounts[0], bestCount = 0;
    tally.forEach((cnt, n) => { if (cnt > bestCount || (cnt === bestCount && n > bestN)) { bestCount = cnt; bestN = n; } });
    const group = texts.map((t, i) => i).filter((i) => lineCounts[i] === bestN);
    let bestIdx = group[0];
    group.forEach((i) => { if (confs[i] > confs[bestIdx]) bestIdx = i; });
    if (group.length < 2 || bestN === 0) return { text: texts[bestIdx], agreed: false };
    const split = group.map((i) => texts[i].split("\n"));
    const lines = [];
    for (let li = 0; li < bestN; li++) {
      const votes = new Map();
      group.forEach((i, gi) => {
        const line = split[gi][li];
        const e = votes.get(line) || { n: 0, conf: 0 };
        e.n++; e.conf = Math.max(e.conf, confs[i]);
        votes.set(line, e);
      });
      let win = null;
      votes.forEach((e, line) => { if (!win || e.n > win.e.n || (e.n === win.e.n && e.conf > win.e.conf)) win = { line, e }; });
      lines.push(win.line);
    }
    return { text: lines.join("\n"), agreed: false };
  }

  // Reads one cell. role: "header" | "time" | "compact" | "body".
  // recognize(img, { psm, whitelist }) -> Promise<{ text, words:[{text, confidence}] }>
  async function readCell(crop, role, scale, recognize) {
    if (!cellInk(crop, role === "compact")) return { text: "", flag: null };
    let res, flag = null;

    if (role === "time") {
      const img = prepareCellImage(crop, scale, "gray", 2);
      res = await recognize(img, { psm: 6, whitelist: "0123456789:.;,-–—~ " });
      const t = normalizeTimeRange(res.text);
      if (t) return { text: t, flag: null };
      // Not a clock time (e.g. "Period 1") — read it again without the digits-only restriction.
      res = await recognize(img, { psm: 6, whitelist: "" });
      const t2 = normalizeTimeRange(res.text);
      if (t2) return { text: t2, flag: null };
    } else if (role === "compact") {
      // Thin break/lunch bars hold single letters — hard for OCR, so keep
      // trying different settings until something is read.
      const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const tries = [[2, 7, LETTERS], [2, 10, LETTERS], [0, 7, LETTERS], [0, 10, LETTERS], [2, 7, ""]];
      res = { text: "", words: [] };
      for (const [amt, psm, wl] of tries) {
        res = await recognize(prepareCellImage(crop, scale, "gray", amt), { psm, whitelist: wl });
        if (cleanOcrText(res.text)) break;
      }
    } else if (role === "header") {
      res = await recognize(prepareCellImage(crop, scale, "gray", 2), { psm: 6, whitelist: "" });
    } else {
      // Body cells hold the subject / lecturer / room — the part that matters
      // most and the easiest to misread ("ROOM 51" -> "ROOM 351"). Read it
      // twice with different enlargement; if they disagree, get a third
      // opinion and vote. Any disagreement is highlighted for a human check.
      const a = await recognize(prepareCellImage(crop, scale, "gray", 0), { psm: 6, whitelist: "" });
      const b = await recognize(prepareCellImage(crop, scale * 0.67, "gray", 2), { psm: 6, whitelist: "" });
      const readings = [a, b];
      if (cleanOcrText(a.text) !== cleanOcrText(b.text)) {
        readings.push(await recognize(prepareCellImage(crop, scale, "gray", 1.2), { psm: 6, whitelist: "" }));
      }
      const voted = voteReadings(readings);
      res = { text: voted.text, words: a.words };
      if (!voted.agreed) flag = "Two readings of this cell disagreed — please check it against the original.";
      else if ((a.words || []).some((w) => /[A-Za-z0-9]{2,}/.test(w.text) && w.confidence < 40)) flag = "The reader was not sure about this text — please check it against the original.";
    }

    const text = cleanOcrText(res.text);
    if (!text) return { text: "", flag: "There is writing in this cell that could not be read — please type it in." };

    // A broken time (digits but not a clean range) deserves a look; a plain label like "Monday" or "Lunch" does not.
    if (role === "time" && /\d/.test(text)) flag = "Could not read this as a time — please check it.";
    if (!flag && SUSPICIOUS.test(text)) flag = "Contains an unusual symbol — probably a misreading; please check it.";
    if (role !== "body") {
      const words = (res.words || []).filter((w) => /[A-Za-z0-9]/.test(w.text || ""));
      const single = text.replace(/\s/g, "").length <= 2;
      const shaky = words.filter((w) => (single ? w.confidence < 55 : (/[A-Za-z0-9]{2,}/.test(w.text) && w.confidence < 50)));
      if (!flag && shaky.length) flag = "The reader was not sure about this text — please check it against the original.";
    }
    return { text, flag };
  }

  // Runs the whole grid: returns { rows, flags }.
  async function readGrid(gray, w, grid, recognize, onProgress) {
    let { xs, ys } = grid;
    const scale = Math.min(3, Math.max(1, 3600 / w));
    const margin = Math.max(3, Math.round(w / 300));
    const rect = (r, c) => [Math.round(xs[c] + margin), Math.round(ys[r] + margin), Math.round(xs[c + 1] - margin), Math.round(ys[r + 1] - margin)];
    const usable = ([x0, y0, x1, y1]) => x1 - x0 >= 6 && y1 - y0 >= 6;

    // Drop empty outer strips first (the gap between the table and a photo's
    // dark frame can look like an extra row/column) so that "first column" and
    // "first row" really mean the table's own time column and header row.
    const inked = (r, c) => { const q = rect(r, c); return usable(q) && cellInk(cropGray(gray, w, q[0], q[1], q[2], q[3])); };
    const rowInk = (r) => xs.slice(0, -1).some((_, c) => inked(r, c));
    const colInk = (c) => ys.slice(0, -1).some((_, r) => inked(r, c));
    let r0 = 0, r1 = ys.length - 2, c0 = 0, c1 = xs.length - 2;
    while (r1 - r0 >= 1 && !rowInk(r0)) r0++;
    while (r1 - r0 >= 1 && !rowInk(r1)) r1--;
    while (c1 - c0 >= 1 && !colInk(c0)) c0++;
    while (c1 - c0 >= 1 && !colInk(c1)) c1--;
    ys = ys.slice(r0, r1 + 2);
    xs = xs.slice(c0, c1 + 2);

    const rowH = [];
    for (let i = 0; i < ys.length - 1; i++) rowH.push(ys[i + 1] - ys[i]);
    const medH = median(rowH);

    const rows = [], flags = [], compactRows = [];
    const total = (ys.length - 1) * (xs.length - 1);
    let done = 0;
    for (let r = 0; r < ys.length - 1; r++) {
      const compact = r > 0 && rowH[r] < medH * 0.6;
      if (compact) compactRows.push(r);
      const row = [], frow = [];
      for (let c = 0; c < xs.length - 1; c++) {
        let out = { text: "", flag: null };
        const q = rect(r, c);
        if (usable(q)) {
          const role = r === 0 ? "header" : c === 0 ? "time" : compact ? "compact" : "body";
          out = await readCell(cropGray(gray, w, q[0], q[1], q[2], q[3]), role, scale, recognize);
        }
        row.push(out.text);
        frow.push(out.flag);
        done++;
        if (onProgress) onProgress(Math.round(done / total * 100), "Reading cell " + done + " of " + total + "…");
      }
      rows.push(row);
      flags.push(frow);
    }

    // A break/lunch bar with letters in most cells but a blank one: the blank
    // is almost certainly a letter that was too small to read.
    compactRows.forEach((r) => {
      const filled = rows[r].slice(1).filter(Boolean).length;
      if (filled >= 2) rows[r].forEach((cell, c) => {
        if (c > 0 && !cell && !flags[r][c]) flags[r][c] = "Nothing was read here, but the cells beside it have letters — please check.";
      });
    });

    // Clean-up passes.
    rows[0].forEach((cell, c) => {
      const snapped = c > 0 ? snapWeekday(cell) : null;
      if (snapped) { flags[0][c] = flags[0][c] || `Corrected from "${cell}" to the weekday name.`; rows[0][c] = snapped; }
    });
    repairBreakRows(rows, flags, compactRows);
    consensusFix(rows, flags, (r, c) => r === 0 || c === 0 || compactRows.includes(r));
    flagTwinMismatches(rows, flags, (r, c) => r === 0 || c === 0 || compactRows.includes(r));
    repairTimeChain(rows, flags);
    return { rows, flags };
  }

  /* ---------------- fallback: whole-page words -> table grid ---------------- */
  function wordsToTable(words, minConf) {
    const usable = words.filter((w) => w.text && w.text.trim() && w.bbox && /[A-Za-z0-9]/.test(w.text)
      && (minConf == null || w.confidence == null || w.confidence >= minConf));
    if (!usable.length) return [[""]];

    const enriched = usable.map((w) => ({
      text: w.text.trim(),
      x0: w.bbox.x0, x1: w.bbox.x1,
      yc: (w.bbox.y0 + w.bbox.y1) / 2,
      xc: (w.bbox.x0 + w.bbox.x1) / 2,
      h: w.bbox.y1 - w.bbox.y0,
    })).sort((a, b) => a.yc - b.yc);

    // --- rows: greedily cluster by vertical center ---
    const rowHeight = median(enriched.map((w) => w.h)) || 20;
    const rowGap = rowHeight * 0.7;
    const rows = [];
    enriched.forEach((w) => {
      let row = rows.find((r) => Math.abs(r.yc - w.yc) < rowGap);
      if (!row) { row = { yc: w.yc, words: [] }; rows.push(row); }
      row.words.push(w);
      row.yc = row.words.reduce((s, ww) => s + ww.yc, 0) / row.words.length;
    });
    rows.sort((a, b) => a.yc - b.yc);

    // --- columns: find horizontal gaps across every word on the page ---
    const wordWidth = median(enriched.map((w) => w.x1 - w.x0)) || 40;
    const colGap = wordWidth * 1.6;
    const xs = enriched.map((w) => w.x0).sort((a, b) => a - b);
    const bounds = [];
    let start = xs[0], prev = xs[0];
    xs.forEach((x) => {
      if (x - prev > colGap) { bounds.push({ start, end: prev }); start = x; }
      prev = x;
    });
    bounds.push({ start, end: prev });

    function colIndexFor(x0) {
      for (let i = 0; i < bounds.length; i++) {
        if (x0 <= bounds[i].end + colGap / 2) return i;
      }
      return bounds.length - 1;
    }

    const grid = rows.map((row) => {
      const cells = new Array(bounds.length).fill("");
      row.words.sort((a, b) => a.xc - b.xc).forEach((w) => {
        const ci = colIndexFor(w.x0);
        cells[ci] = cells[ci] ? cells[ci] + " " + w.text : w.text;
      });
      return cells;
    });

    return mergeContinuationRows(grid);
  }

  // A timetable row (e.g. "08:15–09:45") is usually one taller band in
  // the source, but OCR reports each stacked line inside it — subject,
  // lecturer, room — as its own separate text-line. Those continuation
  // lines have nothing in the first (time) column, so anything with a
  // blank first cell gets folded into the previous real row as extra
  // lines within each of its cells, rather than becoming its own row.
  function mergeContinuationRows(rows) {
    if (!rows.length) return rows;
    const merged = [rows[0].slice()];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if ((row[0] || "").trim()) {
        merged.push(row.slice());
        continue;
      }
      const prev = merged[merged.length - 1];
      row.forEach((cell, ci) => {
        const c = (cell || "").trim();
        if (!c) return;
        prev[ci] = prev[ci] ? prev[ci] + "\n" + c : c;
      });
    }
    return merged;
  }

  // A short/empty-across-every-column row (a break, lunch, or "BREAK"
  // spelled one letter per column) — flagged so it can be shaded and
  // centered like the source timetable's thin divider bars, without
  // needing to know the actual row height from the source image.
  function isCompactRow(row) {
    const rest = row.slice(1);
    if (!rest.some((c) => c && c.trim())) return false;
    return rest.every((c) => !c || c.trim().length <= 3);
  }

  /* =========================================================
     Whole-picture driver (pure): gray in -> { rows, flags, mode }
     ========================================================= */
  async function extractFromGray(gray, w, h, recognize, onProgress) {
    if (onProgress) onProgress(3, "Straightening the picture…");
    let bin = adaptiveDark(gray, w, h);
    const tilt = estimateSkewDeg(bin, w, h);
    if (Math.abs(tilt) >= 0.15) {
      gray = rotateGray(gray, w, h, -tilt);
      bin = adaptiveDark(gray, w, h);
    }
    if (onProgress) onProgress(6, "Finding the table lines…");
    const region = frameRegion(bin, w, h);
    const grid = findGrid(bin, w, h, region);
    if (!grid) return { rows: null, flags: null, mode: "nogrid", gray, tilt };
    const { rows, flags } = await readGrid(gray, w, grid, recognize, onProgress);
    return { rows, flags, mode: "grid", gray, tilt, grid };
  }

  /* ---------------- public: run OCR on an uploaded file ---------------- */
  async function fileToCanvas(file) {
    if (typeof HTMLCanvasElement !== "undefined" && file instanceof HTMLCanvasElement) return file;
    const MAX = 3200;
    let bmp = null;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { try { bmp = await createImageBitmap(file); } catch { bmp = null; } }
    if (!bmp) {
      // Older browsers: read as a data: URL (allowed by every page's img-src).
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error("Could not read the file"));
        fr.readAsDataURL(file);
      });
      bmp = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not open the picture"));
        img.src = dataUrl;
      });
    }
    const bw = bmp.width || bmp.naturalWidth, bh = bmp.height || bmp.naturalHeight;
    const k = Math.min(1, MAX / Math.max(bw, bh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bw * k);
    canvas.height = Math.round(bh * k);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function canvasToGray(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const gray = new Uint8ClampedArray(canvas.width * canvas.height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    }
    return gray;
  }

  function grayToCanvas(img) {
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(img.width, img.height);
    for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
      id.data[p] = id.data[p + 1] = id.data[p + 2] = img.data[i];
      id.data[p + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  // A small picture of the original, as a data: URL (blob: URLs are not
  // allowed by the pages' img-src policy), shown beside the editable table.
  function makePreviewUrl(canvas) {
    try {
      const k = Math.min(1, 1400 / canvas.width);
      const c = document.createElement("canvas");
      c.width = Math.round(canvas.width * k);
      c.height = Math.round(canvas.height * k);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(canvas, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.85);
    } catch { return null; }
  }

  async function ocrExtractTable(file, { onProgress } = {}) {
    if (onProgress) onProgress(0, "Loading the reader…");
    await loadOcrLibs();

    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (onProgress) onProgress(1, "Opening the file…");
    const canvas = isPdf ? await rasterizePdfFirstPage(file) : await fileToCanvas(file);
    const previewUrl = makePreviewUrl(canvas);
    const w = canvas.width, h = canvas.height;
    const gray0 = canvasToGray(canvas);

    const worker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: `${CDN}/tesseract.js@5.1.1/dist/worker.min.js`,
      corePath: `${CDN}/tesseract.js-core@5.1.1/tesseract-core.wasm.js`,
      langPath: TESS_LANG_PATH,
    });

    try {
      await worker.setParameters({ user_defined_dpi: "300", preserve_interword_spaces: "1" });
      let current = { psm: null, wl: null };
      async function recognize(img, { psm, whitelist }) {
        if (current.psm !== psm || current.wl !== whitelist) {
          await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist || "" });
          current = { psm, wl: whitelist };
        }
        const { data } = await worker.recognize(grayToCanvas(img));
        return { text: data.text || "", words: (data.words || []).map((x) => ({ text: x.text, confidence: x.confidence })) };
      }

      const result = await extractFromGray(gray0, w, h, recognize, onProgress);
      if (result.mode === "grid") {
        const flagCount = result.flags.reduce((n, r) => n + r.filter(Boolean).length, 0);
        return { rows: result.rows, flags: result.flags, flagCount, previewUrl, mode: "grid", rawText: result.rows.map((r) => r.join(" | ")).join("\n") };
      }

      // No ruled table found — fall back to reading the whole page, but
      // ignore low-confidence "words" (logos, crests, smudges).
      if (onProgress) onProgress(10, "No table lines found — reading the whole page…");
      await worker.setParameters({ tessedit_pageseg_mode: "3", tessedit_char_whitelist: "" });
      const { data } = await worker.recognize(canvas);
      const rows = wordsToTable(data.words || [], 45);
      return { rows, flags: null, flagCount: 0, previewUrl, mode: "fallback", rawText: data.text || "" };
    } finally {
      await worker.terminate();
    }
  }

  /* ---------------- editable table UI ---------------- */
  function normalizeRows(rows) {
    let r = (rows && rows.length ? rows : [[""]]).map((row) => row.slice());
    const width = Math.max(1, ...r.map((row) => row.length));
    r.forEach((row) => { while (row.length < width) row.push(""); });
    return r;
  }

  function mkButton(label, onClick, className) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className || "btn btn-secondary btn-sm";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // A cell can hold several stacked lines (subject / lecturer / room,
  // like the source timetable). These two helpers move between that and
  // a plain "\n"-joined string, using <br> in the DOM so editing keeps
  // working with the browser's normal text-selection/cursor behavior.
  function fillEditableCell(td, text) {
    td.innerHTML = "";
    const lines = (text || "").split("\n");
    lines.forEach((line, i) => {
      td.appendChild(document.createTextNode(line));
      if (i < lines.length - 1) td.appendChild(document.createElement("br"));
    });
  }

  function readEditableCell(td) {
    let text = "";
    td.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
      else if (node.nodeName === "BR") text += "\n";
      else text += node.textContent || "";
    });
    return text;
  }

  // Read-only equivalent: stacked <div>s so multi-line cells wrap the
  // same way visually, with the first line bolded — mirrors how the
  // source timetables put the subject name above the lecturer and room.
  function fillDisplayCell(el, text, allowBold) {
    el.innerHTML = "";
    const lines = (text || "").split("\n");
    if (lines.length === 1) { el.textContent = lines[0]; return; }
    lines.forEach((line, i) => {
      const div = document.createElement("div");
      if (allowBold && i === 0) div.style.fontWeight = "600";
      div.textContent = line;
      el.appendChild(div);
    });
  }

  function normalizeFlags(flags, rows) {
    return rows.map((row, r) => row.map((_, c) => (flags && flags[r] && flags[r][c]) || null));
  }

  // Renders an editable grid into `container`. Returns { getRows, setRows }.
  // opts: { onChange(rows), flags: [[reason|null]], previewUrl: dataURL }
  //  - flags marks cells the reader was unsure about (highlighted until edited)
  //  - previewUrl shows the original picture above the table for comparison
  function renderTimetableEditor(container, initialRows, opts) {
    opts = opts || {};
    let rows = normalizeRows(initialRows);
    let flags = normalizeFlags(opts.flags, rows);
    let previewUrl = opts.previewUrl || null;

    container.innerHTML = "";
    container.classList.add("tt-editor");

    const sourceWrap = document.createElement("div");
    container.appendChild(sourceWrap);

    const toolbar = document.createElement("div");
    toolbar.className = "tt-editor-toolbar";
    toolbar.append(
      mkButton("+ Row", () => { rows.push(new Array(rows[0].length).fill("")); flags.push(new Array(rows[0].length).fill(null)); redraw(); emitChange(); }),
      mkButton("+ Column", () => { rows.forEach((r) => r.push("")); flags.forEach((f) => f.push(null)); redraw(); emitChange(); })
    );
    const legend = document.createElement("span");
    legend.className = "tt-check-legend";
    toolbar.appendChild(legend);
    container.appendChild(toolbar);

    const tableWrap = document.createElement("div");
    tableWrap.className = "tt-editor-table-wrap";
    container.appendChild(tableWrap);

    function emitChange() {
      if (opts.onChange) opts.onChange(rows.map((r) => r.slice()));
    }

    function countFlags() { return flags.reduce((n, r) => n + r.filter(Boolean).length, 0); }

    function updateLegend() {
      const n = countFlags();
      legend.textContent = n
        ? `${n} highlighted cell${n === 1 ? "" : "s"} — the reader was unsure; check against the original, then edit if needed.`
        : "";
    }

    function drawSource() {
      sourceWrap.innerHTML = "";
      if (!previewUrl) return;
      const details = document.createElement("details");
      details.className = "tt-source";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = "Original picture (click the picture to enlarge)";
      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = "Original timetable";
      img.addEventListener("click", () => img.classList.toggle("tt-source-zoom"));
      details.append(summary, img);
      sourceWrap.appendChild(details);
    }

    function redraw() {
      tableWrap.innerHTML = "";
      const table = document.createElement("table");
      table.className = "tt-editor-table";

      // Column-delete control row along the top.
      const ctlRow = document.createElement("tr");
      ctlRow.appendChild(document.createElement("td")).className = "tt-editor-ctl";
      rows[0].forEach((_, cIdx) => {
        const td = document.createElement("td");
        td.className = "tt-editor-ctl";
        if (rows[0].length > 1) {
          td.appendChild(mkButton("×", () => {
            rows.forEach((r) => r.splice(cIdx, 1));
            flags.forEach((f) => f.splice(cIdx, 1));
            redraw(); emitChange();
          }, "tt-editor-del"));
        }
        ctlRow.appendChild(td);
      });
      table.appendChild(ctlRow);

      rows.forEach((row, rIdx) => {
        const tr = document.createElement("tr");
        if (rIdx === 0) tr.classList.add("tt-editor-header-row");
        else if (isCompactRow(row)) tr.classList.add("tt-row-compact");

        const delTd = document.createElement("td");
        delTd.className = "tt-editor-ctl";
        if (rows.length > 1) {
          delTd.appendChild(mkButton("×", () => {
            rows.splice(rIdx, 1);
            flags.splice(rIdx, 1);
            redraw(); emitChange();
          }, "tt-editor-del"));
        }
        tr.appendChild(delTd);

        row.forEach((cell, cIdx) => {
          const td = document.createElement("td");
          td.contentEditable = "true";
          fillEditableCell(td, cell);
          if (flags[rIdx][cIdx]) {
            td.classList.add("tt-cell-check");
            td.title = flags[rIdx][cIdx];
          }
          // Enter inside a cell should add a line within it (matching
          // how the source stacks subject/lecturer/room), not submit
          // anything or produce inconsistent browser-default markup.
          td.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter") return;
            ev.preventDefault();
            document.execCommand("insertHTML", false, "<br>");
          });
          td.addEventListener("input", () => {
            rows[rIdx][cIdx] = readEditableCell(td);
            // Once someone has touched a highlighted cell, it counts as checked.
            if (flags[rIdx][cIdx]) {
              flags[rIdx][cIdx] = null;
              td.classList.remove("tt-cell-check");
              td.removeAttribute("title");
              updateLegend();
            }
          });
          td.addEventListener("blur", emitChange);
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });

      tableWrap.appendChild(table);
      updateLegend();
    }

    drawSource();
    redraw();
    return {
      getRows: () => rows.map((r) => r.slice()),
      setRows: (newRows, extra) => {
        rows = normalizeRows(newRows);
        flags = normalizeFlags(extra && extra.flags, rows);
        if (extra && "previewUrl" in extra) { previewUrl = extra.previewUrl || null; drawSource(); }
        redraw(); emitChange();
      },
    };
  }

  // Read-only render (student/lecturer viewing, not editing).
  function renderTimetableView(container, rows, opts) {
    container.innerHTML = "";
    const norm = normalizeRows(rows);
    const options = opts || {};
    if (!options.noEnlarge) {
      const hint = document.createElement("div");
      hint.className = "tt-hint";
      hint.textContent = "Tap the timetable to enlarge it";
      container.appendChild(hint);
    }
    const table = document.createElement("table");
    table.className = "tt-view-table";
    norm.forEach((row, rIdx) => {
      const tr = document.createElement("tr");
      if (rIdx > 0 && isCompactRow(row)) tr.classList.add("tt-row-compact");
      row.forEach((cell) => {
        const el = document.createElement(rIdx === 0 ? "th" : "td");
        fillDisplayCell(el, cell, rIdx > 0);
        tr.appendChild(el);
      });
      table.appendChild(tr);
    });
    container.appendChild(table);
    fitTimetableToWidth(container, table);
    if (!options.noEnlarge) enableTimetableEnlarge(container, norm, options.title);
  }

  /* ---------------- export ---------------- */
  function slug(s) {
    return (s || "timetable").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "timetable";
  }

  /* <viewer-kit> */
  /* Self-contained helpers shared by the portal's timetable view and the offline
     page: saving files, fitting a table to the screen, building the timetable as
     an image, and the full-screen "gallery" viewer with pinch-to-zoom. The
     offline page copies this block in when it is built, so edit it here only. */

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking straight away can cancel the download on some phones.
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function inApp() {
    const cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()
      && typeof cap.nativePromise === "function");
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(reader.error || new Error("Could not read the file"));
      reader.readAsDataURL(blob);
    });
  }

  // In the Android app the file goes straight into the phone's Downloads folder
  // (GTIDownloads, added by the app's MainActivity). Older app builds without it
  // fall back to the share sheet; a normal browser just downloads.
  async function saveFile(blob, filename) {
    const bridge = window.GTIDownloads;
    if (bridge && typeof bridge.save === "function") {
      const data = await blobToBase64(blob);
      if (bridge.save(filename, blob.type || "application/octet-stream", data)) return;
      throw new Error("Could not save the file");
    }
    if (!inApp()) { downloadBlob(blob, filename); return; }
    const data = await blobToBase64(blob);
    const written = await window.Capacitor.nativePromise("Filesystem", "writeFile", {
      path: filename,
      data,
      directory: "CACHE",
    });
    try {
      await window.Capacitor.nativePromise("Share", "share", {
        title: filename,
        dialogTitle: "Save or share your timetable",
        url: written.uri,
      });
    } catch (err) {
      if (!/cancel/i.test(String(err && (err.message || err)))) throw err;
    }
  }

  function tvSlug(s) {
    return String(s || "timetable").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "timetable";
  }

  function tvIsCompact(row) {
    const rest = row.slice(1);
    if (!rest.some((c) => c && c.trim())) return false;
    return rest.every((c) => !c || c.trim().length <= 3);
  }

  /* ---- zoomed-out view: scale the whole table to fit the screen width ---- */
  function fitTimetableToWidth(wrap, table) {
    if (wrap._ttFit) { wrap._ttFit.disconnect(); wrap._ttFit = null; }
    if (!("ResizeObserver" in window) || !window.matchMedia) return;
    const phone = window.matchMedia("(max-width: 760px)");
    let lastWidth = -1;
    function fit() {
      const avail = wrap.clientWidth;
      if (avail <= 0) return;
      table.style.zoom = "";
      wrap.classList.remove("tt-tight");
      if (!phone.matches) return;
      const natural = table.scrollWidth;
      if (natural <= avail + 1) return;
      let scale = avail / natural;
      if (scale < 0.8) {
        // Letting long words break shrinks the table's natural width, which
        // lets the text be shown larger. Only keep it if it helps noticeably.
        wrap.classList.add("tt-tight");
        const tightScale = avail / table.scrollWidth;
        if (tightScale > scale + 0.05) scale = tightScale;
        else wrap.classList.remove("tt-tight");
      }
      table.style.zoom = String(Math.min(1, Math.max(scale, 0.3)));
    }
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      fit();
    });
    ro.observe(wrap);
    wrap._ttFit = ro;
    fit();
  }

  /* ---- the timetable as a picture ---- */
  function tvWrap(ctx, text, maxW) {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines = [];
    let cur = "";
    const pushLong = (word) => {
      let piece = "";
      for (const ch of word) {
        if (ctx.measureText(piece + ch).width > maxW && piece) { lines.push(piece); piece = ch; }
        else piece += ch;
      }
      return piece;
    };
    words.forEach((word) => {
      const test = cur ? cur + " " + word : word;
      if (ctx.measureText(test).width <= maxW) { cur = test; return; }
      if (cur) lines.push(cur);
      cur = ctx.measureText(word).width <= maxW ? word : pushLong(word);
    });
    if (cur) lines.push(cur);
    return lines;
  }

  async function buildTimetableImage(rows, title) {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
    const FONT = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
    const FS = 13, LINE = 17, PAD_X = 10, PAD_Y = 8, MARGIN = 18, MAX_COL = 220, MIN_COL = 54;
    const grid = (rows && rows.length ? rows : [[""]]).map((r) => r.map((c) => (c == null ? "" : String(c).replace(/\r/g, ""))));
    const width = Math.max(1, ...grid.map((r) => r.length));
    grid.forEach((r) => { while (r.length < width) r.push(""); });
    const compact = grid.map((r, i) => i > 0 && tvIsCompact(r));
    const m = document.createElement("canvas").getContext("2d");
    const fontOf = (bold) => (bold ? "600 " : "400 ") + FS + "px " + FONT;
    const isBold = (i, k, count) => i === 0 || (count > 1 && k === 0);

    const colW = new Array(width).fill(MIN_COL);
    grid.forEach((r, i) => {
      if (compact[i]) return;
      r.forEach((cell, c) => {
        const raw = cell.split("\n");
        let line = 0, word = 0;
        raw.forEach((ln, k) => {
          m.font = fontOf(isBold(i, k, raw.length));
          const t = i === 0 ? ln.toUpperCase() : ln;
          line = Math.max(line, m.measureText(t).width);
          t.split(/\s+/).forEach((w) => { word = Math.max(word, m.measureText(w).width); });
        });
        colW[c] = Math.max(colW[c], Math.min(MAX_COL, Math.max(line, word)) + PAD_X * 2);
      });
    });
    const tableW = colW.reduce((a, b) => a + b, 0);

    const layout = grid.map((r, i) => {
      if (compact[i]) {
        const word = r.slice(1).map((c) => c.trim()).join(" ");
        return { compact: true, label: r[0], word, h: LINE + PAD_Y * 2 };
      }
      const cells = r.map((cell, c) => {
        const raw = cell.split("\n");
        const out = [];
        raw.forEach((ln, k) => {
          const bold = isBold(i, k, raw.length);
          m.font = fontOf(bold);
          tvWrap(m, i === 0 ? ln.toUpperCase() : ln, colW[c] - PAD_X * 2).forEach((t) => out.push({ t, bold }));
        });
        return out.length ? out : [{ t: "", bold: false }];
      });
      return { compact: false, cells, h: Math.max(...cells.map((l) => l.length)) * LINE + PAD_Y * 2 };
    });
    const tableH = layout.reduce((a, r) => a + r.h, 0);
    const titleH = title ? 34 : 0;
    const W = Math.ceil(tableW + MARGIN * 2);
    const H = Math.ceil(MARGIN * 2 + titleH + tableH);
    const scale = Math.max(1, Math.min(3, 8000 / W, 8000 / H));

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    const g = canvas.getContext("2d");
    g.scale(scale, scale);
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, W, H);
    g.textBaseline = "middle";

    let y = MARGIN;
    if (title) {
      g.font = "700 18px " + FONT;
      g.fillStyle = "#0b3972";
      g.textAlign = "left";
      g.fillText(String(title), MARGIN, y + 14);
      y += titleH;
    }
    layout.forEach((row, i) => {
      let x = MARGIN;
      if (row.compact) {
        g.fillStyle = "#e6edf5";
        g.fillRect(x, y, tableW, row.h);
        g.fillStyle = "#3a4a5c";
        g.font = "italic 600 " + FS + "px " + FONT;
        g.textAlign = "center";
        g.fillText(row.label.trim(), x + colW[0] / 2, y + row.h / 2);
        g.fillText(row.word, x + colW[0] + (tableW - colW[0]) / 2, y + row.h / 2);
      } else {
        row.cells.forEach((lines, c) => {
          g.fillStyle = i === 0 ? "#0b3972" : (i % 2 ? "#ffffff" : "#f3f6fa");
          g.fillRect(x, y, colW[c], row.h);
          g.textAlign = "center";
          const startY = y + row.h / 2 - ((lines.length - 1) * LINE) / 2;
          lines.forEach((ln, k) => {
            g.font = fontOf(ln.bold);
            g.fillStyle = i === 0 ? "#ffffff" : "#1b2733";
            g.fillText(ln.t, x + colW[c] / 2, startY + k * LINE);
          });
          x += colW[c];
        });
      }
      g.strokeStyle = "#cfd8e3";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(MARGIN, y + row.h);
      g.lineTo(MARGIN + tableW, y + row.h);
      g.stroke();
      y += row.h;
    });
    g.strokeStyle = "#cfd8e3";
    let vx = MARGIN;
    for (let c = 0; c <= width; c++) {
      g.beginPath(); g.moveTo(vx, MARGIN + titleH); g.lineTo(vx, MARGIN + titleH + tableH); g.stroke();
      vx += colW[c] || 0;
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not create the image");
    return { blob, width: W, height: H, scale };
  }

  /* ---- full-screen viewer, like opening a picture in a gallery ---- */
  let tvOpen = false;

  function tvInjectStyle() {
    if (document.getElementById("ttViewerStyle")) return;
    const style = document.createElement("style");
    style.id = "ttViewerStyle";
    style.textContent = [
      ".tt-viewer{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2000;background:rgba(3,6,10,.97);display:flex;flex-direction:column;color:#e8edf2;touch-action:none;-webkit-user-select:none;user-select:none}",
      ".tt-viewer-bar{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top,0px)) 12px 10px;background:rgba(10,16,24,.9)}",
      ".tt-viewer-title{flex:1;min-width:0;font-weight:600;font-size:.95rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}",
      ".tt-viewer-btn{border:1px solid rgba(255,255,255,.28);background:transparent;color:inherit;border-radius:999px;min-width:42px;height:42px;padding:0 16px;font:inherit;font-size:.95rem;cursor:pointer}",
      ".tt-viewer-btn:disabled{opacity:.55}",
      ".tt-viewer-close{font-size:1.5rem;line-height:1;padding:0}",
      ".tt-viewer-stage{position:relative;flex:1;overflow:hidden;touch-action:none}",
      ".tt-viewer-img{position:absolute;left:0;top:0;transform-origin:0 0;max-width:none;-webkit-user-drag:none;will-change:transform}",
      ".tt-viewer.tt-anim .tt-viewer-img{transition:transform .2s ease}",
      ".tt-viewer-note{position:absolute;left:0;right:0;bottom:calc(14px + env(safe-area-inset-bottom,0px));text-align:center;font-size:.8rem;color:rgba(232,237,242,.72);pointer-events:none}",
      ".tt-viewer-busy{position:absolute;top:50%;left:0;right:0;text-align:center;font-size:.95rem;color:rgba(232,237,242,.8)}",
      ".tt-enlargeable{cursor:zoom-in}",
      ".tt-hint{font-size:.78rem;opacity:.7;text-align:center;margin:0 0 6px}",
    ].join("");
    document.head.appendChild(style);
  }

  async function openTimetableViewer(rows, title) {
    if (tvOpen) return;
    tvOpen = true;
    tvInjectStyle();
    const root = document.documentElement;
    const overlay = document.createElement("div");
    overlay.className = "tt-viewer";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Timetable image");

    const bar = document.createElement("div");
    bar.className = "tt-viewer-bar";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tt-viewer-btn tt-viewer-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "\u00d7";
    const titleEl = document.createElement("div");
    titleEl.className = "tt-viewer-title";
    titleEl.textContent = title || "Timetable";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "tt-viewer-btn";
    saveBtn.textContent = "Save image";
    saveBtn.disabled = true;
    bar.append(closeBtn, titleEl, saveBtn);

    const stage = document.createElement("div");
    stage.className = "tt-viewer-stage";
    const img = document.createElement("img");
    img.className = "tt-viewer-img";
    img.alt = title || "Timetable";
    img.draggable = false;
    img.style.visibility = "hidden";
    const busy = document.createElement("div");
    busy.className = "tt-viewer-busy";
    busy.textContent = "Preparing image\u2026";
    const note = document.createElement("div");
    note.className = "tt-viewer-note";
    note.textContent = "Pinch or double-tap to zoom \u00b7 drag to move";
    stage.append(img, busy, note);
    overlay.append(bar, stage);
    document.body.appendChild(overlay);
    const prevOverflow = root.style.overflow;
    root.style.overflow = "hidden";

    let result = null;
    let objectUrl = null;
    let S = 1, X = 0, Y = 0, S0 = 1, MAXS = 4, imgW = 1, imgH = 1;
    const pointers = new Map();
    let pinch = null, pan = null, lastTap = null;

    function size() { const r = stage.getBoundingClientRect(); return { w: r.width, h: r.height, l: r.left, t: r.top }; }
    function clampPan() {
      const { w, h } = size();
      const cw = imgW * S, ch = imgH * S;
      X = cw <= w ? (w - cw) / 2 : Math.min(0, Math.max(w - cw, X));
      Y = ch <= h ? (h - ch) / 2 : Math.min(0, Math.max(h - ch, Y));
    }
    function apply() { img.style.transform = "translate(" + X + "px," + Y + "px) scale(" + S + ")"; }
    function animate() { overlay.classList.add("tt-anim"); setTimeout(() => overlay.classList.remove("tt-anim"), 230); }
    function fit(animated) {
      const { w, h } = size();
      S0 = Math.min(w / imgW, h / imgH);
      MAXS = Math.max(4, S0 * 6);
      if (animated) animate();
      S = S0; X = (w - imgW * S) / 2; Y = (h - imgH * S) / 2;
      apply();
    }
    function zoomAt(px, py, ns, animated) {
      ns = Math.min(MAXS, Math.max(S0, ns));
      const k = ns / S;
      if (animated) animate();
      X = px - (px - X) * k; Y = py - (py - Y) * k; S = ns;
      clampPan(); apply();
    }

    function close() {
      if (!tvOpen) return;
      tvOpen = false;
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.gtiHandleBack = prevBack;
      root.style.overflow = prevOverflow;
      overlay.remove();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
    const prevBack = window.gtiHandleBack;
    window.gtiHandleBack = () => { close(); return true; };
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "+" || e.key === "=") { const s = size(); zoomAt(s.w / 2, s.h / 2, S * 1.25, true); }
      else if (e.key === "-") { const s = size(); zoomAt(s.w / 2, s.h / 2, S / 1.25, true); }
    }
    function onResize() {
      if (!result) return;
      const wasFit = Math.abs(S - S0) < 0.01;
      const { w, h } = size();
      S0 = Math.min(w / imgW, h / imgH);
      MAXS = Math.max(4, S0 * 6);
      if (wasFit) fit(false); else { S = Math.max(S, S0); clampPan(); apply(); }
    }
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    closeBtn.addEventListener("click", close);

    saveBtn.addEventListener("click", async () => {
      if (!result) return;
      saveBtn.disabled = true;
      const label = saveBtn.textContent;
      saveBtn.textContent = "Saving\u2026";
      try { await saveFile(result.blob, tvSlug(title) + ".png"); }
      catch (err) { console.error("Image save failed:", err); saveBtn.textContent = "Could not save"; setTimeout(() => { saveBtn.textContent = label; saveBtn.disabled = false; }, 1800); return; }
      saveBtn.textContent = label;
      saveBtn.disabled = false;
    });

    // Gestures: one finger drags, two fingers pinch, double-tap zooms, wheel zooms.
    stage.addEventListener("pointerdown", (e) => {
      if (!result) return;
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const s = size();
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, S, X, Y, mx: (a.x + b.x) / 2 - s.l, my: (a.y + b.y) / 2 - s.t };
        pan = null;
      } else if (pointers.size === 1) {
        pan = { x: e.clientX, y: e.clientY, X, Y, moved: false };
      }
    });
    stage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const s = size();
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const ns = Math.min(MAXS, Math.max(S0 * 0.9, pinch.S * d / pinch.d));
        const k = ns / pinch.S;
        const cx = (a.x + b.x) / 2 - s.l, cy = (a.y + b.y) / 2 - s.t;
        X = cx - (pinch.mx - pinch.X) * k;
        Y = cy - (pinch.my - pinch.Y) * k;
        S = ns;
        clampPan(); apply();
      } else if (pan && pointers.size === 1) {
        const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) pan.moved = true;
        X = pan.X + dx; Y = pan.Y + dy;
        clampPan(); apply();
      }
    });
    function release(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      const s = size();
      if (pinch && pointers.size < 2) {
        pinch = null;
        if (S < S0) { fit(true); }
        if (pointers.size === 1) { const p = [...pointers.values()][0]; pan = { x: p.x, y: p.y, X, Y, moved: true }; }
        return;
      }
      if (pointers.size === 0 && pan) {
        if (!pan.moved && e.type === "pointerup") {
          const now = Date.now();
          if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
            if (S > S0 * 1.05) fit(true); else zoomAt(e.clientX - s.l, e.clientY - s.t, S0 * 2.6, true);
            lastTap = null;
          } else {
            lastTap = { t: now, x: e.clientX, y: e.clientY };
          }
        }
        pan = null;
      }
    }
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointercancel", release);
    stage.addEventListener("wheel", (e) => {
      if (!result) return;
      e.preventDefault();
      const s = size();
      zoomAt(e.clientX - s.l, e.clientY - s.t, S * Math.exp(-e.deltaY * 0.0015), false);
    }, { passive: false });

    try {
      result = await buildTimetableImage(rows, title);
      if (!tvOpen) return;
      objectUrl = URL.createObjectURL(result.blob);
      imgW = result.width; imgH = result.height;
      img.style.width = imgW + "px";
      img.style.height = imgH + "px";
      await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = objectUrl; });
      if (!tvOpen) return;
      busy.remove();
      img.style.visibility = "visible";
      fit(false);
      saveBtn.disabled = false;
    } catch (err) {
      console.error("Timetable image failed:", err);
      busy.textContent = "Could not create the image.";
    }
  }

  // Tap the timetable to open it in the viewer.
  function enableTimetableEnlarge(wrap, rows, title) {
    wrap.classList.add("tt-enlargeable");
    wrap.setAttribute("role", "button");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-label", "Open the timetable full screen");
    const open = () => openTimetableViewer(rows, title);
    wrap.addEventListener("click", open);
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  }
  /* </viewer-kit> */

  async function exportTimetablePdf(rows, title) {
    await loadPdfLibs();
    const norm = normalizeRows(rows);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: norm[0].length > 6 ? "landscape" : "portrait" });
    doc.setFontSize(14);
    doc.text(title || "Timetable", 14, 16);
    doc.autoTable({
      head: [norm[0]],
      body: norm.slice(1),
      startY: 22,
      styles: { fontSize: 9, halign: "center", valign: "middle" },
      headStyles: { fillColor: [11, 57, 114], halign: "center" },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const row = norm[data.row.index + 1];
        if (row && isCompactRow(row)) {
          data.cell.styles.fillColor = [225, 225, 225];
          data.cell.styles.fontStyle = "bolditalic";
        }
      },
    });
    await saveFile(doc.output("blob"), `${slug(title)}.pdf`);
  }

  async function exportTimetableImage(rows, title) {
    const norm = normalizeRows(rows);
    const result = await buildTimetableImage(norm, title);
    await saveFile(result.blob, `${slug(title)}.png`);
  }

  async function exportTimetableDocx(rows, title) {
    await loadDocxLib();
    const norm = normalizeRows(rows);
    const { Document, Packer, Table, TableRow, TableCell, Paragraph, TextRun, HeadingLevel, WidthType, AlignmentType } = window.docx;

    function cellParagraphs(text, bold) {
      const lines = (text || "").split("\n");
      return lines.map((line) => new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: line, bold: !!bold })],
      }));
    }

    const colWidth = Math.floor(100 / (norm[0].length || 1));
    const tableRows = norm.map((row, rIdx) => {
      const header = rIdx === 0;
      const compact = !header && isCompactRow(row);
      return new TableRow({
        tableHeader: header,
        children: row.map((cell) => new TableCell({
          width: { size: colWidth, type: WidthType.PERCENTAGE },
          shading: compact ? { fill: "E5E5E5" } : (header ? { fill: "DCE6F5" } : undefined),
          children: cellParagraphs(cell, header || compact),
        })),
      });
    });

    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: title || "Timetable", heading: HeadingLevel.HEADING_1 }),
          new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }),
        ],
      }],
    });

    const blob = await Packer.toBlob(doc);
    await saveFile(blob, `${slug(title)}.docx`);
  }

  /* ---------------- open in a new tab ---------------- */
  // Lower-level opener: creates the tab synchronously (so it isn't
  // blocked as a pop-up — browsers only allow window.open() as a direct
  // response to a click, not after an awaited operation like OCR) and
  // returns a handle to feed it data once it's ready and/or as progress
  // comes in, plus a way to register what happens when it saves.
  function openTimetablePopupWindow(mode) {
    const win = window.open(`timetable-popup.html?mode=${mode === "edit" ? "edit" : "view"}`, "_blank");
    if (!win) {
      window.alert("Your browser blocked the pop-up. Please allow pop-ups for this site and try again.");
      return null;
    }

    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    let saveCallback = null;

    function handleMessage(e) {
      if (e.origin !== window.location.origin || e.source !== win) return;
      if (e.data && e.data.type === "tt-popup-ready") {
        readyResolve();
      } else if (e.data && e.data.type === "tt-popup-save" && saveCallback) {
        saveCallback(e.data.rows);
      }
    }
    window.addEventListener("message", handleMessage);

    const poll = setInterval(() => {
      if (win.closed) {
        clearInterval(poll);
        window.removeEventListener("message", handleMessage);
      }
    }, 1000);

    return {
      win,
      onSave(cb) { saveCallback = cb; },
      // rows may be null with a loading/progress hint while OCR is
      // still running; the popup shows a status line until real rows
      // arrive.
      send(rows, title, extra) {
        ready.then(() => {
          win.postMessage(Object.assign({ type: "tt-popup-init", rows, title }, extra || {}), window.location.origin);
        });
      },
    };
  }

  // Convenience wrapper for the common case: data is already available
  // (a manual "Open in new tab" click, or a read-only view) so there's
  // no loading phase to stream.
  function openTimetablePopup(rows, title, mode, onSave) {
    const handle = openTimetablePopupWindow(mode);
    if (!handle) return null;
    if (onSave) handle.onSave(onSave);
    handle.send(rows, title);
    return handle.win;
  }

  return {
    loadOcrLibs,
    loadExportLibs,
    ocrExtractTable,
    renderTimetableEditor,
    renderTimetableView,
    exportTimetablePdf,
    exportTimetableDocx,
    exportTimetableImage,
    openTimetableViewer,
    openTimetablePopup,
    openTimetablePopupWindow,
    normalizeRows,
    // Exposed for automated testing only — not used by the pages.
    internals: {
      adaptiveDark, frameRegion, estimateSkewDeg, rotateGray, findGrid, cellInk,
      prepareCellImage, cropGray, voteReadings, cleanOcrText, normalizeTimeRange, snapWeekday,
      canCorrectLine, consensusFix, repairBreakRows, repairTimeChain, flagTwinMismatches, readGrid, extractFromGray, wordsToTable, levenshtein,
    },
  };
})();