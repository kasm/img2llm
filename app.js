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
    ['encode', 'decode'].forEach(function (m) {
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

    /* An artifact host brokers saves on the page's behalf; it resolves
       late, or never on an ordinary web page. */
    if (window.claude && typeof window.claude.use === 'function') {
      window.claude.use('downloads').then(function (dl) {
        if (!dl) return;
        hostSave = dl;
        $('#downloadZip').hidden = true;   /* .zip is not an accepted type there */
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
      if (state.mode !== 'encode' || !e.clipboardData) return;
      var files = Array.prototype.slice.call(e.clipboardData.files);
      if (files.length) { e.preventDefault(); addFiles(files); }
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

    /* ---- open in a working state ---- */
    addSamples();
    reprocessAll().then(function () {
      setStatus('Two sample images loaded — drop your own to replace them');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
