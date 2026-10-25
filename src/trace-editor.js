// Interactive point editor for tracing an outline on the photo canvas.
//
//   tap empty space      add a point (while the outline is open)
//   tap the first point  close the outline (3+ points)
//   drag a point         move it
//   tap/drag the line    insert a point there (closed outline)
//   double-tap a point   toggle sharp corner
//   drag empty space     pan (when zoomed)
//   pinch / wheel        zoom
//   Delete, Cmd/Ctrl+Z   delete the selected point, undo
//
// Points are in photo pixels; the view (zoom and pan) only affects drawing and hit tests.

import { curvePoints, nodeAt, segmentAt } from './trace.js';

const TAP_SLOP = 6;      // CSS px of movement before a press counts as a drag
const HIT_NODE = 16;     // CSS px
const HIT_LINE = 12;     // CSS px
const MAX_ZOOM = 8;

export function createTraceEditor(canvas, { getImage, onChange, onSelect }) {
  let nodes = [], closed = false, selected = -1, editing = false;
  let view = { s: 1, tx: 0, ty: 0 };
  const undoStack = [];
  const pointers = new Map();
  let gesture = null;  // { type: 'node'|'pan'|'tap'|'pinch', ... }
  let lastTap = { t: 0, index: -1 };

  // --- coordinates
  const cssScale = () => canvas.width / canvas.getBoundingClientRect().width; // canvas px per CSS px
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };
  const toImage = ([cx, cy]) => [(cx - view.tx) / view.s, (cy - view.ty) / view.s];
  const imgRadius = (cssPx) => (cssPx * cssScale()) / view.s;

  function clampView() {
    view.s = Math.min(MAX_ZOOM, Math.max(1, view.s));
    const W = canvas.width, H = canvas.height;
    view.tx = Math.min(0, Math.max(W - W * view.s, view.tx));
    view.ty = Math.min(0, Math.max(H - H * view.s, view.ty));
  }
  function zoomAt([cx, cy], factor) {
    const before = toImage([cx, cy]);
    view.s *= factor;
    clampView();
    view.tx = cx - before[0] * view.s;
    view.ty = cy - before[1] * view.s;
    clampView();
    draw();
  }

  // --- edits
  const snapshot = () => { undoStack.push(JSON.stringify({ nodes, closed })); if (undoStack.length > 200) undoStack.shift(); };
  const changed = () => { draw(); onChange?.(nodes, closed); };
  const select = (i) => { selected = i; onSelect?.(selected, selected >= 0 ? nodes[selected] : null); };

  // --- drawing
  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.s, 0, 0, view.s, view.tx, view.ty);
    const img = getImage();
    if (img) ctx.drawImage(img, 0, 0);
    const u = cssScale() / view.s; // one CSS px in image units
    if (nodes.length >= 2) {
      const { points } = curvePoints(nodes, { closed });
      ctx.beginPath();
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (closed) ctx.closePath();
      ctx.lineJoin = 'round';
      if (closed) { ctx.fillStyle = 'rgba(255, 45, 135, .12)'; ctx.fill(); }
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 5 * u; ctx.stroke();
      ctx.strokeStyle = '#ff1f7a'; ctx.lineWidth = 2.5 * u; ctx.stroke();
    }
    if (!editing) return;
    nodes.forEach((n, i) => {
      const r = (i === selected ? 8 : 6) * u;
      ctx.beginPath();
      if (n.corner) ctx.rect(n.x - r, n.y - r, 2 * r, 2 * r); else ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = i === selected ? '#ff1f7a' : '#fff';
      ctx.fill();
      ctx.strokeStyle = i === 0 && !closed ? '#1f8a5b' : '#ff1f7a'; // first point: green until closed
      ctx.lineWidth = (i === 0 && !closed ? 3 : 2) * u;
      ctx.stroke();
    });
  }

  // --- pointer handling
  function onDown(e) {
    if (!editing) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone: carry on uncaptured */ }
    pointers.set(e.pointerId, toCanvas(e));
    e.preventDefault();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), mid0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], view0: { ...view } };
      return;
    }
    if (pointers.size > 2) return;
    const c = toCanvas(e), p = toImage(c);
    const hit = nodeAt(nodes, p, imgRadius(HIT_NODE));
    if (hit >= 0) { gesture = { type: 'node', index: hit, start: c, moved: false }; select(hit); draw(); return; }
    if (closed) {
      const seg = segmentAt(nodes, p, imgRadius(HIT_LINE));
      if (seg) {
        snapshot();
        nodes.splice(seg.index + 1, 0, { x: p[0], y: p[1], corner: false });
        select(seg.index + 1);
        gesture = { type: 'node', index: seg.index + 1, start: c, moved: true, inserted: true };
        changed();
        return;
      }
    }
    gesture = { type: 'tap', start: c, view0: { ...view } };
  }

  function onMove(e) {
    if (!editing || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, toCanvas(e));
    if (!gesture) return;
    if (gesture.type === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const v0 = gesture.view0, s = Math.min(MAX_ZOOM, Math.max(1, v0.s * (d / gesture.d0)));
      // Keep the image point under the starting midpoint under the current midpoint.
      const ix = (gesture.mid0[0] - v0.tx) / v0.s, iy = (gesture.mid0[1] - v0.ty) / v0.s;
      view = { s, tx: mid[0] - ix * s, ty: mid[1] - iy * s };
      clampView();
      draw();
      return;
    }
    const c = toCanvas(e);
    const movedCss = Math.hypot(c[0] - gesture.start[0], c[1] - gesture.start[1]) / cssScale();
    if (gesture.type === 'node') {
      if (!gesture.moved && movedCss < TAP_SLOP) return;
      if (!gesture.moved) { snapshot(); gesture.moved = true; }
      const p = toImage(c);
      nodes[gesture.index] = { ...nodes[gesture.index], x: p[0], y: p[1] };
      changed();
    } else if (gesture.type === 'tap' && movedCss >= TAP_SLOP) {
      gesture = { type: 'pan', start: gesture.start, view0: gesture.view0 };
    }
    if (gesture.type === 'pan') {
      view = { ...gesture.view0, tx: gesture.view0.tx + c[0] - gesture.start[0], ty: gesture.view0.ty + c[1] - gesture.start[1] };
      clampView();
      draw();
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!editing || !gesture) return;
    if (gesture.type === 'pinch') { if (pointers.size === 0) gesture = null; return; }
    const g = gesture;
    gesture = null;
    if (g.type === 'node' && !g.moved) {
      const now = performance.now();
      if (g.index === 0 && !closed && nodes.length >= 3) {
        snapshot(); closed = true; changed();             // tap the first point: close
      } else if (lastTap.index === g.index && now - lastTap.t < 350) {
        snapshot(); nodes[g.index] = { ...nodes[g.index], corner: !nodes[g.index].corner }; changed(); // double-tap
        lastTap = { t: 0, index: -1 };
        return;
      }
      lastTap = { t: now, index: g.index };
      return;
    }
    if (g.type === 'tap') {
      if (!closed) {
        const p = toImage(g.start);
        snapshot();
        nodes.push({ x: p[0], y: p[1], corner: false });
        select(nodes.length - 1);
        changed();
      } else {
        select(-1); draw();
      }
    }
  }

  function onWheel(e) {
    if (!editing) return;
    e.preventDefault();
    zoomAt(toCanvas(e), Math.exp(-e.deltaY * 0.0015));
  }

  function onKey(e) {
    if (!editing) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) { e.preventDefault(); api.deleteSelected(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); api.undo(); }
    else if (e.key === 'Escape') { select(-1); draw(); }
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKey);

  const api = {
    /** Begin editing these nodes (copied). */
    start(startNodes = [], isClosed = false) {
      nodes = startNodes.map((n) => ({ ...n }));
      closed = isClosed && nodes.length >= 3;
      editing = true;
      undoStack.length = 0;
      select(-1);
      draw();
    },
    /** Stop editing; the trace stays and is still drawn (without its points). */
    stop() { editing = false; select(-1); view = { s: 1, tx: 0, ty: 0 }; draw(); },
    get editing() { return editing; },
    get nodes() { return nodes.map((n) => ({ ...n })); },
    get closed() { return closed; },
    get selected() { return selected; },
    set(newNodes, isClosed) { nodes = newNodes.map((n) => ({ ...n })); closed = isClosed && nodes.length >= 3; draw(); },
    draw,
    undo() {
      if (!undoStack.length) return;
      ({ nodes, closed } = JSON.parse(undoStack.pop()));
      select(Math.min(selected, nodes.length - 1));
      changed();
    },
    canUndo: () => undoStack.length > 0,
    deleteSelected() {
      if (selected < 0) return;
      snapshot();
      nodes.splice(selected, 1);
      if (nodes.length < 3) closed = false;
      select(Math.min(selected, nodes.length - 1));
      changed();
    },
    toggleCorner() {
      if (selected < 0) return;
      snapshot();
      nodes[selected] = { ...nodes[selected], corner: !nodes[selected].corner };
      changed();
    },
    clear() { snapshot(); nodes = []; closed = false; select(-1); changed(); },
    zoomBy(f) { zoomAt([canvas.width / 2, canvas.height / 2], f); },
    fit() { view = { s: 1, tx: 0, ty: 0 }; draw(); },
  };
  return api;
}
