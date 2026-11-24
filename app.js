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
    const q = {
      kind, pool, answers: [], t0: performance.now(), waiting: false, done: false,
      locked: false, recent: [], streak: 0, show: null, target: null,
    };
    if (kind === 'ten') q.queue = shuffle(pool.slice()).slice(0, Math.min(TEN, pool.length));
    state.quiz = q;
    // a focused Start button would eat Space (our "next" key) and restart
    if (document.activeElement) document.activeElement.blur();
    lockAreas(true);
    $('#ten-summary').hidden = true;
    $(`#${kind}-start`).textContent = 'Restart';
    if (kind === 'ten') {
      clearInterval(q.timer);
      q.timer = setInterval(renderTenStatus, 250);
    }
    nextQuestion();
  }

  function stopQuiz() {
    const q = state.quiz;
    if (q) clearInterval(q.timer);
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
    lockAreas(false);
    const right = q.answers.filter((a) => a.ok).length;
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
    $('#streak-status').innerHTML = `<div class="big">${q ? q.streak : 0}</div>`
      + `<div class="row"><span>Best for these areas</span><b>${best}</b></div>`;
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
