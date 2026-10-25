// Hand tracing: editable points -> smooth closed outline. Pure (no DOM), so it can be unit
// tested; the interactive editor lives in trace-editor.js.
//
// A node is { x, y, corner } in photo pixels (y down). Smooth nodes get a centripetal
// Catmull-Rom curve through them (passes through every point, no overshoot or loops);
// at a corner node the curve meets it in straight lines, so two corners in a row give a
// straight edge.

import { simplifyClosed, resampleClosed, perimeter } from './geometry.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** One centripetal Catmull-Rom segment p1 -> p2 (with neighbours p0, p3), n samples. */
function segment(p0, p1, p2, p3, n) {
  const t01 = Math.max(1e-6, Math.sqrt(dist(p0, p1)));
  const t12 = Math.max(1e-6, Math.sqrt(dist(p1, p2)));
  const t23 = Math.max(1e-6, Math.sqrt(dist(p2, p3)));
  // Tangents at p1 and p2 (Barry-Goldman form, scaled to the p1-p2 interval).
  const m1 = [0, 1].map((k) => (p2[k] - p1[k]) + t12 * ((p1[k] - p0[k]) / t01 - (p2[k] - p0[k]) / (t01 + t12)));
  const m2 = [0, 1].map((k) => (p2[k] - p1[k]) + t12 * ((p3[k] - p2[k]) / t23 - (p3[k] - p1[k]) / (t12 + t23)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n, t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    out.push([0, 1].map((k) => h00 * p1[k] + h10 * m1[k] + h01 * p2[k] + h11 * m2[k]));
  }
  return out;
}

/**
 * Dense polyline through the nodes. closed: join the last node back to the first.
 * Returns { points: [[x, y], ...], segStart: index in points where each segment begins }.
 */
export function curvePoints(nodes, { closed = true, step = 2 } = {}) {
  const n = nodes.length;
  if (n < 2) return { points: nodes.map((p) => [p.x, p.y]), segStart: [0] };
  const P = nodes.map((p) => [p.x, p.y]);
  const at = (i) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
  const isCorner = (i) => (closed ? nodes[(i + n) % n].corner : nodes[Math.max(0, Math.min(n - 1, i))].corner);
  const points = [], segStart = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p1 = at(i), p2 = at(i + 1);
    // At a corner (or an open end) aim straight at the next point: reflect a phantom
    // neighbour so the tangent lies along the chord.
    const end1 = !closed && i === 0, end2 = !closed && i + 1 === n - 1;
    const p0 = isCorner(i) || end1 ? sub([2 * p1[0], 2 * p1[1]], p2) : at(i - 1);
    const p3 = isCorner(i + 1) || end2 ? sub([2 * p2[0], 2 * p2[1]], p1) : at(i + 2);
    const samples = Math.max(2, Math.ceil(dist(p1, p2) / step));
    segStart.push(points.length);
    points.push(...segment(p0, p1, p2, p3, samples));
  }
  if (!closed) points.push(at(n - 1));
  return { points, segStart };
}

/**
 * Editable nodes from a detected outline (photo pixels): roughly `target` points, placed
 * where the shape bends, with sharp bends marked as corners.
 */
export function nodesFromContour(contour, { target = 28, min = 8, max = 48, cornerDeg = 55 } = {}) {
  const dense = resampleClosed(contour, 720);
  const L = perimeter(dense);
  // Find a simplification tolerance that lands near the target count.
  let lo = L * 1e-5, hi = L * 0.05, best = null;
  for (let it = 0; it < 30; it++) {
    const tol = Math.sqrt(lo * hi);
    const s = simplifyClosed(dense, tol);
    if (!best || Math.abs(s.length - target) < Math.abs(best.length - target)) best = s;
    if (s.length > target) lo = tol; else hi = tol;
  }
  let pts = best;
  if (pts.length < min) pts = resampleClosed(dense, min);
  if (pts.length > max) pts = resampleClosed(pts, max);
  // A node is a corner if the outline turns sharply right there (measured on the dense
  // outline over a short span either side, so gentle curves stay smooth).
  const span = Math.max(2, Math.round(dense.length * 0.012));
  return pts.map(([x, y]) => {
    let k = 0, bestD = Infinity;
    dense.forEach((q, i) => { const d = (q[0] - x) ** 2 + (q[1] - y) ** 2; if (d < bestD) { bestD = d; k = i; } });
    const a = dense[(k - span + dense.length) % dense.length], b = dense[(k + span) % dense.length], c = dense[k];
    const v1 = sub(c, a), v2 = sub(b, c);
    const turn = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1])) * 180 / Math.PI;
    return { x, y, corner: turn > cornerDeg };
  });
}

/** Index of the node within r of p, or -1 (nearest wins). */
export function nodeAt(nodes, p, r) {
  let best = -1, bestD = r * r;
  nodes.forEach((q, i) => { const d = (q.x - p[0]) ** 2 + (q.y - p[1]) ** 2; if (d <= bestD) { bestD = d; best = i; } });
  return best;
}

/**
 * Where on the curve p is, if within r: { index } = insert a new node after node `index`
 * (between it and the next). Returns null when p isn't near the curve.
 */
export function segmentAt(nodes, p, r, { closed = true } = {}) {
  if (nodes.length < 2) return null;
  const { points, segStart } = curvePoints(nodes, { closed });
  let bestD = r, bestSeg = -1;
  for (let s = 0; s < segStart.length; s++) {
    const from = segStart[s], to = s + 1 < segStart.length ? segStart[s + 1] : points.length;
    for (let i = from; i < to; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
      const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      if (d < bestD) { bestD = d; bestSeg = s; }
    }
  }
  return bestSeg < 0 ? null : { index: bestSeg };
}
