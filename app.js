/* ============================================================
   img2llm — images <-> JSON payload, entirely client-side.
   ============================================================ */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  /* A base64 blob tokenises at roughly 3.5 characters per token on the
     common BPE vocabularies; good enough for a budget readout. */
  var CHARS_PER_TOKEN = 3.5;
  var CONTEXT_WINDOW = 200000;
  var PREVIEW_LIMIT = 400000;   // chars shown in the textarea before truncating
  var RASTER = ['image/png', 'image/jpeg', 'image/webp'];

  var state = {
    mode: 'encode',
    items: [],
    pretty: true,
    maxDim: 1024,
    format: 'original',
    quality: 82,
    json: '',
    decoded: []
  };

  /* ---------------------------------------------------------- utilities */

  function uid() { return Math.random().toString(36).slice(2, 10); }

  function stripExt(name) { return name.replace(/\.[^.\s]+$/, ''); }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function count(n) {
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(2) + 'M';
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function setStatus(msg, kind) {
    var el = $('#status');
    el.textContent = msg;
    el.className = 'status-msg' + (kind ? ' is-' + kind : '');
  }

  function dataUrlBytes(url) {
    var i = url.indexOf(',');
    if (i < 0) return 0;
    var b64 = url.slice(i + 1);
    var pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
  }

  function dataUrlMime(url) {
    var m = /^data:([^;,]+)/.exec(url);
    return m ? m[1] : '';
  }

  function dataUrlToBytes(url) {
    var bin = atob(url.slice(url.indexOf(',') + 1));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function extFor(mime) {
    return ({
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
      'image/avif': 'avif', 'image/x-icon': 'ico'
    })[mime] || 'bin';
  }

  function readAsDataURL(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error('could not read file')); };
      r.readAsDataURL(file);
    });
  }

  function readAsText(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error('could not read file')); };
      r.readAsText(file);
    });
  }

  function loadImage(src) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { rej(new Error('decode failed')); };
      img.src = src;
    });
  }

  /* ------------------------------------------------------- preferences */

  function loadPrefs() {
    try {
      var raw = localStorage.getItem('img2llm.prefs');
      if (!raw) return;
      var p = JSON.parse(raw);
      if (typeof p.maxDim === 'number') state.maxDim = p.maxDim;
      if (typeof p.format === 'string') state.format = p.format;
      if (typeof p.quality === 'number') state.quality = p.quality;
      if (typeof p.pretty === 'boolean') state.pretty = p.pretty;
    } catch (e) { /* private mode, blocked storage — defaults are fine */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem('img2llm.prefs', JSON.stringify({
        maxDim: state.maxDim, format: state.format,
        quality: state.quality, pretty: state.pretty
      }));
    } catch (e) { /* nothing to recover — prefs are a convenience */ }
  }

  /* =========================================================== SPLIT   */
  /* One composite "sheet" is analysed at reduced resolution, but every
     crop box is held in normalised 0..1 coordinates — so the overlay, the
     piece list and the full-resolution crops all agree with no scale
     factor to keep in step. */

  var ANALYSIS_MAX = 1000;   // long side of the analysis raster
  var GUTTER_INK = 0.02;     // a scan line under 2% ink counts as empty
  var SLIVER = 6;            // long:short beyond this reads as a caption bar

  var HINTS = {
    gutters: 'Cuts the sheet on bands of flat background, over and over — panels of unequal size are fine. Raise Min gutter if it cuts inside a picture.',
    blobs: 'Crops the bounding box of each island of non-background pixels. Tightest crops; best for photos scanned together on a flatbed.',
    grid: 'Slices into equal rows and columns. Nothing is measured, so it is exact whenever the sheet really is a regular grid.',
    manual: 'Drag on the sheet to draw each piece by hand.'
  };

  var sheet = {
    name: '', mime: 'image/png', src: '', img: null,
    w: 0, h: 0, aw: 0, ah: 0, ascale: 1, data: null,
    bg: [0, 0, 0], boxes: [], sel: null, picking: false
  };

  var sopt = {
    mode: 'gutters', tol: 12, minGutter: 3, minArea: 10,
    rows: 2, cols: 2, pad: 0, mergeThin: true
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function rgb2hex(c) {
    return '#' + [c[0], c[1], c[2]].map(function (v) {
      return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    }).join('');
  }

  function hex2rgb(s) {
    var m = /^#?([0-9a-f]{6})$/i.exec(s || '');
    if (!m) return [0, 0, 0];
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* ------------------------------------------------------ sheet intake */

  function loadSheet(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name)) {
      setStatus('That is not an image file.', 'bad');
      return;
    }
    setStatus('Reading ' + file.name + '…');
    readAsDataURL(file).then(function (src) {
      return loadImage(src).then(function (img) {
        sheet.name = file.name;
        sheet.mime = file.type || dataUrlMime(src) || 'image/png';
        if (RASTER.indexOf(sheet.mime) < 0) sheet.mime = 'image/png';
        sheet.src = src;
        sheet.img = img;
        sheet.w = img.naturalWidth || 0;
        sheet.h = img.naturalHeight || 0;
        if (!sheet.w || !sheet.h) throw new Error('no dimensions');

        $('#sheetImg').src = src;
        $('#stageWrap').hidden = false;
        $('#spSheet').textContent = sheet.w + '×' + sheet.h;

        analyseSheet();
        sheet.bg = autoBackground();
        $('#bgColor').value = rgb2hex(sheet.bg);
        syncFields();
        detect();
      });
    }).then(null, function () {
      setStatus('Could not read that image.', 'bad');
    });
  }

  function analyseSheet() {
    var s = Math.min(1, ANALYSIS_MAX / Math.max(sheet.w, sheet.h));
    var aw = Math.max(1, Math.round(sheet.w * s));
    var ah = Math.max(1, Math.round(sheet.h * s));
    var c = document.createElement('canvas');
    c.width = aw; c.height = ah;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(sheet.img, 0, 0, aw, ah);
    sheet.aw = aw; sheet.ah = ah; sheet.ascale = aw / sheet.w;
    sheet.data = x.getImageData(0, 0, aw, ah).data;
  }

  /* The most common colour around the rim of the sheet, refined to the
     true average of the pixels that landed in the winning 5-bit bucket. */
  function autoBackground() {
    var d = sheet.data, aw = sheet.aw, ah = sheet.ah;
    var hist = {}, best = -1, bestN = 0, x, y;

    function key(p) { return ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3); }
    function rim(fn) {
      for (x = 0; x < aw; x++) { fn(x * 4); fn(((ah - 1) * aw + x) * 4); }
      for (y = 0; y < ah; y++) { fn(y * aw * 4); fn((y * aw + aw - 1) * 4); }
    }

    rim(function (p) {
      var k = key(p), n = hist[k] = (hist[k] || 0) + 1;
      if (n > bestN) { bestN = n; best = k; }
    });
    if (best < 0) return [255, 255, 255];

    var sr = 0, sg = 0, sb = 0, n2 = 0;
    rim(function (p) {
      if (key(p) !== best) return;
      sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; n2++;
    });
    return n2 ? [sr / n2, sg / n2, sb / n2] : [255, 255, 255];
  }

  /* 1 where the pixel differs from the background beyond the tolerance */
  function inkMask() {
    var d = sheet.data, n = sheet.aw * sheet.ah, m = new Uint8Array(n);
    var br = sheet.bg[0], bgg = sheet.bg[1], bb = sheet.bg[2];
    var t = sopt.tol * 2.55;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      if (d[p + 3] < 16) continue;              /* transparent reads as background */
      var a = d[p] - br; if (a < 0) a = -a;
      var b = d[p + 1] - bgg; if (b < 0) b = -b;
      var c = d[p + 2] - bb; if (c < 0) c = -c;
      if (b > a) a = b;
      if (c > a) a = c;
      if (a > t) m[i] = 1;
    }
    return m;
  }

  /* --------------------------------------------------- gutters: XY-cut */

  /* Ink per row and per column inside a rect, in one cache-friendly pass. */
  function profiles(mask, r) {
    var aw = sheet.aw, w = r[2] - r[0], h = r[3] - r[1];
    var rows = new Int32Array(h), cols = new Int32Array(w), i, j;
    for (j = 0; j < h; j++) {
      var base = (r[1] + j) * aw + r[0], c = 0;
      for (i = 0; i < w; i++) if (mask[base + i]) { c++; cols[i]++; }
      rows[j] = c;
    }
    return { rows: rows, cols: cols };
  }

  /* The longest interior run of near-empty lines. Runs touching either end
     are outer margin, not a gutter, so they never become a cut. */
  function bestGap(prof, span, minRun) {
    var lim = Math.floor(span * GUTTER_INK), best = null, i = 0, n = prof.length;
    while (i < n) {
      if (prof[i] > lim) { i++; continue; }
      var s = i;
      while (i < n && prof[i] <= lim) i++;
      if (s > 0 && i < n && (i - s) >= minRun && (!best || (i - s) > best.len)) {
        best = { at: (s + i) >> 1, len: i - s };
      }
    }
    return best;
  }

  function xyCut(mask, r, out, depth) {
    var w = r[2] - r[0], h = r[3] - r[1];
    var minRun = Math.max(2, Math.round(sopt.minGutter * sheet.ascale));
    var minPx = (sopt.minArea / 1000) * sheet.aw * sheet.ah;
    /* A cut leaves the perpendicular dimension untouched, so a band already
       thinner than a plausible piece must not be diced any further — this
       is what stops a caption bar breaking apart at its word gaps. */
    var minSide = Math.max(minRun * 2, Math.round(0.5 * Math.sqrt(minPx)));

    if (depth > 8 || w < minRun * 2 || h < minRun * 2) { out.push(r); return; }

    var p = profiles(mask, r);
    var g = w >= minSide ? bestGap(p.rows, w, minRun) : null;   /* cut across */
    var v = h >= minSide ? bestGap(p.cols, h, minRun) : null;   /* cut down   */

    var use, axis;
    if (g && v) { if (g.len >= v.len) { use = g; axis = 'y'; } else { use = v; axis = 'x'; } }
    else if (g) { use = g; axis = 'y'; }
    else if (v) { use = v; axis = 'x'; }
    else { out.push(r); return; }

    if (axis === 'y') {
      var cy = r[1] + use.at;
      xyCut(mask, [r[0], r[1], r[2], cy], out, depth + 1);
      xyCut(mask, [r[0], cy, r[2], r[3]], out, depth + 1);
    } else {
      var cx = r[0] + use.at;
      xyCut(mask, [r[0], r[1], cx, r[3]], out, depth + 1);
      xyCut(mask, [cx, r[1], r[2], r[3]], out, depth + 1);
    }
  }

  /* Shrink a rect off its empty margin; null when there is nothing in it. */
  function trimRect(mask, r) {
    var p = profiles(mask, r), w = r[2] - r[0], h = r[3] - r[1];
    var limR = Math.floor(w * GUTTER_INK), limC = Math.floor(h * GUTTER_INK);
    var t = 0, b = h - 1, l = 0, e = w - 1;
    while (t <= b && p.rows[t] <= limR) t++;
    while (b >= t && p.rows[b] <= limR) b--;
    while (l <= e && p.cols[l] <= limC) l++;
    while (e >= l && p.cols[e] <= limC) e--;
    if (t > b || l > e) return null;
    return [r[0] + l, r[1] + t, r[0] + e + 1, r[1] + b + 1];
  }

  function span(a0, a1, b0, b1) {
    var lo = a0 > b0 ? a0 : b0, hi = a1 < b1 ? a1 : b1;
    return hi > lo ? hi - lo : 0;
  }

  /* Fold undersized pieces, and caption-shaped slivers, into the piece they
     belong to. A sliver only merges when a single neighbour covers most of
     its long edge — a caption shared by two panels stays a piece of its own
     rather than being annexed by an arbitrary one of them. */
  function mergeSmall(rects) {
    var minPx = (sopt.minArea / 1000) * sheet.aw * sheet.ah;
    var list = rects.slice(), guard = 0;

    while (list.length > 1 && guard++ < 400) {
      var idx = -1, i, a, w, h;
      for (i = 0; i < list.length; i++) {
        a = list[i];
        if (a.keep) continue;
        w = a[2] - a[0]; h = a[3] - a[1];
        if (w * h < minPx || (sopt.mergeThin && (w / h > SLIVER || h / w > SLIVER))) { idx = i; break; }
      }
      if (idx < 0) break;

      a = list[idx];
      w = a[2] - a[0]; h = a[3] - a[1];
      var wide = w >= h, best = -1, bestScore = 0;
      for (i = 0; i < list.length; i++) {
        if (i === idx) continue;
        var b = list[i];
        var cover = wide ? span(a[0], a[2], b[0], b[2]) / w : span(a[1], a[3], b[1], b[3]) / h;
        if (cover < 0.6) continue;
        var gap = wide
          ? Math.max(0, a[1] - b[3], b[1] - a[3])
          : Math.max(0, a[0] - b[2], b[0] - a[2]);
        var score = cover / (1 + gap);
        if (score > bestScore) { bestScore = score; best = i; }
      }

      if (best < 0) {
        if (w * h < minPx) list.splice(idx, 1); else a.keep = true;
        continue;
      }
      var t = list[best];
      list[best] = [Math.min(a[0], t[0]), Math.min(a[1], t[1]), Math.max(a[2], t[2]), Math.max(a[3], t[3])];
      list.splice(idx, 1);
    }
    list.forEach(function (r) { delete r.keep; });
    return list;
  }

  /* Reading order: band the rects into rows, then left to right in each. */
  function sortReading(rects) {
    var sorted = rects.slice().sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
    var out = [], row = [], bottom = 0;
    function flush() {
      row.sort(function (a, b) { return a[0] - b[0]; });
      out = out.concat(row);
      row = [];
    }
    sorted.forEach(function (r) {
      if (row.length && r[1] >= bottom) flush();
      bottom = row.length ? Math.min(bottom, r[3]) : r[3];
      row.push(r);
    });
    flush();
    return out;
  }

  function cutRects(mask) {
    var leaves = [], trimmed = [];
    xyCut(mask, [0, 0, sheet.aw, sheet.ah], leaves, 0);
    leaves.forEach(function (r) {
      var t = trimRect(mask, r);
      if (t) trimmed.push(t);
    });
    return sortReading(mergeSmall(trimmed));
  }

  /* ----------------------------------------------------- blobs: labels */

  /* Separable box dilation — joins the letters of a caption into one strip
     and bridges the flat-coloured seams inside a photograph. */
  function dilate(mask, r) {
    if (r < 1) return mask;
    var aw = sheet.aw, ah = sheet.ah, n = aw * ah;
    var tmp = new Uint8Array(n), out = new Uint8Array(n), x, y, k, i;
    for (y = 0; y < ah; y++) {
      for (x = 0; x < aw; x++) {
        for (k = -r; k <= r; k++) {
          i = x + k;
          if (i >= 0 && i < aw && mask[y * aw + i]) { tmp[y * aw + x] = 1; break; }
        }
      }
    }
    for (y = 0; y < ah; y++) {
      for (x = 0; x < aw; x++) {
        for (k = -r; k <= r; k++) {
          i = y + k;
          if (i >= 0 && i < ah && tmp[i * aw + x]) { out[y * aw + x] = 1; break; }
        }
      }
    }
    return out;
  }

  function fuseOverlaps(rects) {
    var list = rects.slice(), guard = 0, changed = true;
    while (changed && guard++ < rects.length + 5) {
      changed = false;
      for (var i = 0; i < list.length && !changed; i++) {
        for (var j = i + 1; j < list.length; j++) {
          var a = list[i], b = list[j];
          if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) {
            list[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            list.splice(j, 1);
            changed = true;
            break;
          }
        }
      }
    }
    return list;
  }

  function blobRects(mask) {
    var aw = sheet.aw, ah = sheet.ah, n = aw * ah;
    var r = Math.max(1, Math.round(sopt.minGutter * sheet.ascale / 2));
    var m = dilate(mask, r);
    var seen = new Uint8Array(n), stack = new Int32Array(n), rects = [];
    var minPx = (sopt.minArea / 1000) * n;

    for (var s = 0; s < n; s++) {
      if (!m[s] || seen[s]) continue;
      var sp = 0;
      stack[sp++] = s; seen[s] = 1;
      var x0 = s % aw, x1 = x0, y0 = (s / aw) | 0, y1 = y0;
      while (sp) {
        var p = stack[--sp], px = p % aw, py = (p / aw) | 0;
        if (px < x0) x0 = px; else if (px > x1) x1 = px;
        if (py > y1) y1 = py;
        if (px > 0 && m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (px < aw - 1 && m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (py > 0 && m[p - aw] && !seen[p - aw]) { seen[p - aw] = 1; stack[sp++] = p - aw; }
        if (py < ah - 1 && m[p + aw] && !seen[p + aw]) { seen[p + aw] = 1; stack[sp++] = p + aw; }
      }
      rects.push([x0, y0, x1 + 1, y1 + 1]);
    }

    /* undo the dilation, fuse what still overlaps, then drop the specks */
    rects = rects.map(function (b) {
      return [clamp(b[0] + r, 0, aw), clamp(b[1] + r, 0, ah), clamp(b[2] - r, 0, aw), clamp(b[3] - r, 0, ah)];
    }).filter(function (b) { return b[2] > b[0] && b[3] > b[1]; });

    rects = fuseOverlaps(rects).filter(function (b) {
      return (b[2] - b[0]) * (b[3] - b[1]) >= minPx;
    });
    return sortReading(mergeSmall(rects));
  }

  function gridRects() {
    var rows = clamp(sopt.rows | 0, 1, 24), cols = clamp(sopt.cols | 0, 1, 24), out = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        out.push([
          Math.round(c * sheet.aw / cols), Math.round(r * sheet.ah / rows),
          Math.round((c + 1) * sheet.aw / cols), Math.round((r + 1) * sheet.ah / rows)
        ]);
      }
    }
    return out;
  }

  /* analysis-space rect -> padded, normalised box */
  function toBox(r) {
    var p = sopt.pad * sheet.ascale;
    var x0 = clamp(r[0] - p, 0, sheet.aw), y0 = clamp(r[1] - p, 0, sheet.ah);
    var x1 = clamp(r[2] + p, 0, sheet.aw), y1 = clamp(r[3] + p, 0, sheet.ah);
    if (x1 <= x0) x1 = Math.min(sheet.aw, x0 + 1);
    if (y1 <= y0) y1 = Math.min(sheet.ah, y0 + 1);
    return {
      id: uid(),
      x: x0 / sheet.aw, y: y0 / sheet.ah,
      w: (x1 - x0) / sheet.aw, h: (y1 - y0) / sheet.ah
    };
  }

  function detect() {
    if (!sheet.img) return;
    if (sopt.mode === 'manual') { renderBoxes(); renderPieces(); return; }

    var t0 = Date.now(), rects;
    if (sopt.mode === 'grid') rects = gridRects();
    else {
      var mask = inkMask();
      rects = sopt.mode === 'blobs' ? blobRects(mask) : cutRects(mask);
    }

    sheet.boxes = rects.map(toBox);
    sheet.sel = null;
    renderBoxes();
    renderPieces();

    var n = sheet.boxes.length;
    setStatus(n
      ? n + ' piece' + (n === 1 ? '' : 's') + ' found in ' + (Date.now() - t0) + ' ms — adjust the boxes if you like'
      : 'Nothing found — try another mode, or loosen the tolerance', n ? 'good' : 'bad');
  }

  /* ------------------------------------------------------------ pieces */

  function cropCanvas(b, maxSide) {
    var sx = clamp(Math.round(b.x * sheet.w), 0, sheet.w - 1);
    var sy = clamp(Math.round(b.y * sheet.h), 0, sheet.h - 1);
    var sw = clamp(Math.round(b.w * sheet.w), 1, sheet.w - sx);
    var sh = clamp(Math.round(b.h * sheet.h), 1, sheet.h - sy);
    var dw = sw, dh = sh;
    if (maxSide) {
      var s = Math.min(1, maxSide / Math.max(sw, sh));
      dw = Math.max(1, Math.round(sw * s));
      dh = Math.max(1, Math.round(sh * s));
    }
    var c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    var x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(sheet.img, sx, sy, sw, sh, 0, 0, dw, dh);
    return { canvas: c, w: sw, h: sh };
  }

  function piece(b, maxSide) {
    var c = cropCanvas(b, maxSide);
    return {
      url: sheet.mime === 'image/png'
        ? c.canvas.toDataURL('image/png')
        : c.canvas.toDataURL(sheet.mime, 0.92),
      w: c.w, h: c.h
    };
  }

  function pieceName(i) {
    return safeName(stripExt(sheet.name), 'sheet') + '-' +
      String(i + 1).padStart(2, '0') + '.' + extFor(sheet.mime);
  }

  function boxById(id) {
    return sheet.boxes.filter(function (b) { return b.id === id; })[0];
  }

  function renderBoxes() {
    $('#boxes').innerHTML = sheet.boxes.map(function (b, i) {
      return '<div class="box' + (b.id === sheet.sel ? ' is-on' : '') + '" data-box="' + b.id + '" style="' +
          'left:' + (b.x * 100).toFixed(4) + '%;top:' + (b.y * 100).toFixed(4) + '%;' +
          'width:' + (b.w * 100).toFixed(4) + '%;height:' + (b.h * 100).toFixed(4) + '%">' +
        '<span class="box-n">' + (i + 1) + '</span>' +
        '<i class="hnd hnd-nw" data-h="nw"></i><i class="hnd hnd-ne" data-h="ne"></i>' +
        '<i class="hnd hnd-sw" data-h="sw"></i><i class="hnd hnd-se" data-h="se"></i>' +
      '</div>';
    }).join('');

    var n = sheet.boxes.length;
    $('#spCount').textContent = String(n);
    $('#pieceBadge').textContent = String(n);
    $('#splitZip').disabled = !n;
    $('#toEncoder').disabled = !n;
    $('#clearBoxes').disabled = !n;
  }

  function renderPieces() {
    var list = $('#pieceList');
    if (!sheet.boxes.length) { list.innerHTML = ''; return; }
    list.innerHTML = sheet.boxes.map(function (b, i) {
      var p = piece(b, 96);
      return '<li class="item' + (b.id === sheet.sel ? ' is-sel' : '') + '" data-piece="' + b.id + '">' +
        '<img class="item-thumb" src="' + p.url + '" alt="" data-zoomp="' + b.id + '">' +
        '<div class="item-head"><span class="item-name">' + esc(pieceName(i)) + '</span></div>' +
        '<div class="item-tools">' +
          '<button type="button" class="btn-icon" data-pact="save" data-id="' + b.id + '" title="Save this piece">&#8595;</button>' +
          '<button type="button" class="btn-icon" data-pact="del" data-id="' + b.id + '" title="Remove">&#215;</button>' +
        '</div>' +
        '<div class="item-pc">' + p.w + '×' + p.h + ' px</div>' +
      '</li>';
    }).join('');
  }

  function sendToEncoder() {
    if (!sheet.boxes.length) return;
    setStatus('Cropping ' + sheet.boxes.length + ' pieces…');

    /* the first real image replaces the seeded samples, as a drop does */
    if (state.items.length && state.items.every(function (i) { return i.sample; })) state.items = [];

    var n = sheet.boxes.length;
    sheet.boxes.forEach(function (b, i) {
      var p = piece(b, 0), name = pieceName(i);
      state.items.push({
        id: uid(), name: name, descr: stripExt(name), sample: false,
        src: p.url, mime: dataUrlMime(p.url) || sheet.mime, origBytes: dataUrlBytes(p.url),
        origW: p.w, origH: p.h, status: 'ok', note: ''
      });
    });

    setMode('encode');
    reprocessAll().then(function () {
      setStatus(n + ' piece' + (n === 1 ? '' : 's') + ' added to the encoder', 'good');
    });
  }

  /* ------------------------------------------------------- stage input */

  function stageMetrics() {
    var r = $('#sheetImg').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width || 1, h: r.height || 1 };
  }

  function setPicking(on) {
    sheet.picking = on;
    $('#stage').classList.toggle('is-picking', on);
    $('#bgPick').classList.toggle('is-on', on);
  }

  function pickAt(e) {
    var m = stageMetrics();
    var ax = Math.floor(clamp((e.clientX - m.left) / m.w, 0, 0.999) * sheet.aw);
    var ay = Math.floor(clamp((e.clientY - m.top) / m.h, 0, 0.999) * sheet.ah);
    var p = (ay * sheet.aw + ax) * 4;
    sheet.bg = [sheet.data[p], sheet.data[p + 1], sheet.data[p + 2]];
    $('#bgColor').value = rgb2hex(sheet.bg);
    setPicking(false);
    detect();
  }

  function bindStage() {
    var host = $('#boxes'), drag = null;

    host.addEventListener('pointerdown', function (e) {
      if (!sheet.img) return;
      e.preventDefault();
      if (sheet.picking) { pickAt(e); return; }

      var m = stageMetrics();
      var nx = clamp((e.clientX - m.left) / m.w, 0, 1);
      var ny = clamp((e.clientY - m.top) / m.h, 0, 1);
      var boxEl = e.target.closest('.box'), hnd = e.target.closest('.hnd');
      host.setPointerCapture(e.pointerId);

      if (boxEl) {
        var b = boxById(boxEl.getAttribute('data-box'));
        sheet.sel = b.id;
        drag = hnd
          ? { kind: 'size', b: b, h: hnd.getAttribute('data-h'), s: { x: b.x, y: b.y, w: b.w, h: b.h } }
          : { kind: 'move', b: b, ox: nx - b.x, oy: ny - b.y };
      } else {
        var nb = { id: uid(), x: nx, y: ny, w: 0, h: 0 };
        sheet.boxes.push(nb);
        sheet.sel = nb.id;
        drag = { kind: 'draw', b: nb, ax: nx, ay: ny };
      }
      renderBoxes();
    });

    host.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var m = stageMetrics();
      var nx = clamp((e.clientX - m.left) / m.w, 0, 1);
      var ny = clamp((e.clientY - m.top) / m.h, 0, 1);
      var b = drag.b;

      if (drag.kind === 'move') {
        b.x = clamp(nx - drag.ox, 0, 1 - b.w);
        b.y = clamp(ny - drag.oy, 0, 1 - b.h);
      } else if (drag.kind === 'draw') {
        b.x = Math.min(drag.ax, nx); b.w = Math.abs(nx - drag.ax);
        b.y = Math.min(drag.ay, ny); b.h = Math.abs(ny - drag.ay);
      } else {
        var s = drag.s, west = drag.h.charAt(1) === 'w', north = drag.h.charAt(0) === 'n';
        var x0 = west ? nx : s.x, x1 = west ? s.x + s.w : nx;
        var y0 = north ? ny : s.y, y1 = north ? s.y + s.h : ny;
        b.x = Math.min(x0, x1); b.w = Math.abs(x1 - x0);
        b.y = Math.min(y0, y1); b.h = Math.abs(y1 - y0);
      }
      renderBoxes();
    });

    function endDrag() {
      if (!drag) return;
      var b = drag.b;
      /* a stray click, or a box dragged down to nothing, is not a piece */
      if (b.w * sheet.w < 8 || b.h * sheet.h < 8) {
        sheet.boxes = sheet.boxes.filter(function (x) { return x !== b; });
        if (sheet.sel === b.id) sheet.sel = null;
      }
      drag = null;
      renderBoxes();
      renderPieces();
    }
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);
  }

  function syncFields() {
    var auto = sopt.mode === 'gutters' || sopt.mode === 'blobs';
    Array.prototype.forEach.call(document.querySelectorAll('#pane-split [data-for]'), function (el) {
      el.hidden = el.getAttribute('data-for') === 'auto' ? !auto : sopt.mode !== 'grid';
    });
    $('#reDetect').disabled = !sheet.img || sopt.mode === 'manual';
    $('#addBox').disabled = !sheet.img;
    $('#detectHint').textContent = HINTS[sopt.mode];
  }

  function bindSplit() {
    var dz = $('#sheetDrop'), fi = $('#sheetInput');
    dz.addEventListener('click', function () { fi.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
    });
    fi.addEventListener('change', function () { loadSheet(fi.files[0]); fi.value = ''; });

    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('is-over'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) loadSheet(e.dataTransfer.files[0]);
    });

    var redetect = debounce(detect, 140);
    $('#detectMode').addEventListener('change', function () {
      sopt.mode = this.value;
      syncFields();
      detect();
    });
    $('#tol').addEventListener('input', function () {
      sopt.tol = +this.value; $('#tolVal').textContent = this.value; redetect();
    });
    $('#minGutter').addEventListener('input', function () {
      sopt.minGutter = +this.value; $('#gutVal').textContent = this.value + ' px'; redetect();
    });
    $('#minArea').addEventListener('input', function () {
      sopt.minArea = +this.value;
      $('#minVal').textContent = (this.value / 10).toFixed(1) + '%';
      redetect();
    });
    $('#pad').addEventListener('input', function () {
      sopt.pad = +this.value; $('#padVal').textContent = this.value + ' px'; redetect();
    });
    $('#gridRows').addEventListener('input', function () { sopt.rows = +this.value; redetect(); });
    $('#gridCols').addEventListener('input', function () { sopt.cols = +this.value; redetect(); });
    $('#mergeThin').addEventListener('change', function () { sopt.mergeThin = this.checked; detect(); });
    $('#bgColor').addEventListener('input', function () { sheet.bg = hex2rgb(this.value); redetect(); });
    $('#bgPick').addEventListener('click', function () { setPicking(!sheet.picking); });
    $('#reDetect').addEventListener('click', detect);

    $('#addBox').addEventListener('click', function () {
      if (!sheet.img) return;
      var b = { id: uid(), x: 0.3, y: 0.3, w: 0.25, h: 0.25 };
      sheet.boxes.push(b);
      sheet.sel = b.id;
      renderBoxes();
      renderPieces();
    });
    $('#clearBoxes').addEventListener('click', function () {
      sheet.boxes = []; sheet.sel = null;
      renderBoxes(); renderPieces();
      setStatus('Boxes cleared — draw your own on the sheet');
    });

    $('#pieceList').addEventListener('click', function (e) {
      var zoom = e.target.closest('[data-zoomp]');
      if (zoom) {
        var zb = boxById(zoom.getAttribute('data-zoomp'));
        if (zb) {
          var zi = sheet.boxes.indexOf(zb), zp = piece(zb, 1400);
          openLightbox(zp.url, pieceName(zi) + ' · ' + zp.w + '×' + zp.h);
        }
        return;
      }
      var btn = e.target.closest('[data-pact]');
      if (!btn) {
        var li = e.target.closest('[data-piece]');
        if (li) { sheet.sel = li.getAttribute('data-piece'); renderBoxes(); renderPieces(); }
        return;
      }
      var b = boxById(btn.getAttribute('data-id')), idx = sheet.boxes.indexOf(b);
      if (idx < 0) return;
      if (btn.getAttribute('data-pact') === 'del') {
        sheet.boxes.splice(idx, 1);
        if (sheet.sel === b.id) sheet.sel = null;
        renderBoxes(); renderPieces();
        return;
      }
      var out = piece(b, 0);
      saveBlob(new Blob([dataUrlToBytes(out.url)], { type: dataUrlMime(out.url) || sheet.mime }), pieceName(idx));
    });

    $('#splitZip').addEventListener('click', function () {
      if (!sheet.boxes.length) return;
      var entries = sheet.boxes.map(function (b, i) {
        return { name: pieceName(i), bytes: dataUrlToBytes(piece(b, 0).url) };
      });
      saveBlob(zipStore(entries), safeName(stripExt(sheet.name), 'sheet') + '-pieces.zip');
    });
    $('#toEncoder').addEventListener('click', sendToEncoder);

    bindStage();
    syncFields();
  }

  /* =========================================================== ENCODE  */

  function addSamples() {
    var samples = [
      { name: 'quarterly-revenue.png', descr: 'Bar chart: quarterly revenue, Q1-Q4', draw: drawChart },
      { name: 'palette-rings.png', descr: 'Concentric colour rings on a slate ground', draw: drawRings }
    ];
    samples.forEach(function (s) {
      var url = s.draw();
      state.items.push({
        id: uid(), name: s.name, descr: s.descr, sample: true,
        src: url, mime: 'image/png', origBytes: dataUrlBytes(url),
        origW: 240, origH: 180, status: 'ok', out: url,
        outW: 240, outH: 180, outMime: 'image/png', outBytes: dataUrlBytes(url), note: ''
      });
    });
  }

  function sampleCanvas() {
    var c = document.createElement('canvas');
    c.width = 240; c.height = 180;
    return c;
  }

  function drawChart() {
    var c = sampleCanvas(), x = c.getContext('2d');
    x.fillStyle = '#f2f4f7'; x.fillRect(0, 0, 240, 180);
    x.strokeStyle = '#d6dee7'; x.lineWidth = 1;
    for (var g = 1; g <= 3; g++) {
      var gy = 30 + g * 30 + 0.5;
      x.beginPath(); x.moveTo(24, gy); x.lineTo(216, gy); x.stroke();
    }
    var vals = [46, 72, 58, 104];
    x.fillStyle = '#c93c22';
    vals.forEach(function (v, i) { x.fillRect(34 + i * 46, 150 - v, 28, v); });
    x.strokeStyle = '#111820'; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(24, 150.5); x.lineTo(216, 150.5); x.stroke();
    return c.toDataURL('image/png');
  }

  function drawRings() {
    var c = sampleCanvas(), x = c.getContext('2d');
    x.fillStyle = '#111820'; x.fillRect(0, 0, 240, 180);
    var colors = ['#c93c22', '#e08a5a', '#6c7a89', '#eceff3'];
    colors.forEach(function (col, i) {
      x.beginPath();
      x.arc(120, 90, 72 - i * 17, 0, Math.PI * 2);
      x.lineWidth = 11; x.strokeStyle = col; x.stroke();
    });
    return c.toDataURL('image/png');
  }

  function addFiles(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) {
      return /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name);
    });
    if (!list.length) { setStatus('No image files in that drop.', 'bad'); return Promise.resolve(); }

    /* first real image replaces the seeded samples */
    if (state.items.length && state.items.every(function (i) { return i.sample; })) state.items = [];

    setStatus('Reading ' + list.length + ' file' + (list.length > 1 ? 's' : '') + '…');

    return list.reduce(function (chain, file) {
      return chain.then(function () {
        return readAsDataURL(file).then(function (src) {
          var item = {
            id: uid(), name: file.name, descr: stripExt(file.name), sample: false,
            src: src, mime: file.type || dataUrlMime(src), origBytes: file.size,
            origW: 0, origH: 0, status: 'ok', note: ''
          };
          state.items.push(item);
          return loadImage(src).then(function (img) {
            item.origW = img.naturalWidth || 300;
            item.origH = img.naturalHeight || 150;
          }, function () {
            item.status = 'error';
            item.error = 'this browser cannot decode ' + (item.mime || 'that format');
          });
        });
      });
    }, Promise.resolve()).then(function () {
      return reprocessAll();
    });
  }

  function processItem(it) {
    if (it.status === 'error') return Promise.resolve();

    var vector = it.mime === 'image/svg+xml';
    var max = state.maxDim;
    var over = max > 0 && Math.max(it.origW, it.origH) > max;
    var keep = state.format === 'original';

    /* pass the original bytes straight through when nothing needs doing —
       this is what keeps animated GIFs animated */
    if (keep && (!over || vector)) {
      it.out = it.src; it.outW = it.origW; it.outH = it.origH;
      it.outMime = it.mime; it.outBytes = it.origBytes || dataUrlBytes(it.src);
      it.note = ''; it.resized = false;
      return Promise.resolve();
    }

    var target = keep ? it.mime : state.format;
    if (RASTER.indexOf(target) < 0) target = 'image/png';

    var scale = over ? max / Math.max(it.origW, it.origH) : 1;
    var w = Math.max(1, Math.round(it.origW * scale));
    var h = Math.max(1, Math.round(it.origH * scale));

    return loadImage(it.src).then(function (img) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      if (target === 'image/jpeg') { x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); }
      x.drawImage(img, 0, 0, w, h);

      var url = (target === 'image/png')
        ? c.toDataURL('image/png')
        : c.toDataURL(target, state.quality / 100);

      /* toDataURL silently falls back to PNG for unsupported types */
      var actual = dataUrlMime(url) || 'image/png';

      it.out = url; it.outW = w; it.outH = h;
      it.outMime = actual; it.outBytes = dataUrlBytes(url);
      it.resized = over;
      it.note = (it.mime === 'image/gif' ? 'animation dropped' : '');
    }, function () {
      it.status = 'error';
      it.error = 'could not re-encode this image';
    });
  }

  function reprocessAll() {
    setStatus('Encoding…');
    return state.items.reduce(function (chain, it) {
      return chain.then(function () { return processItem(it); });
    }, Promise.resolve()).then(function () {
      renderItems();
      renderOutput();
      var bad = state.items.filter(function (i) { return i.status === 'error'; }).length;
      setStatus(bad ? bad + ' image' + (bad > 1 ? 's' : '') + ' could not be read' : 'Ready', bad ? 'bad' : null);
    });
  }

  function renderItems() {
    var list = $('#imgList');
    $('#countBadge').textContent = String(state.items.length);
    if (!state.items.length) { list.innerHTML = ''; return; }

    list.innerHTML = state.items.map(function (it, i) {
      var meta;
      if (it.status === 'error') {
        meta = '<span style="color:var(--danger)">' + esc(it.error) + '</span>';
      } else {
        var dim = it.outW + '×' + it.outH;
        if (it.resized) dim = '<span class="meta-cut">' + dim + '</span> ← ' + it.origW + '×' + it.origH;
        meta = '<span>' + dim + '</span>' +
          '<span>' + esc((it.outMime || '').replace('image/', '')) + '</span>' +
          '<span>' + bytes(it.outBytes) + '</span>' +
          '<span>≈' + count(Math.round((it.out || '').length / CHARS_PER_TOKEN)) + ' tok</span>';
      }
      return '<li class="item' + (it.status === 'error' ? ' is-bad' : '') + '" data-id="' + it.id + '">' +
        '<img class="item-thumb" src="' + it.src + '" alt="" data-zoom="' + it.id + '">' +
        '<div class="item-head">' +
          '<span class="item-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
          (it.sample ? '<span class="chip chip-sample">sample</span>' : '') +
          (it.note ? '<span class="chip chip-warn">' + esc(it.note) + '</span>' : '') +
        '</div>' +
        '<div class="item-tools">' +
          '<button type="button" class="btn-icon" data-act="up" data-id="' + it.id + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="btn-icon" data-act="down" data-id="' + it.id + '" title="Move down"' + (i === state.items.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" class="btn-icon" data-act="del" data-id="' + it.id + '" title="Remove">×</button>' +
        '</div>' +
        '<input class="item-descr" data-id="' + it.id + '" value="' + esc(it.descr) + '" placeholder="Describe this image for the model…" aria-label="Description for ' + esc(it.name) + '">' +
        '<div class="item-meta">' + meta + '</div>' +
      '</li>';
    }).join('');
  }

  function payload() {
    return {
      images: state.items.filter(function (i) { return i.status !== 'error' && i.out; })
        .map(function (i) { return { descr: i.descr, base64: i.out }; })
    };
  }

  function renderOutput() {
    var obj = payload();
    var json = JSON.stringify(obj, null, state.pretty ? 2 : 0);
    state.json = json;

    var out = $('#jsonOut');
    if (json.length > PREVIEW_LIMIT) {
      out.value = json.slice(0, PREVIEW_LIMIT) + '\n\n… preview truncated — Copy and Download still carry the whole payload.';
      $('#outHint').firstChild.textContent =
        'Showing the first ' + count(PREVIEW_LIMIT) + ' of ' + count(json.length) + ' characters. ';
    } else {
      out.value = json;
      $('#outHint').firstChild.textContent = '';
    }

    var tokens = Math.round(json.length / CHARS_PER_TOKEN);
    var pct = tokens / CONTEXT_WINDOW * 100;
    $('#stImages').textContent = String(obj.images.length);
    $('#stSize').textContent = bytes(json.length);
    $('#stTokens').textContent = count(tokens);
    $('#stCtx').textContent = (pct < 0.1 && pct > 0 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)) + '% of a 200K context';
    var fill = $('#meterFill');
    fill.style.width = Math.min(100, pct) + '%';
    fill.classList.toggle('is-hot', pct > 60);
  }

  /* =========================================================== DECODE  */

  var B64_KEYS = ['base64', 'b64', 'data', 'image', 'img', 'src', 'url', 'content'];
  var DESCR_KEYS = ['descr', 'description', 'desc', 'caption', 'alt', 'label', 'title', 'name'];

  /* Accepts the loose shapes an LLM actually emits: unquoted keys, single
     quotes, trailing commas, // comments, fenced code blocks. */
  function relax(src) {
    var strings = [], out = '', i = 0, n = src.length;
    while (i < n) {
      var c = src[i];
      if (c === '"' || c === "'") {
        var q = c, j = i + 1, val = '';
        while (j < n) {
          var d = src[j];
          if (d === '\\') {
            var e = src[j + 1];
            val += (q === "'" && e === "'") ? "'" : d + e;
            j += 2; continue;
          }
          if (d === q) { j++; break; }
          val += d; j++;
        }
        if (q === "'") val = val.replace(/"/g, '\\"');
        val = val.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
        strings.push('"' + val + '"');
        out += '\u0000' + (strings.length - 1) + '\u0000';
        i = j; continue;
      }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      out += c; i++;
    }
    out = out.replace(/([{[,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
    out = out.replace(/,(\s*[}\]])/g, '$1');
    return out.replace(/\u0000(\d+)\u0000/g, function (m, k) { return strings[+k]; });
  }

  function looseParse(text) {
    var s = text.trim()
      .replace(/^```[a-zA-Z]*\s*/, '')
      .replace(/```\s*$/, '')
      .trim();
    try { return JSON.parse(s); } catch (e) { /* fall through to the relaxed pass */ }
    return JSON.parse(relax(s));
  }

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === 'string' && v.length) return v;
    }
    return '';
  }

  function extractList(root) {
    if (Array.isArray(root)) return root;
    if (!root || typeof root !== 'object') return null;
    var keys = ['images', 'items', 'data', 'files', 'attachments'];
    for (var i = 0; i < keys.length; i++) if (Array.isArray(root[keys[i]])) return root[keys[i]];
    if (pick(root, B64_KEYS)) return [root];
    return null;
  }

  function sniffMime(b64) {
    var head, n = Math.min(32, b64.length - (b64.length % 4));
    try { head = atob(b64.slice(0, n)); } catch (e) { return ''; }
    var byte = function (i) { return head.charCodeAt(i); };
    if (head.slice(1, 4) === 'PNG') return 'image/png';
    if (byte(0) === 0xff && byte(1) === 0xd8) return 'image/jpeg';
    if (head.slice(0, 3) === 'GIF') return 'image/gif';
    if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return 'image/webp';
    if (head.slice(0, 2) === 'BM') return 'image/bmp';
    if (head.slice(4, 12) === 'ftypavif') return 'image/avif';
    if (/^\s*(<svg|<\?xml)/i.test(head)) return 'image/svg+xml';
    return '';
  }

  function toDataUrl(raw) {
    var s = String(raw).trim();
    if (/^data:/i.test(s)) return { url: s.replace(/\s/g, ''), mime: dataUrlMime(s) };
    /* tolerate the base64url alphabet some tools emit */
    var b64 = s.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 8) return { error: 'not base64 or a data URL' };
    var mime = sniffMime(b64);
    if (!mime) return { error: 'unrecognised image format' };
    return { url: 'data:' + mime + ';base64,' + b64, mime: mime };
  }

  function decodeNow() {
    var text = $('#jsonIn').value;
    var hint = $('#parseHint');
    var gallery = $('#gallery');

    if (!text.trim()) {
      state.decoded = [];
      gallery.innerHTML = '';
      hint.className = 'hint';
      hint.textContent = 'Paste a payload, or drop a .json file here. Unquoted keys, single quotes, trailing commas and ```json fences are all tolerated.';
      $('#dcCount').textContent = '0';
      $('#dcSize').textContent = '0 B';
      $('#downloadZip').disabled = true;
      return;
    }

    var root;
    try { root = looseParse(text); }
    catch (e) {
      hint.className = 'hint is-bad';
      hint.textContent = 'Could not parse: ' + e.message;
      setStatus('Payload is not valid JSON', 'bad');
      return;
    }

    var list = extractList(root);
    if (!list) {
      hint.className = 'hint is-bad';
      hint.textContent = 'Parsed, but found no images array. Expected { "images": [ { "descr": …, "base64": … } ] }.';
      setStatus('No images array found', 'bad');
      return;
    }

    var loose = 0;
    state.decoded = list.map(function (entry, i) {
      var raw, descr;
      if (typeof entry === 'string') { raw = entry; descr = ''; }
      else if (entry && typeof entry === 'object') {
        raw = pick(entry, B64_KEYS);
        descr = pick(entry, DESCR_KEYS);
      } else return { error: 'entry ' + (i + 1) + ' is not an object', descr: '' };

      if (!raw) return { error: 'entry ' + (i + 1) + ' has no base64 field', descr: descr };
      var r = toDataUrl(raw);
      if (r.error) return { error: 'entry ' + (i + 1) + ': ' + r.error, descr: descr };
      if (!/^data:/i.test(String(raw).trim())) loose++;
      return { url: r.url, mime: r.mime, descr: descr, size: dataUrlBytes(r.url), w: 0, h: 0 };
    });

    var ok = state.decoded.filter(function (d) { return !d.error; });
    var total = ok.reduce(function (a, d) { return a + d.size; }, 0);
    $('#dcCount').textContent = String(ok.length);
    $('#dcSize').textContent = bytes(total);
    $('#downloadZip').disabled = !ok.length;

    var bad = state.decoded.length - ok.length;
    hint.className = 'hint' + (bad ? ' is-bad' : ' is-good');
    hint.textContent = ok.length + ' image' + (ok.length === 1 ? '' : 's') + ' decoded'
      + (loose ? ', ' + loose + ' from raw base64 (type sniffed from the header)' : '')
      + (bad ? ' — ' + bad + ' entr' + (bad === 1 ? 'y' : 'ies') + ' failed' : '') + '.';
    setStatus(ok.length ? 'Decoded ' + ok.length + ' image' + (ok.length === 1 ? '' : 's') : 'Nothing decoded', bad ? 'bad' : 'good');

    renderGallery();
  }

  function renderGallery() {
    var gallery = $('#gallery');
    gallery.innerHTML = state.decoded.map(function (d, i) {
      if (d.error) {
        return '<div class="card is-bad"><p class="card-err">' + esc(d.error) + '</p></div>';
      }
      return '<figure class="card" data-i="' + i + '">' +
        '<div class="card-figure" data-zoomd="' + i + '"><img src="' + d.url + '" alt="' + esc(d.descr) + '"></div>' +
        '<figcaption class="card-body">' +
          '<p class="card-descr">' + (d.descr ? esc(d.descr) : '<span style="color:var(--muted)">no description</span>') + '</p>' +
          '<div class="card-meta">' +
            '<span data-dim="' + i + '">…</span>' +
            '<span>' + esc(d.mime.replace('image/', '')) + '</span>' +
            '<span>' + bytes(d.size) + '</span>' +
          '</div>' +
        '</figcaption>' +
        '<div class="card-foot"><button type="button" class="btn" data-save="' + i + '">Save image</button></div>' +
      '</figure>';
    }).join('');

    state.decoded.forEach(function (d, i) {
      if (d.error) return;
      loadImage(d.url).then(function (img) {
        d.w = img.naturalWidth; d.h = img.naturalHeight;
        var el = gallery.querySelector('[data-dim="' + i + '"]');
        if (el) el.textContent = d.w + '×' + d.h;
      }, function () {
        var el = gallery.querySelector('[data-dim="' + i + '"]');
        if (el) el.textContent = 'undecodable';
      });
    });
  }

  /* ------------------------------------------------------------- files */

  /* When the app runs inside a sandboxed host that brokers saves (the
     claude.ai artifact viewer), hand the file to the host; a normal page
     just clicks a download link. Resolved in init(). */
  var hostSave = null;

  function saveBlob(blob, filename) {
    if (hostSave) {
      hostSave.save({ filename: filename, data: blob }).then(function () {
        setStatus('Saved ' + filename, 'good');
      }, function (err) {
        var code = err && err.code;
        if (code === 'declined') setStatus('Save cancelled');
        else if (code === 'rejected_extension') setStatus('This viewer will not accept a ' + filename.replace(/^.*\./, '.') + ' file', 'bad');
        else setStatus('Save failed: ' + ((err && err.message) || 'unknown reason'), 'bad');
      });
      return;
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    setStatus('Saved ' + filename, 'good');
  }

  function safeName(s, fallback) {
    var base = (s || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return base || fallback;
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* Minimal store-only (uncompressed) ZIP — images are already compressed,
     so there is nothing to gain from deflate and no library to load. */
  function zipStore(entries) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;

    entries.forEach(function (e) {
      var name = enc.encode(e.name);
      var crc = crc32(e.bytes);
      var size = e.bytes.length;
      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);        // UTF-8 filenames
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);

      var cd = new Uint8Array(46 + name.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);

      parts.push(local, e.bytes);
      central.push(cd);
      offset += local.length + size;
    });

    var cdSize = central.reduce(function (a, c) { return a + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      ok ? res() : rej(new Error('clipboard blocked'));
    });
  }

  /* ------------------------------------------------------------ wiring */

  function setMode(mode) {
    state.mode = mode;
    ['split', 'encode', 'decode'].forEach(function (m) {
      var on = m === mode;
      var tab = $('#tab-' + m);
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', String(on));
      $('#pane-' + m).hidden = !on;
    });
  }

  function openLightbox(src, caption) {
    $('#lbImg').src = src;
    $('#lbCap').textContent = caption;
    var lb = $('#lightbox');
    if (typeof lb.showModal === 'function') lb.showModal();
  }

  function byId(id) {
    return state.items.filter(function (i) { return i.id === id; })[0];
  }

  function init() {
    loadPrefs();

    if (window.self !== window.top) document.body.classList.add('is-embedded');

    /* the hint paragraphs carry a text node the renderer rewrites, plus a
       fixed note that only shows inside an embedded preview */
    var note = 'Downloads are blocked in this embedded preview — use Copy, or open the app in its own tab.';
    $('#outHint').innerHTML = '<span></span><span class="dl-note">' + note + '</span>';
    $('#outHint').firstChild.textContent = '';
    var dnote = document.createElement('p');
    dnote.className = 'hint';
    dnote.innerHTML = '<span class="dl-note">' + note + '</span>';
    $('#pane-decode .col-out').insertBefore(dnote, $('#gallery'));
    $('#stageHint').lastElementChild.textContent = note;

    /* An artifact host brokers saves on the page's behalf; it resolves
       late, or never on an ordinary web page. */
    if (window.claude && typeof window.claude.use === 'function') {
      window.claude.use('downloads').then(function (dl) {
        if (!dl) return;
        hostSave = dl;
        $('#downloadZip').hidden = true;   /* .zip is not an accepted type there */
        $('#splitZip').hidden = true;
        Array.prototype.forEach.call(document.querySelectorAll('.dl-note'), function (el) {
          el.textContent = 'Saving asks for your confirmation here, and .zip is not an accepted file type — save images one at a time.';
        });
      }, function () { /* unresolved: the plain download link still works */ });
    }

    $('#maxDim').value = String(state.maxDim);
    $('#format').value = state.format;
    $('#quality').value = String(state.quality);
    $('#qualityVal').textContent = String(state.quality);
    $('#prettyToggle').checked = state.pretty;

    /* mode switch */
    document.querySelectorAll('.mode').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });

    /* ---- dropzone ---- */
    var dz = $('#dropzone'), fi = $('#fileInput');
    dz.addEventListener('click', function () { fi.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
    });
    fi.addEventListener('change', function () { addFiles(fi.files); fi.value = ''; });

    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('is-over'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    /* stop the browser from navigating away when a drop misses the target */
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    document.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      var files = Array.prototype.slice.call(e.clipboardData.files);
      if (!files.length) return;
      if (state.mode === 'encode') { e.preventDefault(); addFiles(files); }
      else if (state.mode === 'split') { e.preventDefault(); loadSheet(files[0]); }
    });

    /* ---- options ---- */
    var reprocess = debounce(function () { savePrefs(); reprocessAll(); }, 120);
    $('#maxDim').addEventListener('change', function () { state.maxDim = +this.value; reprocess(); });
    $('#format').addEventListener('change', function () { state.format = this.value; reprocess(); });
    $('#quality').addEventListener('input', function () {
      state.quality = +this.value;
      $('#qualityVal').textContent = this.value;
      reprocess();
    });
    $('#prettyToggle').addEventListener('change', function () {
      state.pretty = this.checked; savePrefs(); renderOutput();
    });

    /* ---- item list ---- */
    var reflow = debounce(renderOutput, 150);
    $('#imgList').addEventListener('input', function (e) {
      var input = e.target.closest('.item-descr');
      if (!input) return;
      var it = byId(input.dataset.id);
      if (it) { it.descr = input.value; reflow(); }
    });
    $('#imgList').addEventListener('click', function (e) {
      var zoom = e.target.closest('[data-zoom]');
      if (zoom) {
        var zi = byId(zoom.dataset.zoom);
        if (zi) openLightbox(zi.out || zi.src, zi.name + ' · ' + zi.outW + '×' + zi.outH);
        return;
      }
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var idx = state.items.findIndex(function (i) { return i.id === btn.dataset.id; });
      if (idx < 0) return;
      if (btn.dataset.act === 'del') state.items.splice(idx, 1);
      if (btn.dataset.act === 'up' && idx > 0) state.items.splice(idx - 1, 0, state.items.splice(idx, 1)[0]);
      if (btn.dataset.act === 'down' && idx < state.items.length - 1) state.items.splice(idx + 1, 0, state.items.splice(idx, 1)[0]);
      renderItems();
      renderOutput();
    });
    $('#clearAll').addEventListener('click', function () {
      state.items = [];
      renderItems(); renderOutput();
      setStatus('Cleared');
    });

    /* ---- output actions ---- */
    $('#copyJson').addEventListener('click', function () {
      var btn = this;
      copyText(state.json).then(function () {
        btn.textContent = 'Copied';
        setStatus('Payload copied — ' + bytes(state.json.length), 'good');
        setTimeout(function () { btn.textContent = 'Copy'; }, 1400);
      }, function () {
        setStatus('Clipboard blocked by the browser — select the text and copy manually', 'bad');
      });
    });
    $('#downloadJson').addEventListener('click', function () {
      saveBlob(new Blob([state.json], { type: 'application/json' }), 'payload.json');
    });

    /* ---- decode ---- */
    var parseSoon = debounce(decodeNow, 250);
    var jsonIn = $('#jsonIn');
    jsonIn.addEventListener('input', parseSoon);
    jsonIn.addEventListener('dragover', function (e) { e.preventDefault(); });
    jsonIn.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      readAsText(f).then(function (t) { jsonIn.value = t; decodeNow(); });
    });
    $('#clearJson').addEventListener('click', function () { jsonIn.value = ''; decodeNow(); });
    $('#useEncoded').addEventListener('click', function () {
      jsonIn.value = state.json;
      decodeNow();
    });

    $('#gallery').addEventListener('click', function (e) {
      var fig = e.target.closest('[data-zoomd]');
      if (fig) {
        var d = state.decoded[+fig.dataset.zoomd];
        if (d) openLightbox(d.url, (d.descr || 'no description') + ' · ' + d.w + '×' + d.h);
        return;
      }
      var save = e.target.closest('[data-save]');
      if (!save) return;
      var i = +save.dataset.save, item = state.decoded[i];
      if (!item || item.error) return;
      saveBlob(new Blob([dataUrlToBytes(item.url)], { type: item.mime }),
        safeName(item.descr, 'image-' + (i + 1)) + '.' + extFor(item.mime));
    });

    $('#downloadZip').addEventListener('click', function () {
      var entries = [], seen = {};
      state.decoded.forEach(function (d, i) {
        if (d.error) return;
        var base = safeName(d.descr, 'image-' + (i + 1));
        var name = String(i + 1).padStart(2, '0') + '-' + base + '.' + extFor(d.mime);
        while (seen[name]) name = '_' + name;
        seen[name] = 1;
        entries.push({ name: name, bytes: dataUrlToBytes(d.url) });
      });
      if (!entries.length) return;
      saveBlob(zipStore(entries), 'images.zip');
    });

    /* ---- lightbox ---- */
    $('#lightbox').addEventListener('click', function (e) {
      if (e.target === this) this.close();
    });

    bindSplit();

    /* ---- open in a working state ---- */
    addSamples();
    reprocessAll().then(function () {
      setStatus('Two sample images loaded — drop your own to replace them');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
