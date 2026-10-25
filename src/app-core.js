import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEFAULTS, MM_PER_IN } from './geometry.js';
import { candidateAt, centerlineOf } from './contours.js';
import { loadOpenCV, toWorkingCanvas, detect } from './vision.js';
import { renderShared } from './shared-markup.js';
import { extractStampLines } from './lines.js';
import { projectorSVG } from './projector.js';

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

  const STORE = { photo: 'pcm.photo', settings: 'pcm.settings' };
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* full or blocked: fine */ } },
  };

  const $ = (id) => document.getElementById(id);
  const dimInputs = [...document.querySelectorAll('[data-dim]')];
  const els = {
    cvStatus: $('cvStatus'), drop: $('drop'), dropEmpty: $('dropEmpty'), overlay: $('overlay'),
    pickHint: $('pickHint'), photoActions: $('photoActions'),
    modeNote: $('modeNote'), edgeField: $('edgeField'),
    threshold: $('threshold'), thresholdAuto: $('thresholdAuto'), thresholdOut: $('thresholdOut'),
    smooth: $('smooth'), smoothOut: $('smoothOut'), notches: $('notches'), notchesOut: $('notchesOut'),
    size: $('size'), mirror: $('mirror'),
    rotation: $('rotation'), rotationOut: $('rotationOut'), rotL: $('rotL'), rotR: $('rotR'),
    viewer: $('viewer'), viewerEmpty: $('viewerEmpty'), resetView: $('resetView'),
    dimsIn: $('dimsIn'), dimsMm: $('dimsMm'), volume: $('volume'), tris: $('tris'),
    validation: $('validation'), name: $('name'), download: $('download'), filename: $('filename'),
    projStatus: $('projStatus'), projPreview: $('projPreview'), projLines: $('projLines'), projOutline: $('projOutline'),
    projStroke: $('projStroke'), projStrokeOut: $('projStrokeOut'), projSvg: $('projSvg'), projPng: $('projPng'),
  };

  const state = {
    cv: null,
    image: null,       // HTMLImageElement
    work: null,        // working canvas
    det: null,         // detection result
    sel: 0,            // selected candidate
    result: null,      // product.build result
    error: null,
    settings: {
      mode: 'auto', edge: 'center', threshold: null, smoothness: DEFAULTS.smoothness,
      notchWidthMM: DEFAULTS.notchWidthMM, sizeMM: DEFAULTS.sizeMM,
      units: 'in', mirror: false, rotationDeg: 0,
      projLines: true, projOutline: true, projStrokeMM: 0.8, projInvert: false,
      ...product.defaults,
    },
    stamp: null,       // { key, lines } detail lines in photo pixels, for the selected shape
  };

  // Settings carry over between the blank and cutter pages (same tab only).
  // Bump when product defaults change meaning (v3: chisel-edge cutter), so stale
  // product dimensions aren't restored; outline settings always carry over.
  const SETTINGS_VERSION = 3;
  try {
    const saved = JSON.parse(store.get(STORE.settings) || '{}');
    if (saved.v !== SETTINGS_VERSION) for (const k of Object.keys(product.defaults)) delete saved[k];
    delete saved.v;
    Object.assign(state.settings, saved);
  } catch { /* ignore */ }
  const saveSettings = () => store.set(STORE.settings, JSON.stringify({ ...state.settings, v: SETTINGS_VERSION }));

  // ------------------------------------------------------------------ helpers

  const fmt = (v, d) => Number(v.toFixed(d)).toString();
  const toUnit = (mm) => (state.settings.units === 'in' ? mm / MM_PER_IN : mm);
  const fromUnit = (v) => (state.settings.units === 'in' ? v * MM_PER_IN : v);
  const effectiveMode = () => (state.settings.mode === 'auto' ? state.det?.detectedMode ?? 'cutter' : state.settings.mode);

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function setStatus(text, isErr = false) {
    els.cvStatus.textContent = text;
    els.cvStatus.classList.toggle('err', isErr);
  }

  // ------------------------------------------------------------------ 3D preview

  const viewer = (() => {
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
  })();

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
    }
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
      setStatus('Loading shape finder…');
      try { state.cv = await loadOpenCV(); } catch (e) { setStatus(e.message, true); return; }
    }
    const s = state.settings;
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
    els.pickHint.hidden = !(state.det && state.det.candidates.length > 1);
    els.overlay.classList.toggle('pickable', !!state.det && state.det.candidates.length > 1);

    state.result = null;
    state.error = null;
    s.sel = state.sel;
    saveSettings();
    const cand = state.det?.candidates[state.sel];
    if (cand) {
      const pts = mode === 'drawing' && s.edge === 'center' ? centerlineOf(cand) : cand.points;
      try {
        state.result = product.build(pts, s);
      } catch (e) {
        state.error = e.message;
      }
    } else if (state.det) {
      state.error = 'No closed shape found. Try the threshold slider, or check the photo tips above.';
    }
    updateStamp(cand);
    drawOverlay();
    viewer.show(state.result);
    els.viewerEmpty.hidden = !!state.result;
    els.viewerEmpty.textContent = state.error && state.det ? `Couldn’t build a ${product.noun} from this shape.` : `Your ${product.noun} will appear here.`;
    updateReadout();
    renderProjector();
    product.render?.(s, state.result);
  }
  const rebuildSoon = debounce(rebuild, 60);

  // Detail lines only depend on the photo and which shape is selected.
  function updateStamp(cand) {
    if (!cand || !state.det?.binary) { state.stamp = null; return; }
    const key = `${state.sel}`;
    if (state.stamp?.det === state.det && state.stamp.key === key) return;
    const lines = extractStampLines(state.det.binary, state.det.width, state.det.height, cand.points, { lineThickness: cand.lineThickness });
    state.stamp = { det: state.det, key, lines };
  }

  function currentDrawing() {
    const r = state.result, s = state.settings;
    if (!r?.toMM) return null;
    const lines = (state.stamp?.lines ?? []).map((l) => ({ pts: r.toMM(l.pts), closed: l.closed }));
    return projectorSVG({
      outline: r.outline, lines, strokeMM: s.projStrokeMM, invert: s.projInvert,
      showOutline: s.projOutline, showLines: s.projLines,
    });
  }

  function renderProjector() {
    const s = state.settings;
    els.projStrokeOut.textContent = `${fmt(s.projStrokeMM, 1)} mm`;
    const n = state.stamp?.lines.length ?? 0;
    els.projStatus.textContent = !state.result ? '' : n ? `${n} detail line${n > 1 ? 's' : ''} found` : 'No stamp details found: outline only';
    const d = currentDrawing();
    els.projSvg.disabled = els.projPng.disabled = !d;
    if (!d) { els.projPreview.innerHTML = '<div class="viewer-empty">The line drawing will appear here.</div>'; return; }
    els.projPreview.innerHTML = d.svg;
    const svg = els.projPreview.querySelector('svg');
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Projector line drawing preview');
  }

  function projectorName(ext) {
    const name = els.name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'cookie';
    return `projector_${name}_${fmt(state.settings.sizeMM / MM_PER_IN, 3)}in.${ext}`;
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

  async function downloadProjectorPNG() {
    const d = currentDrawing();
    if (!d) return;
    const W = 1920, H = 1080;
    const url = URL.createObjectURL(new Blob([d.svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not render the drawing.')); img.src = url; });
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = state.settings.projInvert ? '#000' : '#fff';
      g.fillRect(0, 0, W, H);
      const k = Math.min((W * 0.92) / d.widthMM, (H * 0.92) / d.heightMM);
      const dw = d.widthMM * k, dh = d.heightMM * k;
      g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      saveBlob(blob, projectorName('png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const detectSoon = debounce(() => runDetect().catch(showError), 120);

  function drawOverlay() {
    if (!state.work) return;
    const ctx = els.overlay.getContext('2d');
    const { width: w, height: h } = els.overlay;
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
    // Detail lines that will go into the projector drawing.
    for (const l of state.stamp?.lines ?? []) {
      ctx.beginPath();
      l.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (l.closed) ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = lw * 2.4; ctx.stroke();
      ctx.strokeStyle = '#00a7c4'; ctx.lineWidth = lw * 1.2; ctx.stroke();
    }
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
    els.mirror.checked = s.mirror;
    els.smooth.value = s.smoothness;
    document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === s.mode));
    document.querySelectorAll('input[name="edge"]').forEach((r) => (r.checked = r.value === s.edge));
    document.querySelectorAll('input[name="units"]').forEach((r) => (r.checked = r.value === s.units));
    els.projLines.checked = s.projLines;
    els.projOutline.checked = s.projOutline;
    els.projStroke.value = s.projStrokeMM;
    document.querySelectorAll('input[name="projInvert"]').forEach((r) => (r.checked = (r.value === '1') === s.projInvert));
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

    els.name.addEventListener('input', () => (els.filename.textContent = fileName()));
    const projChanged = () => { saveSettings(); renderProjector(); };
    els.projLines.addEventListener('change', () => { s.projLines = els.projLines.checked; projChanged(); });
    els.projOutline.addEventListener('change', () => { s.projOutline = els.projOutline.checked; projChanged(); });
    els.projStroke.addEventListener('input', () => { s.projStrokeMM = Number(els.projStroke.value); projChanged(); });
    document.querySelectorAll('input[name="projInvert"]').forEach((r) => r.addEventListener('change', () => { s.projInvert = r.value === '1'; projChanged(); }));
    els.projSvg.addEventListener('click', () => { const d = currentDrawing(); if (d) saveBlob(new Blob([d.svg], { type: 'image/svg+xml' }), projectorName('svg')); });
    els.projPng.addEventListener('click', () => downloadProjectorPNG().catch(showError));
    els.download.addEventListener('click', download);
    els.resetView.addEventListener('click', () => viewer.fit());

    for (const id of ['fileInput', 'cameraInput', 'fileInput2', 'cameraInput2']) {
      $(id).addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
    }
    document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => { state.settings.sel = 0; loadImageFrom(b.dataset.sample).catch(showError); }));

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
      if (!state.det || state.det.candidates.length < 2) return;
      const r = els.overlay.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * els.overlay.width;
      const y = ((e.clientY - r.top) / r.height) * els.overlay.height;
      const i = candidateAt(state.det.candidates, [x, y]);
      if (i >= 0 && i !== state.sel) { state.sel = i; rebuild(); }
    });
  }

  // ------------------------------------------------------------------ boot

  wireControls();
  syncControls();
  updateReadout();
  product.render?.(state.settings, null);
  loadOpenCV()
    .then((cv) => { state.cv = cv; if (!state.work) setStatus('Ready'); })
    .catch((e) => setStatus(e.message, true));

  // Pick up the photo from the other page (or a reload) in this tab.
  const savedPhoto = store.get(STORE.photo);
  if (savedPhoto) loadImageFrom(savedPhoto, { remember: false }).catch(() => {});

  // For quick manual testing from the console.
  window.cookieApp = { state, loadImageFrom, rebuild, currentDrawing, viewer };
}
