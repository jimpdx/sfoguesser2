'use strict';

// KSFO Ground Trainer. No build step and no dependencies: open index.html
// from any static web server (GitHub Pages, python -m http.server).
//
// Everything is drawn in a flat "frame" measured in meters, rotated so the
// runways run straight up/down and across (ASDE-X orientation). The frame
// is defined in data/sfo/airport.json; gates are stored as lat/lon in
// data/sfo/gates.json and projected here. tools/common.py has the same
// projection for the build scripts.

(() => {
  const DATA = 'data/sfo/';
  const STORE = 'ksfoGroundTrainer.';
  const EDIT = new URLSearchParams(location.search).has('edit');
  const ADMIN = new URLSearchParams(location.search).has('admin');
  // Google's Firebase SDK, loaded only by the ?admin view (for Google sign-in)
  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/13.4.0';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const AREA_COLORS = {
    A: '#ff6b6b', B: '#ffa94d', C: '#ffd43b', D: '#69db7c',
    E: '#38d9a9', F: '#74c0fc', G: '#b197fc', spots: '#1c7ed6',
  };
  // Labels sit centered above the marker. A point can ask for "left" or
  // "right" in gates.json where neighbors crowd the space above (spots
  // 5/5A/5B are stacked; F20-F22 wrap the end of the F pier).
  const LABEL_POS = {
    right: { x: 12, y: 5.4 },
    left: { x: -12, y: 5.4, 'text-anchor': 'end' },
    above: { x: 0, y: -12.5, 'text-anchor': 'middle' },
  };
  const TEN = 10;
  const CORRECT_MS = 2000; // how long the green "Correct" banner stays up
  const MAX_K = 14; // px per meter

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  // with tenths, for the LEADERBOARD where times break ties
  const fmtTenths = (ms) => `${fmtTime(ms)}.${Math.floor((ms % 1000) / 100)}`;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(STORE + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  let airport, data, proj, areaById;
  const view = { k: 1, tx: 0, ty: 0 };
  const marks = new Map(); // id -> { p, g }
  const rwyLabels = []; // { x, y, el } in frame meters
  const twyLabels = []; // { x, y, el } in frame meters
  const state = {
    mode: 'learn',
    base: store.get('base', 'chart'),
    areas: new Set(store.get('areas', null) || []),
    labels: store.get('labels', true),
    colors: store.get('colors', true),
    taxiways: store.get('taxiways', true),
    revealed: new Set(),
    selected: null,
    quiz: null,
    moved: new Set(),
  };
  // LEADERBOARD (see the leaderboard section); url stays empty when off
  const board = { url: '', docs: '', apiKey: '', icao: '', emu: false, cache: new Map(), pending: null, mine: null, showing: '' };
  // ?admin view: Google sign-in; `is` once Firestore confirms an admins doc
  const admin = { auth: null, sdk: null, user: null, is: false, busy: '', note: '' };

  // ---------- projection ----------

  function makeProjection(frame) {
    const [lat0, lon0] = frame.center;
    const th = frame.rotation * Math.PI / 180;
    const R = 6378137;
    const kx = R * Math.cos(lat0 * Math.PI / 180) * Math.PI / 180;
    const ky = R * Math.PI / 180;
    const c = Math.cos(th), s = Math.sin(th);
    return {
      to(lat, lon) {
        const e = (lon - lon0) * kx, n = (lat - lat0) * ky;
        return [e * c - n * s, -(e * s + n * c)];
      },
      from(x, y) {
        const up = -y, e = x * c + up * s, n = -x * s + up * c;
        return [lat0 + n / ky, lon0 + e / kx];
      },
    };
  }

  // ---------- setup ----------

  async function init() {
    const get = (f) => fetch(DATA + f).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r; });
    const [a, g, chart, rwys, twys] = await Promise.all([
      get('airport.json').then((r) => r.json()),
      get('gates.json').then((r) => r.json()),
      get('chart.svg').then((r) => r.text()),
      get('runways.json').then((r) => r.json()).catch(() => ({ runways: [] })),
      get('taxiways.json').then((r) => r.json()).catch(() => ({ lines: [], labels: [] })),
    ]);
    airport = a; data = g;
    proj = makeProjection(airport.frame);
    areaById = Object.fromEntries(data.areas.map((x) => [x.id, x]));
    for (const p of data.points) [p.x, p.y] = proj.to(p.lat, p.lon);
    if (!state.areas.size || [...state.areas].some((id) => !areaById[id])) {
      state.areas = new Set(data.areas.map((x) => x.id));
    }

    buildLayers(chart);
    buildRunways(rwys.runways);
    buildTaxiways(twys);
    setTaxiways(state.taxiways);
    buildMarks();
    buildAreaChips();
    buildLegend();
    setupBoard();
    bindUI();
    setBase(state.base);
    setMode(EDIT ? 'edit' : 'learn');
    $('#opt-labels').checked = state.labels;
    $('#opt-colors').checked = state.colors;
    // ?view=x0,y0,x1,y1 (frame meters) opens framed on one area
    const v = (new URLSearchParams(location.search).get('view') || '').split(',').map(Number);
    if (v.length === 4 && v.every(Number.isFinite) && v[2] > v[0] && v[3] > v[1]) {
      fitBounds(v);
      view.auto = false;
    } else {
      fitBounds(airport.home);
    }
    new ResizeObserver(() => fitBoundsKeepCenter()).observe($('#stage'));
    $('#loading').hidden = true;
  }

  function buildLayers(chartText) {
    const [x0, y0, x1, y1] = airport.frame.bounds;
    const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, preserveAspectRatio: 'none' };
    $('#layer-satellite').append(svgEl('image', { ...box, href: DATA + airport.layers.satellite.file }));
    // runways and taxiways stop at the edge of the base map
    const defs = svgEl('defs');
    const clip = svgEl('clipPath', { id: 'frame-clip' });
    clip.append(svgEl('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
    defs.append(clip);
    $('#map').prepend(defs);
    $('#layer-runways').setAttribute('clip-path', 'url(#frame-clip)');
    $('#layer-taxiways').setAttribute('clip-path', 'url(#frame-clip)');
    const doc = new DOMParser().parseFromString(chartText, 'image/svg+xml');
    const layer = $('#layer-chart');
    for (const n of [...doc.documentElement.childNodes]) layer.append(document.importNode(n, true));
    if (EDIT) {
      const img = svgEl('image', { ...box, href: '.cache/reference.png', opacity: 0.5 });
      img.addEventListener('error', () => {
        $('#opt-ref').disabled = true;
        $('#ref-note').textContent = 'No reference overlay found. Run tools/reference_overlay.py to make .cache/reference.png.';
      });
      $('#layer-ref').append(img);
      $('#layer-ref').style.display = 'none';
    }
  }

  // Clip segment a->b to a box; returns [tEnter, tExit] or null (Liang-Barsky).
  function clipSegment(a, b, [x0, y0, x1, y1]) {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
    return [t0, t1];
  }

  // Runways from runways.json: a strip with a dashed centerline in frame
  // meters, plus a designator just inside each threshold. A threshold
  // outside the frame gets its designator where the runway enters the frame.
  function buildRunways(list) {
    const layer = $('#layer-runways');
    const labels = $('#rwy-labels');
    const bounds = airport.frame.bounds;
    for (const r of list) {
      const [e1, e2] = r.ends;
      const A = proj.to(e1.lat, e1.lon), B = proj.to(e2.lat, e2.lon);
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
      const n = [-u[1] * r.width / 2, u[0] * r.width / 2];
      const poly = [[A[0] + n[0], A[1] + n[1]], [B[0] + n[0], B[1] + n[1]], [B[0] - n[0], B[1] - n[1]], [A[0] - n[0], A[1] - n[1]]];
      const g = svgEl('g', { class: 'rwy', 'data-id': r.id });
      g.append(
        svgEl('polygon', { class: 'rwy-body', points: poly.map((q) => q.join(',')).join(' ') }),
        svgEl('line', { class: 'rwy-cl', x1: A[0], y1: A[1], x2: B[0], y2: B[1] }),
      );
      layer.append(g);

      const clip = clipSegment(A, B, bounds);
      if (!clip) continue;
      for (const [end, t, dir] of [[e1, clip[0], 1], [e2, 1 - clip[1], -1]]) {
        // t is how far along (from this end) the runway enters the frame
        const inside = t <= 0;
        const start = dir === 1 ? A : B;
        const d = t * len + (inside ? 70 : 160);
        const x = start[0] + u[0] * dir * d, y = start[1] + u[1] * dir * d;
        const el = svgEl('text', { class: 'rwy-lbl' });
        el.textContent = end.des;
        labels.append(el);
        rwyLabels.push({ x, y, el });
      }
    }
  }

  // Taxiway centerlines (yellow) and a location-sign style letter for each
  // named taxiway, from taxiways.json. Shown or hidden by the Taxiways toggle.
  function buildTaxiways(t) {
    const layer = $('#layer-taxiways');
    for (const line of t.lines) {
      const pts = line.pts.map(([lat, lon]) => proj.to(lat, lon).map((v) => v.toFixed(1)).join(','));
      layer.append(svgEl('polyline', { class: 'twy-cl', points: pts.join(' ') }));
    }
    const labels = $('#twy-labels');
    for (const lb of t.labels) {
      const [x, y] = proj.to(lb.lat, lb.lon);
      const w = 10 + 8.5 * lb.ref.length;
      const g = svgEl('g', { class: 'twy-sign' });
      g.append(svgEl('rect', { x: -w / 2, y: -9.5, width: w, height: 19, rx: 2 }));
      const text = svgEl('text', { y: 0.5 });
      text.textContent = lb.ref;
      g.append(text);
      labels.append(g);
      twyLabels.push({ x, y, el: g });
    }
  }

  function setTaxiways(on) {
    state.taxiways = on;
    store.set('taxiways', on);
    $('#layer-taxiways').style.display = on ? '' : 'none';
    $('#twy-labels').style.display = on ? '' : 'none';
    for (const b of $$('#overlays [data-overlay="taxiways"]')) b.setAttribute('aria-pressed', String(on));
  }

  function buildMarks() {
    const root = $('#marks');
    for (const p of data.points) {
      const g = svgEl('g', { class: `mk mk-${p.kind}`, 'data-id': p.id });
      g.style.setProperty('--c', AREA_COLORS[p.area] || '');
      const shape = p.kind === 'spot'
        ? svgEl('rect', { x: -7.8, y: -7.8, width: 15.6, height: 15.6, rx: 3 })
        : svgEl('circle', { r: 8.4 });
      const text = svgEl('text', LABEL_POS[p.label] || LABEL_POS.above);
      text.textContent = p.id;
      g.append(shape, text);
      root.append(g);
      marks.set(p.id, { p, g });
    }
  }

  function buildAreaChips() {
    const box = $('#areas');
    const all = document.createElement('button');
    all.type = 'button'; all.textContent = 'All'; all.dataset.area = '*';
    box.append(all);
    for (const a of data.areas) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.area = a.id;
      b.textContent = a.id === 'spots' ? 'Spots' : a.id;
      b.title = `${a.name}, ${a.terminal}`;
      box.append(b);
    }
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const id = b.dataset.area;
      if (id === '*') {
        state.areas = new Set(data.areas.map((x) => x.id));
      } else if (state.areas.has(id)) {
        if (state.areas.size > 1) state.areas.delete(id);
      } else {
        state.areas.add(id);
      }
      store.set('areas', [...state.areas]);
      refreshAreas();
    });
    refreshAreas();
  }

  function buildLegend() {
    $('#legend').innerHTML = data.areas.map((a) =>
      `<span title="${a.terminal}"><i class="${a.id === 'spots' ? 'sq' : ''}" style="background:${AREA_COLORS[a.id]}"></i>${a.id === 'spots' ? 'Spots' : a.name.replace('Boarding Area ', 'Area ')}</span>`,
    ).join('');
  }

  function bindUI() {
    $('#modes').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) setMode(b.dataset.mode);
    });
    $('#bases').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) setBase(b.dataset.base);
    });
    $('#overlays').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && b.dataset.overlay === 'taxiways') setTaxiways(!state.taxiways);
    });
    $('#zoom').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const r = mapRect();
      if (b.dataset.zoom === 'in') zoomAt(r.width / 2, r.height / 2, 1.5);
      else if (b.dataset.zoom === 'out') zoomAt(r.width / 2, r.height / 2, 1 / 1.5);
      else fitBounds(airport.home);
    });
    $('#opt-labels').addEventListener('change', (e) => {
      state.labels = e.target.checked; state.revealed.clear(); store.set('labels', state.labels); refreshMarks();
    });
    $('#opt-colors').addEventListener('change', (e) => {
      state.colors = e.target.checked; store.set('colors', state.colors); refreshMarks();
    });
    $('#ten-start').addEventListener('click', () => startQuiz('ten'));
    $('#streak-start').addEventListener('click', () => startQuiz('streak'));
    $('#edit-export').addEventListener('click', exportGates);
    $('#opt-ref').addEventListener('change', (e) => { $('#layer-ref').style.display = e.target.checked ? '' : 'none'; });
    $('#ref-opacity').addEventListener('input', (e) => {
      const img = $('#layer-ref image');
      if (img) img.setAttribute('opacity', e.target.value / 100);
    });

    const map = $('#map');
    map.addEventListener('pointerdown', onDown);
    map.addEventListener('pointermove', onMove);
    map.addEventListener('pointerup', onUp);
    map.addEventListener('pointercancel', onUp);
    map.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pt(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
      const r = mapRect();
      if (e.key === ' ' || e.key === 'Enter') {
        if (state.quiz && state.quiz.waiting) { e.preventDefault(); nextQuestion(); }
      } else if (e.key === '+' || e.key === '=') zoomAt(r.width / 2, r.height / 2, 1.5);
      else if (e.key === '-' || e.key === '_') zoomAt(r.width / 2, r.height / 2, 1 / 1.5);
      else if (e.key === '0') fitBounds(airport.home);
      else if (e.key === 't' || e.key === 'T') setTaxiways(!state.taxiways);
      else if ((e.key === 'l' || e.key === 'L') && state.mode === 'learn') {
        $('#opt-labels').checked = !state.labels;
        $('#opt-labels').dispatchEvent(new Event('change'));
      }
    });
  }

  // ---------- view ----------

  function mapRect() { return $('#map').getBoundingClientRect(); }
  function pt(e) { const r = mapRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function toWorld(p) { return [(p.x - view.tx) / view.k, (p.y - view.ty) / view.k]; }
  function minK() {
    const r = mapRect();
    const [x0, y0, x1, y1] = airport.frame.bounds;
    return Math.min(r.width / (x1 - x0), r.height / (y1 - y0)) * 0.8;
  }

  let raf = 0;
  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  }
  function render() {
    $('#world').setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`);
    // shrink markers when zoomed far out (phones) so piers stay readable
    const s = clamp(0.5 + view.k * 0.65, 0.62, 1).toFixed(2);
    for (const { p, g } of marks.values()) {
      g.setAttribute('transform', `translate(${(p.x * view.k + view.tx).toFixed(1)} ${(p.y * view.k + view.ty).toFixed(1)}) scale(${s})`);
    }
    // runway and taxiway letters keep full size at every zoom
    for (const r of rwyLabels.concat(twyLabels)) {
      r.el.setAttribute('transform', `translate(${(r.x * view.k + view.tx).toFixed(1)} ${(r.y * view.k + view.ty).toFixed(1)})`);
    }
  }

  const PROMPT_SPACE = 88; // room at the top for the quiz banner (82 px tall)

  function fitBounds([x0, y0, x1, y1], pad = 16) {
    const r = mapRect();
    if (!r.width || !r.height) return;
    const top = PROMPT_SPACE;
    const k = Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - top - pad) / (y1 - y0));
    view.k = k;
    view.tx = r.width / 2 - ((x0 + x1) / 2) * k;
    view.ty = top + (r.height - top - pad) / 2 - ((y0 + y1) / 2) * k;
    view.auto = true; // refit on resize until the user pans or zooms
    lastSize = { w: r.width, h: r.height };
    schedule();
  }

  let lastSize = null;
  function fitBoundsKeepCenter() {
    const r = mapRect();
    if (!lastSize || view.auto) return fitBounds(airport.home);
    view.tx += (r.width - lastSize.w) / 2;
    view.ty += (r.height - lastSize.h) / 2;
    lastSize = { w: r.width, h: r.height };
    schedule();
  }

  function zoomAt(sx, sy, factor) {
    const k = clamp(view.k * factor, minK(), MAX_K);
    const f = k / view.k;
    view.tx = sx - (sx - view.tx) * f;
    view.ty = sy - (sy - view.ty) * f;
    view.k = k;
    view.auto = false;
    schedule();
  }

  // Pan (animated) so the given markers are on screen and not under the
  // prompt or the zoom buttons.
  function ensureVisible(ids) {
    const r = mapRect();
    const pr = $('#prompt').classList.contains('show') ? $('#prompt').getBoundingClientRect() : null;
    const zr = $('#zoom').getBoundingClientRect();
    const m = 28;
    let dx = 0, dy = 0;
    for (const id of ids) {
      const mk = marks.get(id);
      if (!mk) continue;
      let x = mk.p.x * view.k + view.tx + dx;
      let y = mk.p.y * view.k + view.ty + dy;
      if (x < m) dx += m - x; else if (x > r.width - m) dx -= x - (r.width - m);
      if (y < m) dy += m - y; else if (y > r.height - m) dy -= y - (r.height - m);
      x = mk.p.x * view.k + view.tx + dx;
      y = mk.p.y * view.k + view.ty + dy;
      const under = (b) => b && x > b.left - r.left - m && x < b.right - r.left + m && y > b.top - r.top - m && y < b.bottom - r.top + m;
      if (under(pr)) dy += pr.bottom - r.top + m - y;
      if (under(zr)) dx -= x - (zr.left - r.left - m);
    }
    if (!dx && !dy) return;
    const from = { tx: view.tx, ty: view.ty };
    const t0 = performance.now();
    const step = (t) => {
      const f = Math.min(1, (t - t0) / 280);
      const e = 1 - (1 - f) ** 3;
      view.tx = from.tx + dx * e;
      view.ty = from.ty + dy * e;
      render();
      if (f < 1) requestAnimationFrame(step);
    };
    view.auto = false;
    requestAnimationFrame(step);
  }

  // ---------- pointer ----------

  const ptrs = new Map();
  let gesture = null;

  function onDown(e) {
    if (e.button !== undefined && e.button > 0) return;
    try { $('#map').setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    ptrs.set(e.pointerId, pt(e));
    if (ptrs.size === 1) {
      const mk = EDIT && e.target.closest('.mk');
      if (mk) {
        gesture = { type: 'drag', id: mk.dataset.id, moved: false };
        selectEdit(mk.dataset.id);
        return;
      }
      gesture = { type: 'pan', start: pt(e), tx: view.tx, ty: view.ty, moved: false };
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      gesture = {
        type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, k0: view.k,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, tx: view.tx, ty: view.ty,
      };
    }
  }

  function onMove(e) {
    if (!ptrs.has(e.pointerId) || !gesture) return;
    const p = pt(e);
    ptrs.set(e.pointerId, p);
    if (gesture.type === 'pan') {
      const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      gesture.moved = true;
      view.auto = false;
      $('#map').classList.add('dragging');
      view.tx = gesture.tx + dx;
      view.ty = gesture.ty + dy;
      schedule();
    } else if (gesture.type === 'pinch' && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = clamp(gesture.k0 * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0, minK(), MAX_K);
      const f = k / gesture.k0;
      view.k = k;
      view.auto = false;
      view.tx = m.x - (gesture.mid.x - gesture.tx) * f;
      view.ty = m.y - (gesture.mid.y - gesture.ty) * f;
      schedule();
    } else if (gesture.type === 'drag') {
      const m = marks.get(gesture.id);
      [m.p.x, m.p.y] = toWorld(p);
      gesture.moved = true;
      schedule();
    }
  }

  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    const p = pt(e);
    ptrs.delete(e.pointerId);
    const g = gesture;
    if (g && g.type === 'pinch' && ptrs.size === 1) {
      const rest = [...ptrs.values()][0];
      gesture = { type: 'pan', start: rest, tx: view.tx, ty: view.ty, moved: true };
      return;
    }
    if (ptrs.size === 0) {
      gesture = null;
      $('#map').classList.remove('dragging');
      if (g && g.type === 'pan' && !g.moved) tap(p);
      if (g && g.type === 'drag' && g.moved) finishDrag(g.id);
    }
  }

  function nearest(p) {
    const coarse = matchMedia('(pointer: coarse)').matches;
    let best = null, bd = coarse ? 36 : 26;
    for (const m of marks.values()) {
      if (m.g.classList.contains('off')) continue;
      const d = Math.hypot(m.p.x * view.k + view.tx - p.x, m.p.y * view.k + view.ty - p.y);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  function tap(p) {
    const q = state.quiz;
    if (q && q.waiting) { nextQuestion(); return; }
    const m = nearest(p);
    if (state.mode === 'learn') learnTap(m);
    else if (state.mode === 'edit') { if (m) selectEdit(m.p.id); }
    else if (q && !q.done) {
      if (m) answer(m.p.id);
      else hint('Click on a gate marker.');
    }
  }

  // ---------- modes ----------

  function setBase(base) {
    state.base = base === 'satellite' ? 'satellite' : 'chart';
    store.set('base', state.base);
    $('#layer-satellite').style.display = state.base === 'satellite' ? '' : 'none';
    $('#layer-chart').style.display = state.base === 'chart' ? '' : 'none';
    $('#map').classList.toggle('base-satellite', state.base === 'satellite');
    $('#map').classList.toggle('base-chart', state.base === 'chart');
    for (const b of $$('#bases button')) b.setAttribute('aria-pressed', String(b.dataset.base === state.base));
    const credit = airport.layers[state.base].credit;
    // kept to about three lines so the quiz banner hides it completely
    const chart = data.chart.replace(/\s*\(.*\)$/, '');
    $('#credits').innerHTML = `${credit}. Gates and spots per the ${chart}. Flight simulation use only.`;
  }

  function setMode(mode) {
    if (state.quiz) stopQuiz();
    state.mode = mode;
    state.selected = null;
    state.revealed.clear();
    for (const b of $$('#modes button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    $('#modes').hidden = EDIT;
    for (const s of $$('[data-for]')) s.hidden = s.dataset.for !== mode;
    $('#info').hidden = true;
    $('#ten-summary').hidden = true;
    hidePrompt();
    if (mode === 'ten') renderTenStatus();
    if (mode === 'streak') renderStreakStatus();
    if (mode === 'edit') renderEditCount();
    showBoard();
    refreshMarks();
  }

  function refreshAreas() {
    for (const b of $$('#areas button')) {
      const on = b.dataset.area === '*' ? state.areas.size === data.areas.length : state.areas.has(b.dataset.area);
      b.setAttribute('aria-pressed', String(on));
    }
    const pool = poolPoints();
    const gates = pool.filter((p) => p.kind === 'gate').length;
    const spots = pool.length - gates;
    $('#pool-count').textContent = `${gates} gates${spots ? `, ${spots} spots` : ''} selected.`;
    if (state.mode === 'streak') renderStreakStatus();
    if (state.mode === 'ten') renderTenStatus();
    showBoard();
    refreshMarks();
  }

  function lockAreas(locked) {
    for (const b of $$('#areas button')) b.disabled = locked;
  }

  function poolPoints() {
    return data.points.filter((p) => state.areas.has(p.area));
  }

  function refreshMarks() {
    const q = state.quiz;
    const inQuiz = state.mode === 'ten' || state.mode === 'streak';
    $('#marks').classList.toggle('plain', inQuiz || !state.colors);
    for (const { p, g } of marks.values()) {
      const visible = state.mode === 'edit' || state.areas.has(p.area);
      g.classList.toggle('off', !visible);
      let label = false;
      if (state.mode === 'learn') label = state.labels || state.revealed.has(p.id);
      if (state.mode === 'edit') label = true;
      g.classList.toggle('lbl', label);
      g.classList.toggle('sel', state.selected === p.id);
      g.classList.toggle('target', !!(q && q.show && q.show.target === p.id));
      g.classList.toggle('wrong', !!(q && q.show && q.show.wrong === p.id));
      g.classList.toggle('moved', state.mode === 'edit' && state.moved.has(p.id));
    }
    // keep highlighted markers on top
    for (const id of [state.selected, q && q.show && q.show.wrong, q && q.show && q.show.target]) {
      if (id && marks.has(id)) $('#marks').append(marks.get(id).g);
    }
  }

  function describe(p) {
    const a = areaById[p.area];
    if (p.kind === 'spot') return `Spot ${p.id}, ramp reporting point`;
    return `Gate ${p.id}, ${a.name}, ${a.terminal}`;
  }

  // ---------- learn ----------

  function learnTap(m) {
    if (!m) {
      state.selected = null;
      $('#info').hidden = true;
      refreshMarks();
      return;
    }
    const id = m.p.id;
    if (!state.labels) {
      if (state.revealed.has(id)) state.revealed.delete(id); else state.revealed.add(id);
    }
    state.selected = id;
    const a = areaById[m.p.area];
    $('#info').hidden = false;
    $('#info').innerHTML = m.p.kind === 'spot'
      ? `<div class="id">Spot ${m.p.id}</div><div>Ramp reporting point (blue numbered box)</div>`
      : `<div class="id">${m.p.id}</div><div>${a.name}</div><div class="hint">${a.terminal}</div>`;
    refreshMarks();
  }

  // ---------- quiz ----------

  function poolKey() { return [...state.areas].sort().join(','); }

  function startQuiz(kind) {
    const pool = poolPoints();
    if (!pool.length) return;
    if (state.quiz) clearInterval(state.quiz.timer);
    const q = {
      kind, pool, poolKey: poolKey(), answers: [], t0: performance.now(), waiting: false, done: false,
      locked: false, recent: [], streak: 0, lastOk: 0, show: null, target: null,
    };
    if (kind === 'ten') q.queue = shuffle(pool.slice()).slice(0, Math.min(TEN, pool.length));
    state.quiz = q;
    board.pending = null;
    startRun(q);
    // a focused Start button would eat Space (our "next" key) and restart
    if (document.activeElement) document.activeElement.blur();
    lockAreas(true);
    $('#ten-summary').hidden = true;
    $(`#${kind}-start`).textContent = 'Restart';
    q.timer = setInterval(kind === 'ten' ? renderTenStatus : renderStreakStatus, 250);
    showBoard();
    nextQuestion();
  }

  function stopQuiz() {
    const q = state.quiz;
    if (q) clearInterval(q.timer);
    board.pending = null;
    state.quiz = null;
    lockAreas(false);
    $('#ten-start').textContent = 'Start';
    $('#streak-start').textContent = 'Start';
  }

  function nextQuestion() {
    const q = state.quiz;
    if (!q) return;
    q.waiting = false;
    q.show = null;
    if (q.kind === 'ten') {
      if (q.answers.length >= q.queue.length) { finishTen(); return; }
      q.target = q.queue[q.answers.length].id;
    } else {
      const avoid = new Set(q.recent);
      const cand = q.pool.filter((p) => !avoid.has(p.id));
      const pick = (cand.length ? cand : q.pool)[Math.floor(Math.random() * (cand.length || q.pool.length))];
      q.target = pick.id;
      q.recent.push(q.target);
      const keep = Math.min(20, Math.floor(q.pool.length / 2));
      while (q.recent.length > keep) q.recent.shift();
    }
    showAsk();
    refreshMarks();
    if (q.kind === 'ten') renderTenStatus(); else renderStreakStatus();
  }

  function noun(id) {
    const m = marks.get(id);
    return m && m.p.kind === 'spot' ? 'Spot' : 'Gate';
  }
  // "Spot 5A" for spots, plain "C5" for gates
  function name(id) {
    return noun(id) === 'Spot' ? `Spot ${id}` : id;
  }

  // The banner under the nav. tone: 'ask' (blue), 'ok' (green), 'bad' (red).
  function showPrompt(html, tone = 'ask') {
    const el = $('#prompt');
    el.innerHTML = html;
    el.classList.toggle('ok', tone === 'ok');
    el.classList.toggle('bad', tone === 'bad');
    el.classList.add('show');
  }
  function hidePrompt() {
    $('#prompt').classList.remove('show', 'ok', 'bad');
  }

  function showAsk(sub) {
    const q = state.quiz;
    let progress = '';
    if (q.kind === 'ten') progress = `Question ${Math.min(q.answers.length + 1, q.queue.length)} of ${q.queue.length}`;
    else progress = `Streak ${q.streak}`;
    showPrompt(`<div class="ask">Find ${noun(q.target)} <b>${q.target}</b></div><div class="sub">${sub || progress}</div>`);
  }

  function hint(text) {
    if (state.quiz && !state.quiz.waiting && !state.quiz.done) showAsk(text);
  }

  function answer(id) {
    const q = state.quiz;
    if (!q || q.done || q.locked || q.waiting) return;
    const ok = id === q.target;
    q.answers.push({ target: q.target, clicked: id, ok });
    if (ok) {
      q.streak += 1;
      q.lastOk = performance.now();
      q.show = { target: q.target };
      q.locked = true;
      showPrompt(`<div class="ask"><span class="good">Correct</span>, that's <b>${name(q.target)}</b></div>`
        + `<div class="sub">${q.kind === 'ten' ? `${q.answers.filter((a) => a.ok).length} of ${q.answers.length} so far` : `Streak ${q.streak}`}</div>`, 'ok');
      refreshMarks();
      if (q.kind === 'streak') renderStreakStatus();
      setTimeout(() => {
        if (state.quiz !== q) return;
        q.locked = false;
        nextQuestion();
      }, CORRECT_MS);
      return;
    }

    q.show = { target: q.target, wrong: id };
    refreshMarks();
    requestAnimationFrame(() => ensureVisible([q.target, id]));
    if (q.kind === 'streak') {
      q.done = true;
      clearInterval(q.timer);
      // the clock stops at the last correct answer, not at the miss
      q.ms = q.streak ? Math.round(q.lastOk - q.t0) : 0;
      endRun(q);
      offerEntry(q, { score: q.streak, ms: q.ms });
      lockAreas(false);
      const key = `best.${poolKey()}`;
      const best = store.get(key, 0);
      const isBest = q.streak > best;
      if (isBest) store.set(key, q.streak);
      showPrompt(`<div class="ask"><span class="miss">Missed.</span> You clicked <b>${name(id)}</b></div>`
        + `<div class="sub">${name(q.target)} is in green. Streak over at ${q.streak}${isBest ? ', a new best' : ''}.</div>`, 'bad');
      $('#streak-start').textContent = 'Play again';
      renderStreakStatus();
      return;
    }
    q.waiting = true;
    showPrompt(`<div class="ask"><span class="miss">Missed.</span> You clicked <b>${name(id)}</b></div>`
      + `<div class="sub">${name(q.target)} is in green. Tap the map or press Space to go on.</div>`, 'bad');
  }

  function finishTen() {
    const q = state.quiz;
    q.done = true;
    clearInterval(q.timer);
    q.elapsed = performance.now() - q.t0;
    endRun(q);
    lockAreas(false);
    const right = q.answers.filter((a) => a.ok).length;
    offerEntry(q, { score: right, of: q.answers.length, ms: Math.round(q.elapsed) });
    const pct = Math.round((100 * right) / q.answers.length);
    const key = `ten.${poolKey()}`;
    const prev = store.get(key, null);
    let note = '';
    if (!prev || right > prev.right || (right === prev.right && q.elapsed < prev.ms)) {
      store.set(key, { right, of: q.answers.length, ms: q.elapsed });
      note = prev ? 'New personal best for these areas.' : '';
    }
    const misses = q.answers.filter((a) => !a.ok);
    const s = $('#ten-summary');
    s.hidden = false;
    s.innerHTML = `<div class="score">${pct}%</div><div>${right} of ${q.answers.length} correct in ${fmtTime(q.elapsed)}</div>`
      + (note ? `<p class="hint">${note}</p>` : '')
      + (misses.length ? `<ul>${misses.map((a) => `<li>Asked <b>${name(a.target)}</b>, clicked ${name(a.clicked)}</li>`).join('')}</ul>` : '<p class="hint">Perfect round.</p>');
    showPrompt(`<div class="ask">Score <b>${pct}%</b></div><div class="sub">${right} of ${q.answers.length} in ${fmtTime(q.elapsed)}</div>`,
      right === q.answers.length ? 'ok' : 'ask');
    q.show = null;
    $('#ten-start').textContent = 'Play again';
    renderTenStatus();
    refreshMarks();
  }

  function renderTenStatus() {
    const q = state.quiz && state.quiz.kind === 'ten' ? state.quiz : null;
    const best = store.get(`ten.${poolKey()}`, null);
    const bestTxt = best ? `${Math.round((100 * best.right) / best.of)}% in ${fmtTime(best.ms)}` : 'none yet';
    if (!q) {
      $('#ten-status').innerHTML = `<div class="row"><span>Best for these areas</span><b>${bestTxt}</b></div>`;
      return;
    }
    const right = q.answers.filter((a) => a.ok).length;
    const ms = q.done ? q.elapsed : performance.now() - q.t0;
    $('#ten-status').innerHTML = `<div class="big">${right} / ${q.answers.length}</div>`
      + `<div class="row"><span>Question</span><b>${Math.min(q.answers.length + (q.done ? 0 : 1), q.queue.length)} of ${q.queue.length}</b></div>`
      + `<div class="row"><span>Time</span><b>${fmtTime(ms)}</b></div>`
      + `<div class="row"><span>Best for these areas</span><b>${bestTxt}</b></div>`;
  }

  function renderStreakStatus() {
    const q = state.quiz && state.quiz.kind === 'streak' ? state.quiz : null;
    const best = store.get(`best.${poolKey()}`, 0);
    const ms = !q ? 0 : q.done ? q.ms : performance.now() - q.t0;
    $('#streak-status').innerHTML = `<div class="big">${q ? q.streak : 0}</div>`
      + (q ? `<div class="row"><span>Time</span><b>${fmtTime(ms)}</b></div>` : '')
      + `<div class="row"><span>Best for these areas</span><b>${best}</b></div>`;
  }

  // ---------- leaderboard ----------
  //
  // Top 10 per challenge mode and set of areas, kept in Firestore (rules in
  // firestore.rules). The page calls Firestore's REST API with fetch, so
  // there's still no library to load. Add ?emulator (or ?emulator=PORT) to
  // the URL to use the local Firestore emulator instead.

  const NAME_OK = /^[A-Z0-9_]{1,6}$/;
  const NAME_RUDE = /(FUCK|SHIT|CUNT|COCK|TWAT|SLUT|WHORE|FAG|NIGG|NAZI|PORN|PUSSY)/; // same list as the rules
  const BOARD_TTL = 30000; // ms to reuse a fetched board before fetching it again

  function setupBoard() {
    const cfg = airport.leaderboard || {};
    const emu = new URLSearchParams(location.search).get('emulator');
    const project = emu !== null ? 'demo-ksfo' : cfg.projectId;
    if (!project || EDIT) return;
    const host = emu !== null ? `http://127.0.0.1:${emu || 8085}` : 'https://firestore.googleapis.com';
    board.docs = `projects/${project}/databases/(default)/documents`;
    board.url = `${host}/v1/${board.docs}`;
    board.apiKey = emu !== null ? '' : cfg.apiKey || '';
    board.icao = airport.icao;
    board.emu = emu !== null;

    const sec = $('#board');
    sec.addEventListener('input', (e) => {
      if (e.target.id !== 'board-name' || !board.pending) return;
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 6);
      board.pending.typed = e.target.value;
    });
    sec.addEventListener('keydown', (e) => {
      if (e.target.id !== 'board-name') return;
      if (e.key === 'Enter') { e.preventDefault(); submitEntry(); }
      if (e.key === 'Escape') { e.preventDefault(); skipEntry(); }
    });
    sec.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { adminDeleteOne(del.dataset.del); return; }
      const b = e.target.closest('[data-act]');
      const act = b && b.dataset.act;
      if (act === 'save') submitEntry();
      if (act === 'skip') skipEntry();
      if (act === 'signin') adminSignIn(b.dataset.provider);
      if (act === 'signout') admin.sdk.signOut(admin.auth);
      if (act === 'copy-uid') navigator.clipboard.writeText(admin.user.uid).then(() => { admin.note = 'Copied.'; renderAdmin(); });
      if (act === 'clear') adminClear(false);
      if (act === 'clear-all') adminClear(true);
    });
    if (ADMIN) setupAdmin();
  }

  const fsStr = (v) => ({ stringValue: v });
  const fsInt = (v) => ({ integerValue: String(v) });
  const docName = (coll, id) => `${board.docs}/airports/${board.icao}/${coll}/${id}`;

  // token: a Firebase Auth ID token, for the admin view's reads and deletes
  async function fsCall(path, body, token) {
    const key = board.apiKey ? `?key=${encodeURIComponent(board.apiKey)}` : '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`${board.url}${path}${key}`, {
      method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Firestore ${r.status}`);
    return r.json();
  }
  const commit = (writes) => fsCall(':commit', { writes });

  function newId() {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => abc[b % abc.length]).join('');
  }

  // Every challenge gets a run record; Firestore stamps when it started and
  // ended, and the rules check a posted time against those stamps.
  function startRun(q) {
    if (!board.url) return;
    const id = newId();
    q.run = {
      id,
      started: commit([{
        update: { name: docName('runs', id), fields: { mode: fsStr(q.kind), pool: fsStr(q.poolKey), used: { booleanValue: false } } },
        updateTransforms: [{ fieldPath: 'startedAt', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: false },
      }]).then(() => true, () => false),
    };
  }

  function endRun(q) {
    if (!q.run) return;
    q.run.ended = q.run.started.then((ok) => ok && commit([{
      update: { name: docName('runs', q.run.id), fields: {} },
      updateMask: { fieldPaths: [] },
      updateTransforms: [{ fieldPath: 'endedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: true },
    }]).then(() => true, () => false));
  }

  async function postScore(q, entry) {
    if (!(await q.run.ended)) throw new Error('run not recorded');
    const fields = {
      name: fsStr(entry.name), mode: fsStr(q.kind), pool: fsStr(q.poolKey),
      score: fsInt(entry.score), ms: fsInt(entry.ms),
    };
    if (q.kind === 'ten') fields.of = fsInt(entry.of);
    await commit([
      {
        update: { name: docName('scores', q.run.id), fields },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: false },
      },
      {
        update: { name: docName('runs', q.run.id), fields: { used: { booleanValue: true } } },
        updateMask: { fieldPaths: ['used'] },
        currentDocument: { exists: true },
      },
    ]);
  }

  // Quick 10: percent (right answers, since every round asks the same
  // number), then time. Streak: count, then time. Earlier posts win ties.
  async function fetchBoard(mode, pool) {
    const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: fsStr(value) } });
    const by = (field, direction) => ({ field: { fieldPath: field }, direction });
    const res = await fsCall(`/airports/${board.icao}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'scores' }],
        where: { compositeFilter: { op: 'AND', filters: [eq('mode', mode), eq('pool', pool)] } },
        orderBy: [by('score', 'DESCENDING'), by('ms', 'ASCENDING'), by('at', 'ASCENDING')],
        limit: 10,
      },
    });
    return res.filter((x) => x.document).map(({ document: d }) => ({
      id: d.name.split('/').pop(),
      name: NAME_OK.test(d.fields.name.stringValue) ? d.fields.name.stringValue : '?',
      score: Number(d.fields.score.integerValue),
      of: d.fields.of ? Number(d.fields.of.integerValue) : 0,
      ms: Number(d.fields.ms.integerValue),
    }));
  }

  async function loadBoard(mode, pool, fresh = false) {
    const key = `${mode}|${pool}`;
    const hit = board.cache.get(key);
    if (hit && !fresh && Date.now() - hit.t < BOARD_TTL) return hit.rows;
    const rows = await fetchBoard(mode, pool);
    board.cache.set(key, { rows, t: Date.now() });
    return rows;
  }

  const beats = (a, b) => a.score > b.score || (a.score === b.score && a.ms < b.ms);

  function poolLabel(key) {
    const ids = key.split(',');
    const all = data.areas.filter((a) => a.id !== 'spots').map((a) => a.id);
    const gates = ids.filter((id) => id !== 'spots');
    const spots = ids.includes('spots');
    if (gates.length === all.length) return spots ? 'All gates and spots' : 'All gates';
    if (!gates.length) return 'Spots only';
    return `${gates.length === 1 ? 'Area' : 'Areas'} ${gates.join(', ')}${spots ? ' + spots' : ''}`;
  }

  // After a challenge: if the score makes the top 10, open a name entry row.
  async function offerEntry(q, entry) {
    if (!q.run || entry.score < 1) return;
    let rows;
    try {
      rows = await loadBoard(q.kind, q.poolKey, true);
    } catch {
      showBoard();
      return;
    }
    if (state.quiz !== q) return; // restarted or left the mode meanwhile
    let rank = rows.findIndex((r) => beats(entry, r));
    if (rank < 0) rank = rows.length;
    if (rank < 10) {
      board.pending = { q, entry, rank, typed: null, focus: true };
      $('#prompt').insertAdjacentHTML('beforeend',
        `<div class="sub hs">New high score: number ${rank + 1} on the LEADERBOARD. Enter your name there.</div>`);
    }
    showBoard();
  }

  async function submitEntry() {
    const p = board.pending;
    const input = $('#board-name');
    if (!p || p.saving || !input) return;
    const name = input.value;
    if (!NAME_OK.test(name)) { boardNote('Use 1 to 6 letters, digits or _.'); return; }
    if (NAME_RUDE.test(name)) { boardNote('Please pick another name.'); return; }
    p.saving = true;
    input.disabled = true;
    boardNote('Saving...');
    try {
      await postScore(p.q, { ...p.entry, name });
    } catch {
      p.saving = false;
      input.disabled = false;
      input.focus();
      boardNote("Couldn't save your score. Press Enter to try again.");
      return;
    }
    store.set('name', name);
    board.pending = null;
    board.mine = p.q.run.id;
    board.cache.delete(`${p.q.kind}|${p.q.poolKey}`);
    showBoard();
  }

  function skipEntry() {
    board.pending = null;
    showBoard();
  }

  function boardNote(text) { $('#board-note').textContent = text; }

  // Shows the board for a pending entry, else for the mode and areas now.
  async function showBoard() {
    const sec = $('#board');
    const mode = state.mode === 'ten' || state.mode === 'streak' ? state.mode : null;
    sec.hidden = !board.url || !mode;
    if (sec.hidden) return;
    const p = board.pending;
    const [kind, pool] = p ? [p.q.kind, p.q.poolKey] : [mode, poolKey()];
    const want = `${kind}|${pool}`;
    board.showing = want;
    $('#board-sub').textContent = `${kind === 'ten' ? 'Quick 10' : 'Streak'}: ${poolLabel(pool)}`;
    let rows = null;
    try { rows = await loadBoard(kind, pool); } catch { /* offline */ }
    if (board.showing !== want) return; // a newer call took over
    renderBoard(rows, kind);
  }

  function renderBoard(rows, kind) {
    const p = board.pending;
    $('#board-actions').hidden = !p;
    if (!rows) {
      $('#board-list').innerHTML = '';
      boardNote('The leaderboard is offline right now.');
      return;
    }
    const shown = rows.slice();
    if (p) shown.splice(p.rank, 0, { ...p.entry, pending: true });
    const score = (r) => (kind === 'ten' ? `${Math.round((100 * r.score) / (r.of || TEN))}%` : String(r.score));
    const cells = (i, name, r) => `<span class="rk">${i + 1}</span>${name}`
      + `<span class="sc">${r ? score(r) : ''}</span><span class="tm">${r ? fmtTenths(r.ms) : ''}</span>`;
    let html = '';
    for (let i = 0; i < 10; i++) {
      const r = shown[i];
      if (!r) {
        html += `<li class="empty">${cells(i, '<span class="nm">------</span>')}</li>`;
      } else if (r.pending) {
        const value = (p.typed ?? store.get('name', '')).replace(/[^A-Z0-9_]/g, '').slice(0, 6);
        html += `<li class="new r${i + 1}">${cells(i, `<input id="board-name" class="nm" maxlength="6" value="${value}"`
          + ` autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Your name for the leaderboard">`, r)}</li>`;
      } else {
        const del = admin.is ? `<button type="button" class="del" data-del="${r.id}" title="Delete this score" aria-label="Delete ${r.name}'s score">&times;</button>` : '';
        html += `<li class="r${i + 1}${r.id === board.mine ? ' mine' : ''}">${cells(i, `<span class="nm">${r.name}</span>`, r)}${del}</li>`;
      }
    }
    $('#board').classList.toggle('admin', admin.is);
    board.rows = rows;
    $('#board-list').innerHTML = html;
    if (p) {
      boardNote('Your score made the board. Type a name, up to 6 letters, digits or _, then press Enter.');
      const input = $('#board-name');
      if (p.saving) input.disabled = true;
      if (p.focus) { p.focus = false; input.focus(); input.select(); }
    } else {
      boardNote(rows.length ? `Ranked by ${kind === 'ten' ? 'percent' : 'streak'}, then time.` : 'No scores yet. Be the first.');
    }
  }

  // ---------- leaderboard admin (?admin) ----------
  //
  // Sign in (Google or GitHub); if Firestore has admins/{your user ID}, you get a
  // delete button on each score plus "Clear this board" and "Clear all
  // boards". The rules enforce the same check, so the page can't be talked
  // into deleting for anyone else. Admins are added in the Firebase console.

  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  async function setupAdmin() {
    $('#board-admin').hidden = false;
    if (board.emu) { admin.busy = 'The admin view works with the live leaderboard only (leave off ?emulator).'; renderAdmin(); return; }
    admin.busy = 'Loading Google sign-in...';
    renderAdmin();
    try {
      const [{ initializeApp }, sdk] = await Promise.all([
        import(`${FIREBASE_SDK}/firebase-app.js`), import(`${FIREBASE_SDK}/firebase-auth.js`),
      ]);
      const cfg = airport.leaderboard;
      admin.sdk = sdk;
      admin.auth = sdk.getAuth(initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId }));
      sdk.onAuthStateChanged(admin.auth, async (user) => {
        admin.user = user;
        admin.is = false;
        admin.note = '';
        admin.busy = user ? 'Checking...' : '';
        renderAdmin();
        if (user) {
          try { await fsCall(`/admins/${user.uid}`, undefined, await user.getIdToken()); admin.is = true; } catch { /* not an admin */ }
          admin.busy = '';
        }
        renderAdmin();
        showBoard();
      });
    } catch {
      admin.busy = "Couldn't load Google sign-in.";
      renderAdmin();
    }
  }

  // Sign-in methods offered, from airport.json leaderboard.signIn. Each
  // must also be turned on in Firebase (Authentication, Sign-in method).
  const SIGN_IN = {
    google: { label: 'Google', provider: (sdk) => new sdk.GoogleAuthProvider() },
    github: { label: 'GitHub', provider: (sdk) => new sdk.GithubAuthProvider() },
  };
  const signInMethods = () => (airport.leaderboard.signIn || ['google']).filter((m) => SIGN_IN[m]);

  async function adminSignIn(method) {
    if (!SIGN_IN[method]) return;
    try {
      await admin.sdk.signInWithPopup(admin.auth, SIGN_IN[method].provider(admin.sdk));
    } catch (err) {
      const code = (err && err.code) || 'unknown';
      admin.note = code === 'auth/unauthorized-domain'
        ? `This site (${location.hostname}) isn't on the Firebase sign-in list yet: Authentication, Settings, Authorized domains.`
        : code === 'auth/account-exists-with-different-credential'
          ? 'That email already signs in another way. Use the method you signed in with before.'
          : code === 'auth/popup-closed-by-user' ? '' : `Sign-in failed (${code}).`;
      renderAdmin();
    }
  }

  function renderAdmin() {
    const box = $('#board-admin');
    if (box.hidden) return;
    const u = admin.user;
    let html = '<div class="admin-title">Admin</div>';
    if (admin.busy) {
      html += `<p class="hint">${escHtml(admin.busy)}</p>`;
    } else if (!u) {
      html += signInMethods().map((m) =>
        `<button type="button" class="ghost" data-act="signin" data-provider="${m}">Sign in with ${SIGN_IN[m].label}</button>`).join('');
    } else if (!admin.is) {
      html += `<p class="hint">${escHtml(u.email || 'This account')} isn't an admin. To make it one, add a document named with this user ID to the <code>admins</code> collection in the Firebase console:</p>`
        + `<p class="uid"><code>${escHtml(u.uid)}</code></p>`
        + '<div class="board-actions"><button type="button" class="ghost" data-act="copy-uid">Copy user ID</button>'
        + '<button type="button" class="ghost" data-act="signout">Sign out</button></div>';
    } else {
      html += `<p class="hint">Signed in as ${escHtml(u.email || u.displayName || 'admin')}. Use &times; to delete one score.</p>`
        + '<div class="board-actions"><button type="button" class="ghost danger" data-act="clear">Clear this board</button>'
        + '<button type="button" class="ghost danger" data-act="clear-all">Clear all boards</button></div>'
        + '<button type="button" class="ghost" data-act="signout">Sign out</button>';
    }
    if (admin.note) html += `<p class="hint admin-note">${escHtml(admin.note)}</p>`;
    box.innerHTML = html;
  }

  // Deletes every score matching `filters` (every board when empty), 500 at a time.
  async function deleteScores(filters) {
    let total = 0;
    for (;;) {
      const token = await admin.user.getIdToken();
      const query = { from: [{ collectionId: 'scores' }], select: { fields: [{ fieldPath: '__name__' }] }, limit: 500 };
      if (filters.length) query.where = { compositeFilter: { op: 'AND', filters } };
      const res = await fsCall(`/airports/${board.icao}:runQuery`, { structuredQuery: query }, token);
      const names = res.filter((x) => x.document).map((x) => x.document.name);
      if (!names.length) return total;
      await fsCall(':commit', { writes: names.map((name) => ({ delete: name })) }, token);
      total += names.length;
    }
  }

  async function adminClear(all) {
    if (!admin.is || admin.busy) return;
    const [kind, pool] = board.showing.split('|');
    const what = all
      ? `every score on every ${board.icao} board (Quick 10 and Streak, every set of areas)`
      : `every score on the ${kind === 'ten' ? 'Quick 10' : 'Streak'} board for ${poolLabel(pool)}`;
    if (all) {
      if (prompt(`This deletes ${what}. It can't be undone.\n\nType CLEAR to go ahead.`) !== 'CLEAR') return;
    } else if (!confirm(`Delete ${what}? This can't be undone.`)) {
      return;
    }
    const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: fsStr(value) } });
    admin.busy = 'Deleting...';
    renderAdmin();
    try {
      const n = await deleteScores(all ? [] : [eq('mode', kind), eq('pool', pool)]);
      admin.note = `Deleted ${n} score${n === 1 ? '' : 's'}.`;
    } catch {
      admin.note = "Couldn't delete; some scores may be left. Try again.";
    }
    admin.busy = '';
    board.cache.clear();
    renderAdmin();
    showBoard();
  }

  async function adminDeleteOne(id) {
    if (!admin.is || admin.busy) return;
    const r = (board.rows || []).find((x) => x.id === id);
    if (!r || !confirm(`Delete ${r.name}'s score (${fmtTenths(r.ms)})? This can't be undone.`)) return;
    try {
      await fsCall(':commit', { writes: [{ delete: docName('scores', id) }] }, await admin.user.getIdToken());
      admin.note = `Deleted ${r.name}'s score.`;
    } catch {
      admin.note = "Couldn't delete that score.";
    }
    board.cache.clear();
    renderAdmin();
    showBoard();
  }

  // ---------- edit ----------

  function selectEdit(id) {
    state.selected = id;
    const m = marks.get(id);
    const [lat, lon] = proj.from(m.p.x, m.p.y);
    $('#edit-info').innerHTML = `<div class="id">${id}</div><div>${lat.toFixed(7)}, ${lon.toFixed(7)}</div>`
      + `<div class="hint">${describe(m.p)}${state.moved.has(id) ? ' (moved)' : ''}</div>`;
    refreshMarks();
  }

  function finishDrag(id) {
    const m = marks.get(id);
    [m.p.lat, m.p.lon] = proj.from(m.p.x, m.p.y).map((v) => Math.round(v * 1e7) / 1e7);
    m.p.src = 'edited';
    state.moved.add(id);
    selectEdit(id);
    renderEditCount();
  }

  function renderEditCount() {
    $('#edit-count').textContent = state.moved.size
      ? `${state.moved.size} moved: ${[...state.moved].join(', ')}`
      : 'No changes yet.';
  }

  function exportGates() {
    const out = {
      ...data,
      points: data.points.map(({ x, y, ...rest }) => rest),
    };
    const blob = new Blob([JSON.stringify(out, null, 1) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gates.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  init().catch((err) => {
    $('#loading').textContent = `Could not load the map data (${err.message}). Serve this folder over http, for example: python -m http.server`;
    console.error(err);
  });
})();
