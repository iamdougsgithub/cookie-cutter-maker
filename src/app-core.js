import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEFAULTS, MM_PER_IN, signedArea, bbox } from './geometry.js';
import { candidateAt, centerlineOf } from './contours.js';
import { curvePoints, nodesFromContour } from './trace.js';
import { createTraceEditor } from './trace-editor.js';
import { loadOpenCV, toWorkingCanvas, detect, findInk } from './vision.js';
import { letteringOutline } from './lettering.js';
import { renderShared } from './shared-markup.js';

/**
 * Shared page logic. `product` describes what this page makes:
 *   id          'blank' | 'cutter'
 *   noun        shown in messages ('blank', 'cutter')
 *   defaults    { [dimKey]: mm } for its own [data-dim] inputs
 *   build(pts, settings)  -> { overlayPx, mesh, validation, stl() }
 *   fileName(settings, name) -> string
 *   okNote(result)        -> extra text for the "print-ready" line ('' for none)
 *   render?(settings, result) -> optional: update page-specific extras after a rebuild
 */
export function startApp(product) {
  renderShared(product.id);

  const STORE = { photo: 'pcm.photo', settings: 'pcm.settings', trace: 'pcm.trace' };
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* full or blocked: fine */ } },
  };

  const $ = (id) => document.getElementById(id);
  const dimInputs = [...document.querySelectorAll('[data-dim]')];
  const textInputs = [...document.querySelectorAll('[data-text]')];
  const els = {
    cvStatus: $('cvStatus'), drop: $('drop'), dropEmpty: $('dropEmpty'), overlay: $('overlay'),
    pickHint: $('pickHint'), photoActions: $('photoActions'),
    traceBtn: $('traceBtn'), traceBar: $('traceBar'), traceHint: $('traceHint'), traceUsing: $('traceUsing'),
    traceUndo: $('traceUndo'), traceDelete: $('traceDelete'), traceCorner: $('traceCorner'),
    traceZoomIn: $('traceZoomIn'), traceZoomOut: $('traceZoomOut'), traceFit: $('traceFit'),
    traceClear: $('traceClear'), traceDone: $('traceDone'), traceEdit: $('traceEdit'), traceAuto: $('traceAuto'),
    loadProblem: $('loadProblem'), loadProblemText: $('loadProblemText'), loadProblemTrace: $('loadProblemTrace'),
    modeNote: $('modeNote'), edgeField: $('edgeField'),
    borderField: $('borderField'), border: $('border'), borderOut: $('borderOut'),
    threshold: $('threshold'), thresholdAuto: $('thresholdAuto'), thresholdOut: $('thresholdOut'),
    smooth: $('smooth'), smoothOut: $('smoothOut'), notches: $('notches'), notchesOut: $('notchesOut'),
    size: $('size'), mirror: $('mirror'),
    rotation: $('rotation'), rotationOut: $('rotationOut'), rotL: $('rotL'), rotR: $('rotR'),
    viewer: $('viewer'), viewerEmpty: $('viewerEmpty'), resetView: $('resetView'),
    dimsIn: $('dimsIn'), dimsMm: $('dimsMm'), volume: $('volume'), tris: $('tris'),
    validation: $('validation'), name: $('name'), download: $('download'), filename: $('filename'),
  };

  const state = {
    cv: null,
    image: null,       // HTMLImageElement
    work: null,        // working canvas
    det: null,         // detection result
    sel: 0,            // selected candidate
    result: null,      // product.build result
    error: null,
    // Hand-traced outline (photo pixels). source 'trace' uses it instead of detection.
    trace: { source: 'auto', nodes: [], closed: false },
    settings: {
      mode: 'auto', edge: 'center', threshold: null, smoothness: DEFAULTS.smoothness,
      notchWidthMM: DEFAULTS.notchWidthMM, sizeMM: DEFAULTS.sizeMM, borderPct: 6,
      units: 'in', mirror: false, rotationDeg: 0,
      ...product.defaults,
    },
  };

  // Settings carry over between the blank and cutter pages (same tab only).
  // Bump when product defaults change meaning (v4: cutter lip and side text), so stale
  // product dimensions aren't restored; outline settings always carry over.
  const SETTINGS_VERSION = 4;
  try {
    const saved = JSON.parse(store.get(STORE.settings) || '{}');
    if (saved.v !== SETTINGS_VERSION) for (const k of Object.keys(product.defaults)) delete saved[k];
    delete saved.v;
    Object.assign(state.settings, saved);
  } catch { /* ignore */ }
  const saveSettings = () => store.set(STORE.settings, JSON.stringify({ ...state.settings, v: SETTINGS_VERSION }));
  try { Object.assign(state.trace, JSON.parse(store.get(STORE.trace) || '{}')); } catch { /* ignore */ }
  const saveTrace = () => store.set(STORE.trace, JSON.stringify(state.trace));

  // ------------------------------------------------------------------ helpers

  const fmt = (v, d) => Number(v.toFixed(d)).toString();
  const toUnit = (mm) => (state.settings.units === 'in' ? mm / MM_PER_IN : mm);
  const fromUnit = (v) => (state.settings.units === 'in' ? v * MM_PER_IN : v);
  const effectiveMode = () => (state.settings.mode === 'auto' ? state.det?.detectedMode ?? 'cutter' : state.settings.mode);
  const lettering = () => state.settings.mode === 'lettering';

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function setStatus(text, isErr = false) {
    els.cvStatus.textContent = text;
    els.cvStatus.classList.toggle('err', isErr);
  }

  // ------------------------------------------------------------------ 3D preview

  // The 3D view needs WebGL. Some browsers have it switched off (Edge without graphics
  // acceleration, locked-down PCs); then fall back to a still preview drawn without it,
  // so the rest of the app — photos, tracing, downloads — still works.
  const viewer = (() => {
    try {
      return createWebGLViewer();
    } catch (e) {
      console.warn('3D view unavailable, using the simple preview:', e);
      return createFlatViewer();
    }
  })();

  function createWebGLViewer() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    els.viewer.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 4 / 3, 1, 2000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.49;

    scene.add(new THREE.HemisphereLight(0xfffaf0, 0xb9ab98, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(80, 160, 110);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 6;
    Object.assign(key.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 10, far: 500 });
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xfff0e0, 0.6);
    fill.position.set(-120, 60, -80);
    scene.add(fill);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.ShadowMaterial({ opacity: 0.16 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const material = new THREE.MeshStandardMaterial({ color: 0xf3ead6, roughness: 0.62, metalness: 0 });
    let mesh = null, fitted = 0;

    function resize() {
      const { clientWidth: w, clientHeight: h } = els.viewer;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(els.viewer);

    function fit() {
      if (!mesh) return;
      const box = new THREE.Box3().setFromObject(mesh);
      const r = box.getBoundingSphere(new THREE.Sphere()).radius;
      const d = r / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
      camera.position.set(0, d * 0.78, d * 0.62);
      controls.target.set(0, box.max.y * 0.3, 0);
      controls.update();
      fitted = r;
    }

    function show(result) {
      if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh = null; }
      if (!result) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(result.mesh.positions), 3));
      g.setIndex(new THREE.BufferAttribute(result.mesh.indices, 1));
      g.rotateX(-Math.PI / 2); // model z-up -> three y-up (as printed)
      // Faces more than 20° apart shade separately, so edges like the cutter's bevel read.
      const shaded = toCreasedNormals(g, Math.PI / 9);
      g.dispose();
      mesh = new THREE.Mesh(shaded, material);
      mesh.castShadow = true;
      scene.add(mesh);
      const r = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere()).radius;
      if (!fitted || Math.abs(r - fitted) / fitted > 0.25) fit();
    }

    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    resize();
    return { show, fit, camera, controls };
  }

  /**
   * Still preview without WebGL: the model's triangles drawn on a 2D canvas from above and in
   * front, back faces skipped, painted far-to-near and shaded by a fixed light.
   */
  function createFlatViewer() {
    const canvas = document.createElement('canvas');
    canvas.className = 'flat-view';
    els.viewer.appendChild(canvas);
    els.viewer.insertAdjacentHTML('beforeend', `<p class="viewer-note"><b>Simple preview:</b> this browser has WebGL (3D graphics) switched off, so the 3D view can’t run. Downloads are unaffected. In Microsoft Edge, turn on <i>Settings → System and performance → Use graphics acceleration when available</i>, then restart Edge.</p>`);
    els.resetView.hidden = true;
    let current = null;
    const elev = (35 * Math.PI) / 180, ce = Math.cos(elev), se = Math.sin(elev);
    const light = (() => { const v = [-0.35, -0.55, 0.9], l = Math.hypot(...v); return v.map((c) => c / l); })();

    function draw() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(1, Math.round(els.viewer.clientWidth * dpr)), H = Math.max(1, Math.round(els.viewer.clientHeight * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      if (!current) return;
      const P = current.mesh.positions, I = current.mesh.indices, n = P.length / 3;
      // Screen x = model x; screen up mixes depth (y) and height (z) for a view from above-front.
      const sx = new Float32Array(n), sy = new Float32Array(n), depth = new Float32Array(n);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        sx[i] = x; sy[i] = -(y * se + z * ce); depth[i] = -y * ce + z * se;
        x0 = Math.min(x0, sx[i]); x1 = Math.max(x1, sx[i]); y0 = Math.min(y0, sy[i]); y1 = Math.max(y1, sy[i]);
      }
      // Fit into the space above the note, with a margin all round.
      const noteH = (els.viewer.querySelector('.viewer-note')?.offsetHeight || 0) * dpr;
      const top = H * 0.07, bottom = H - noteH - H * 0.07;
      const k = Math.min((W * 0.86) / (x1 - x0 || 1), (bottom - top) / (y1 - y0 || 1));
      const ox = W / 2 - ((x0 + x1) / 2) * k, oy = (top + bottom) / 2 - ((y0 + y1) / 2) * k;
      const tris = [];
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
        if (-ny * ce + nz * se <= 0) continue; // facing away from the viewer
        tris.push({ t, d: depth[I[t]] + depth[I[t + 1]] + depth[I[t + 2]], shade: 0.5 + 0.5 * Math.max(0, nx * light[0] + ny * light[1] + nz * light[2]) });
      }
      tris.sort((p, q) => p.d - q.d);
      ctx.lineJoin = 'round'; ctx.lineWidth = 0.8;
      for (const { t, shade } of tris) {
        const col = `rgb(${Math.round(243 * shade)},${Math.round(234 * shade)},${Math.round(214 * shade)})`;
        ctx.beginPath();
        for (let k2 = 0; k2 < 3; k2++) { const v = I[t + k2]; const X = ox + sx[v] * k, Y = oy + sy[v] * k; k2 ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
        ctx.closePath();
        ctx.fillStyle = col; ctx.strokeStyle = col; // stroke too, to hide hairline seams
        ctx.fill(); ctx.stroke();
      }
    }
    new ResizeObserver(draw).observe(els.viewer);
    return { show: (result) => { current = result; draw(); }, fit: draw, flat: true };
  }

  // ------------------------------------------------------------------ image loading

  async function loadImageFrom(src, { remember = true } = {}) {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not read that image.')); img.src = src; });
    state.image = img;
    state.work = toWorkingCanvas(img);
    els.overlay.width = state.work.width;
    els.overlay.height = state.work.height;
    els.overlay.hidden = false;
    els.dropEmpty.hidden = true;
    els.drop.classList.add('has-image');
    els.photoActions.hidden = false;
    if (remember) {
      state.settings.rotationDeg = 0;
      store.set(STORE.photo, state.work.toDataURL('image/jpeg', 0.9));
      state.trace = { source: 'auto', nodes: [], closed: false }; // a new photo needs a new trace
      saveTrace();
    }
    if (editor.editing) editor.stop();
    editor.set(state.trace.nodes, state.trace.closed);
    updateTraceUI();
    // Show the photo now; finding the shape may take a moment (or be unavailable).
    state.det = null;
    drawOverlay();
    syncControls();
    await runDetect();
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    state.settings.sel = 0;
    const url = URL.createObjectURL(file);
    loadImageFrom(url).catch(showError).finally(() => setTimeout(() => URL.revokeObjectURL(url), 1000));
  }

  // ------------------------------------------------------------------ pipeline

  async function runDetect() {
    if (!state.work) return;
    if (!state.cv) {
      if (state.cvError) { rebuild(); return; }
      setStatus('Loading shape finder…');
      try { state.cv = await loadOpenCV(); } catch (e) { cvFailed(e); rebuild(); return; }
    }
    const s = state.settings;
    if (lettering()) {
      // Lettering: find all the ink; the outline round it is worked out in rebuild, so the
      // Border slider can change it without looking at the photo again.
      const found = findInk(state.cv, state.work, { threshold: s.threshold });
      state.det = { ...found, lettering: true, candidates: [], detectedMode: 'lettering', channel: 'brightness' };
      state.sel = 0;
      const n = found.ink.length;
      setStatus(n ? `Found ${n} piece${n > 1 ? 's' : ''} of lettering` : 'No lettering found', !n);
      if (s.threshold == null) els.threshold.value = found.thresholdUsed;
      els.thresholdOut.textContent = found.thresholdUsed;
      rebuild();
      return;
    }
    state.det = detect(state.cv, state.work, { mode: s.mode === 'auto' ? 'auto' : s.mode, threshold: s.threshold });
    state.sel = Math.min(s.sel ?? 0, Math.max(0, state.det.candidates.length - 1));
    const n = state.det.candidates.length;
    const by = state.det.channel === 'color' ? ' (by color)' : '';
    setStatus(n ? `Found ${n} shape${n > 1 ? 's' : ''}${by}` : 'No closed shape found', !n);
    if (s.threshold == null) els.threshold.value = state.det.thresholdUsed;
    els.thresholdOut.textContent = state.det.thresholdUsed;
    rebuild();
  }

  function rebuild() {
    const s = state.settings;
    const mode = effectiveMode();
    els.edgeField.hidden = mode !== 'drawing';
    els.modeNote.textContent = state.det
      ? (s.mode === 'auto' ? `Auto: this looks like a ${mode === 'drawing' ? 'hand drawing' : 'cookie cutter'}.` : '')
      : '';
    els.borderField.hidden = !lettering() || state.trace.source === 'trace';
    if (state.det?.lettering) updateLetteringOutline();
    const multi = state.trace.source === 'auto' && !!state.det && state.det.candidates.length > 1;
    els.pickHint.hidden = !multi;
    els.overlay.classList.toggle('pickable', multi);
    if (state.trace.source === 'trace') els.edgeField.hidden = true;

    state.result = null;
    state.error = null;
    s.sel = state.sel;
    saveSettings();
    const cand = state.det?.candidates[state.sel];
    const tracing = state.trace.source === 'trace';
    if (tracing) {
      if (state.trace.closed && state.trace.nodes.length >= 3) {
        try {
          state.result = product.build(curvePoints(state.trace.nodes).points, s);
        } catch (e) {
          state.error = e.message;
        }
      } else {
        state.error = state.trace.nodes.length ? 'Close your outline: tap the first (green) point.' : 'Tap round the edge of the shape to place points.';
      }
    } else if (cand) {
      try {
        state.result = product.build(autoPoints(cand), s);
      } catch (e) {
        state.error = e.message;
      }
    } else if (state.det) {
      state.error = 'No closed shape found. Try the threshold slider, tracing it by hand, or the photo tips above.';
    }
    drawOverlay();
    viewer.show(state.result);
    els.viewerEmpty.hidden = !!state.result;
    els.viewerEmpty.textContent = state.error && state.det ? `Couldn’t build a ${product.noun} from this shape.` : `Your ${product.noun} will appear here.`;
    updateReadout();
    if (lettering()) {
      // Border in mm: scale the pixel border by the cookie's size over its size in the photo.
      const px = state.result?.overlayPx && bbox(state.result.overlayPx);
      const mm = px ? (state.det.borderPx * s.sizeMM) / Math.max(px.width, px.height) : null;
      els.borderOut.textContent = `${fmt(s.borderPct, 1)}%${mm ? ` · about ${s.units === 'in' ? `${fmt(mm / MM_PER_IN, 2)} in` : `${fmt(mm, 0)} mm`}` : ''}`;
      if (state.det?.lettering && state.det.joined !== false && s.mode === 'lettering') {
        els.modeNote.textContent = 'The cookie follows the lettering, a border’s width out. Ice the words on top.';
      }
    }
    product.render?.(s, state.result);
  }
  const rebuildSoon = debounce(rebuild, 60);

  /** Lettering: the bubble outline round the ink, cached until the ink or border changes. */
  function updateLetteringOutline() {
    const det = state.det, pct = state.settings.borderPct;
    if (det.outlineFor === pct) return;
    det.outlineFor = pct;
    const res = letteringOutline(det.ink, { borderPct: pct });
    det.joined = res ? res.joined : true;
    det.borderPx = res ? res.borderPx : 0;
    det.candidates = res ? [{ kind: 'lettering', points: res.outline, area: Math.abs(signedArea(res.outline)), lineThickness: 0 }] : [];
    if (res && !res.joined) els.modeNote.textContent = 'Some pieces are too far apart to join into one cookie, so only the biggest is used. Try a bigger border.';
  }

  /** The outline the automatic detection would use for a candidate. */
  function autoPoints(cand) {
    return effectiveMode() === 'drawing' && state.settings.edge === 'center' ? centerlineOf(cand) : cand.points;
  }

  // ------------------------------------------------------------------ hand tracing

  const editor = createTraceEditor(els.overlay, {
    getImage: () => state.work,
    onChange: (nodes, closed) => {
      state.trace.nodes = nodes; state.trace.closed = closed;
      saveTrace(); updateTraceUI(); rebuildSoon();
    },
    onSelect: () => updateTraceUI(),
  });

  function startTracing() {
    if (!state.work) return;
    // Start from the existing trace, or from the automatic outline if there is one.
    if (!state.trace.nodes.length) {
      const cand = state.trace.source === 'auto' && state.det?.candidates[state.sel];
      state.trace.nodes = cand ? nodesFromContour(autoPoints(cand)) : [];
      state.trace.closed = state.trace.nodes.length >= 3;
    }
    state.trace.source = 'trace';
    saveTrace();
    editor.start(state.trace.nodes, state.trace.closed);
    updateTraceUI();
    rebuild();
  }

  function stopTracing({ useAuto = false } = {}) {
    editor.stop();
    if (useAuto) state.trace.source = 'auto';
    saveTrace();
    updateTraceUI();
    rebuild();
  }

  function updateTraceUI() {
    const tracing = state.trace.source === 'trace', editing = editor.editing;
    els.traceBtn.hidden = tracing;
    els.traceBar.hidden = !editing;
    els.traceUsing.hidden = !tracing || editing;
    els.overlay.classList.toggle('tracing', editing);
    document.querySelectorAll('[data-auto-only]').forEach((n) => (n.hidden = tracing));
    if (!editing) return;
    const n = state.trace.nodes.length;
    els.traceHint.innerHTML = !state.trace.closed
      ? (n < 3 ? '<b>Tap round the edge of the shape</b> to place points.' : 'Keep going, then <b>tap the first (green) point</b> to close the outline.')
      : 'Drag points to adjust. <b>Tap the line</b> to add a point, <b>double-tap a point</b> for a sharp corner. Pinch or scroll to zoom.';
    els.traceUndo.disabled = !editor.canUndo();
    els.traceDelete.disabled = editor.selected < 0;
    els.traceCorner.disabled = editor.selected < 0;
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const detectSoon = debounce(() => runDetect().catch(showError), 120);

  function drawOverlay() {
    if (!state.work) return;
    if (state.trace.source === 'trace') { editor.draw(); return; }
    const ctx = els.overlay.getContext('2d');
    const { width: w, height: h } = els.overlay;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(state.work, 0, 0);
    if (!state.det) return;
    const lw = Math.max(2, Math.max(w, h) / 320);
    const path = (pts) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    };
    ctx.lineJoin = 'round';
    // Other candidates: dashed, so it's clear they can be chosen.
    state.det.candidates.forEach((c, i) => {
      if (i === state.sel) return;
      path(c.points);
      ctx.setLineDash([lw * 4, lw * 3]);
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = lw * 2.2; ctx.stroke();
      ctx.strokeStyle = 'rgba(30,140,200,.95)'; ctx.lineWidth = lw * 1.2; ctx.stroke();
      ctx.setLineDash([]);
    });
    // Selected: the final, rounded cookie edge with a halo.
    const sel = state.result?.overlayPx ?? state.det.candidates[state.sel]?.points;
    if (sel) {
      path(sel);
      ctx.fillStyle = 'rgba(255, 45, 135, .12)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = lw * 3; ctx.stroke();
      ctx.strokeStyle = '#ff1f7a'; ctx.lineWidth = lw * 1.6; ctx.stroke();
    }
  }

  function updateReadout() {
    const b = state.result;
    if (!b) {
      els.dimsIn.textContent = '—'; els.dimsMm.textContent = ''; els.volume.textContent = '—'; els.tris.textContent = '';
    } else {
      const [w, h, t] = b.validation.bounds.size;
      els.dimsIn.textContent = `${fmt(w / MM_PER_IN, 2)} × ${fmt(h / MM_PER_IN, 2)} × ${fmt(t / MM_PER_IN, 2)} in`;
      els.dimsMm.textContent = `${fmt(w, 1)} × ${fmt(h, 1)} × ${fmt(t, 1)} mm`;
      els.volume.textContent = `${fmt(b.validation.volume / 1000, 1)} cm³`;
      els.tris.textContent = `${b.validation.triangles.toLocaleString()} triangles`;
    }
    const v = els.validation;
    if (state.error) {
      v.hidden = false; v.className = 'validation bad'; v.textContent = state.error;
    } else if (b && !b.validation.ok) {
      v.hidden = false; v.className = 'validation bad';
      v.innerHTML = `<span>This ${product.noun} failed the print check, so it can’t be downloaded:</span>`;
      const ul = document.createElement('ul');
      for (const e of b.validation.errors) { const li = document.createElement('li'); li.textContent = e; ul.appendChild(li); }
      v.appendChild(ul);
    } else if (b) {
      v.hidden = false; v.className = 'validation ok';
      const note = product.okNote(b);
      v.textContent = '✓ Watertight, manifold and print-ready.' + (note ? ' ' + note : '');
    } else {
      v.hidden = true;
    }
    els.download.disabled = !(b && b.validation.ok);
    els.filename.textContent = fileName();
  }

  function fileName() {
    const name = els.name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'cookie';
    return product.fileName(state.settings, name);
  }

  function download() {
    const b = state.result;
    if (!b || !b.validation.ok) return;
    saveBlob(new Blob([b.stl()], { type: 'model/stl' }), fileName());
  }

  /** The shape finder couldn't load: say why, and offer tracing by hand instead. */
  function cvFailed(e) {
    state.cvError = e;
    console.error('Shape finder failed to load', e);
    setStatus('Shape finder unavailable', true);
    els.loadProblemText.textContent = e.message;
    els.loadProblem.hidden = false;
  }

  function showError(e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }

  // ------------------------------------------------------------------ controls

  function syncControls() {
    const s = state.settings;
    const d = s.units === 'in' ? 3 : 1;
    els.size.value = fmt(toUnit(s.sizeMM), d);
    els.size.step = s.units === 'in' ? '0.05' : '0.5';
    els.size.min = fmt(toUnit(25), d); els.size.max = fmt(toUnit(254), d);
    // Product dimensions; data-fixed-mm ones (blade thickness) always show mm.
    for (const inp of dimInputs) {
      const mmOnly = inp.hasAttribute('data-fixed-mm');
      const conv = (mm) => (mmOnly ? mm : toUnit(mm));
      const dd = mmOnly ? 2 : d;
      inp.value = fmt(conv(s[inp.dataset.dim]), dd);
      inp.min = fmt(conv(Number(inp.dataset.min)), dd);
      inp.max = fmt(conv(Number(inp.dataset.max)), dd);
      inp.step = mmOnly ? '0.1' : (s.units === 'in' ? '0.05' : '0.5');
    }
    document.querySelectorAll('.unit-label').forEach((n) => (n.textContent = n.closest('.num')?.querySelector('[data-fixed-mm]') ? 'mm' : s.units));
    for (const inp of textInputs) inp.value = s[inp.dataset.text] ?? '';
    els.mirror.checked = s.mirror;
    els.border.value = s.borderPct;
    els.smooth.value = s.smoothness;
    document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === s.mode));
    document.querySelectorAll('input[name="edge"]').forEach((r) => (r.checked = r.value === s.edge));
    document.querySelectorAll('input[name="units"]').forEach((r) => (r.checked = r.value === s.units));
    els.thresholdAuto.checked = s.threshold == null;
    els.threshold.disabled = s.threshold == null;
    if (s.threshold != null) { els.threshold.value = s.threshold; els.thresholdOut.textContent = s.threshold; }
    els.rotation.value = s.rotationDeg;
    els.rotationOut.textContent = `${s.rotationDeg}°`;
    els.smoothOut.textContent = s.smoothness;
    els.notches.value = s.notchWidthMM;
    els.notchesOut.textContent = s.units === 'in' ? `${fmt(s.notchWidthMM / MM_PER_IN, 2)} in` : `${fmt(s.notchWidthMM, 1)} mm`;
  }

  function readNumber(input, minMM, maxMM, fallbackMM) {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return fallbackMM;
    return Math.min(maxMM, Math.max(minMM, fromUnit(v)));
  }

  function wireControls() {
    const s = state.settings;
    document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { s.mode = r.value; detectSoon(); }));
    document.querySelectorAll('input[name="edge"]').forEach((r) => r.addEventListener('change', () => { s.edge = r.value; rebuild(); }));
    document.querySelectorAll('input[name="units"]').forEach((r) => r.addEventListener('change', () => { s.units = r.value; syncControls(); }));

    els.thresholdAuto.addEventListener('change', () => {
      els.threshold.disabled = els.thresholdAuto.checked;
      s.threshold = els.thresholdAuto.checked ? null : Number(els.threshold.value);
      detectSoon();
    });
    els.threshold.addEventListener('input', () => { s.threshold = Number(els.threshold.value); els.thresholdOut.textContent = els.threshold.value; detectSoon(); });
    els.smooth.addEventListener('input', () => { s.smoothness = Number(els.smooth.value); els.smoothOut.textContent = s.smoothness; rebuildSoon(); });
    els.notches.addEventListener('input', () => { s.notchWidthMM = Number(els.notches.value); syncControls(); rebuildSoon(); });
    els.mirror.addEventListener('change', () => { s.mirror = els.mirror.checked; rebuild(); });
    els.border.addEventListener('input', () => { s.borderPct = Number(els.border.value); rebuildSoon(); });

    els.size.addEventListener('input', () => { s.sizeMM = readNumber(els.size, 25, 254, s.sizeMM); rebuildSoon(); });
    els.size.addEventListener('change', syncControls);
    for (const inp of dimInputs) {
      const lo = Number(inp.dataset.min), hi = Number(inp.dataset.max), key = inp.dataset.dim;
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        const mm = inp.hasAttribute('data-fixed-mm') ? v : fromUnit(v);
        s[key] = Math.min(hi, Math.max(lo, mm));
        rebuildSoon();
      });
      inp.addEventListener('change', syncControls);
    }

    const setRot = (deg) => {
      s.rotationDeg = ((Math.round(deg) + 540) % 360) - 180;
      els.rotation.value = s.rotationDeg;
      els.rotationOut.textContent = `${s.rotationDeg}°`;
      rebuildSoon();
    };
    els.rotation.addEventListener('input', () => setRot(Number(els.rotation.value)));
    els.rotL.addEventListener('click', () => setRot(s.rotationDeg + 90));
    els.rotR.addEventListener('click', () => setRot(s.rotationDeg - 90));

    for (const inp of textInputs) inp.addEventListener('input', () => { s[inp.dataset.text] = inp.value; rebuildSoon(); });
    els.name.addEventListener('input', () => (els.filename.textContent = fileName()));
    els.download.addEventListener('click', download);
    els.resetView.addEventListener('click', () => viewer.fit());

    for (const id of ['fileInput', 'cameraInput', 'fileInput2', 'cameraInput2']) {
      $(id).addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
    }
    document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => {
      state.settings.sel = 0;
      // A sample can pick its mode (the lettering sample needs Lettering); others use Auto.
      state.settings.mode = b.dataset.mode || 'auto';
      syncControls();
      loadImageFrom(b.dataset.sample).catch(showError);
    }));

    // Drag & drop, anywhere on the photo card.
    const drop = els.drop;
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    window.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
      if (f) loadFile(f);
    });

    // Click to choose among candidates.
    els.overlay.addEventListener('click', (e) => {
      if (state.trace.source === 'trace') return;
      if (!state.det || state.det.candidates.length < 2) return;
      const r = els.overlay.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * els.overlay.width;
      const y = ((e.clientY - r.top) / r.height) * els.overlay.height;
      const i = candidateAt(state.det.candidates, [x, y]);
      if (i >= 0 && i !== state.sel) { state.sel = i; rebuild(); }
    });
  }

  // ------------------------------------------------------------------ boot

  els.traceBtn.addEventListener('click', startTracing);
  els.loadProblemTrace.addEventListener('click', () => {
    if (state.work) startTracing();
    else els.drop.scrollIntoView({ behavior: 'smooth', block: 'center' }); // choose a photo first
  });
  els.traceEdit.addEventListener('click', startTracing);
  els.traceDone.addEventListener('click', () => stopTracing());
  els.traceAuto.addEventListener('click', () => stopTracing({ useAuto: true }));
  els.traceUndo.addEventListener('click', () => editor.undo());
  els.traceDelete.addEventListener('click', () => editor.deleteSelected());
  els.traceCorner.addEventListener('click', () => editor.toggleCorner());
  els.traceZoomIn.addEventListener('click', () => editor.zoomBy(1.5));
  els.traceZoomOut.addEventListener('click', () => editor.zoomBy(1 / 1.5));
  els.traceFit.addEventListener('click', () => editor.fit());
  els.traceClear.addEventListener('click', () => editor.clear());

  wireControls();
  syncControls();
  updateReadout();
  product.render?.(state.settings, null);
  loadOpenCV()
    .then((cv) => { state.cv = cv; if (!state.work) setStatus('Ready'); })
    .catch(cvFailed);

  // Pick up the photo from the other page (or a reload) in this tab.
  const savedPhoto = store.get(STORE.photo);
  if (savedPhoto) loadImageFrom(savedPhoto, { remember: false }).catch(() => {});

  // For quick manual testing from the console.
  window.cookieApp = { state, loadImageFrom, rebuild, viewer, editor };
  return { rebuild };
}
