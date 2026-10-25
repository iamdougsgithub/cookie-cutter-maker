// Stamp / interior detail lines: binary photo mask -> centre-line polylines (pixels).
// Pure JS (no OpenCV), so it can be unit tested.
//
//   1. Keep foreground pixels well inside the cookie edge (drops the cutter wall itself).
//   2. Drop specks; replace thick or compact blobs with their boundary (a filled circle or
//      dot should be drawn as a circle, not shrunk to a point).
//   3. Zhang–Suen thinning to 1 px centre lines, trace them into polylines, prune spurs.
//   4. Simplify and smooth.

import { simplifyClosed } from './geometry.js';

/** Rasterise a polygon (pixel coords) into a w*h mask, sampling pixel centres. */
export function fillPolygon(pts, w, h) {
  const m = new Uint8Array(w * h);
  const n = pts.length;
  const xs = [];
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a[1] <= yc) !== (b[1] <= yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) m[y * w + x] = 1;
    }
  }
  return m;
}

/** Approximate Euclidean distance (px) from each set pixel to the nearest unset one. */
export function distanceInside(mask, w, h) {
  const INF = 1e9, D = 1, DD = Math.SQRT2;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x - 1, y) + D, at(x, y - 1) + D, at(x - 1, y - 1) + DD, at(x + 1, y - 1) + DD);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x + 1, y) + D, at(x, y + 1) + D, at(x + 1, y + 1) + DD, at(x - 1, y + 1) + DD);
  }
  return d;
}

// 8-neighbourhood, clockwise from north: P2..P9 in Zhang–Suen terms.
const NB = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** Zhang–Suen thinning. mask: 0/1 Uint8Array. Returns a new 0/1 skeleton. */
export function thin(mask, w, h) {
  const img = Uint8Array.from(mask, (v) => (v ? 1 : 0));
  for (let x = 0; x < w; x++) img[x] = img[(h - 1) * w + x] = 0;
  for (let y = 0; y < h; y++) img[y * w] = img[y * w + w - 1] = 0;
  const p = new Uint8Array(8);
  const del = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!img[i]) continue;
        let B = 0;
        for (let k = 0; k < 8; k++) { p[k] = img[(y + NB[k][1]) * w + x + NB[k][0]]; B += p[k]; }
        if (B < 2 || B > 6) continue;
        let A = 0;
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++;
        if (A !== 1) continue;
        // p[0]=N(P2) p[2]=E(P4) p[4]=S(P6) p[6]=W(P8)
        if (step === 0 ? (p[0] && p[2] && p[4]) || (p[2] && p[4] && p[6]) : (p[0] && p[2] && p[6]) || (p[0] && p[4] && p[6])) continue;
        del.push(i);
      }
      for (const i of del) img[i] = 0;
      if (del.length) changed = true;
    }
  }
  return img;
}

/**
 * Trace a 1 px skeleton into polylines: [{ pts: [[x, y], ...], closed, ends }], where
 * ends counts how many ends are free (not at a junction) — used for spur pruning.
 */
export function traceSkeleton(sk, w, h) {
  const nbrs = (i) => {
    const x = i % w, y = (i - x) / w, out = [];
    // 4-neighbours first so tracing prefers straight steps over diagonals.
    for (const k of [0, 2, 4, 6, 1, 3, 5, 7]) {
      const nx = x + NB[k][0], ny = y + NB[k][1];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && sk[ny * w + nx]) out.push(ny * w + nx);
    }
    return out;
  };
  const kind = new Int8Array(w * h); // 0 none, 1 end, 2 path, 3 junction
  for (let i = 0; i < w * h; i++) {
    if (!sk[i]) continue;
    const n = nbrs(i).length;
    if (n === 0) continue;
    if (n === 1) { kind[i] = 1; continue; }
    // Crossing number: robust to staircase pixels that touch both a 4- and 8-neighbour.
    const x = i % w, y = (i - x) / w;
    let cn = 0;
    for (let k = 0; k < 8; k++) {
      const a = NB[k], b = NB[(k + 1) % 8];
      const va = sk[(y + a[1]) * w + x + a[0]] || 0, vb = sk[(y + b[1]) * w + x + b[0]] || 0;
      if (!va && vb) cn++;
    }
    kind[i] = cn >= 3 ? 3 : 2;
  }
  const seen = new Uint8Array(w * h);
  const xy = (i) => [i % w, Math.floor(i / w)];
  const lines = [];
  // Follow unvisited line pixels (straight steps first); finish at a junction or end.
  const walk = (start, first) => {
    const path = [start, first];
    seen[first] = 1;
    let prev = start, cur = first;
    while (kind[cur] === 2) {
      const ns = nbrs(cur).filter((q) => q !== prev);
      const next = ns.find((q) => kind[q] === 2 && !seen[q]);
      if (next === undefined) {
        const node = ns.find((q) => kind[q] !== 2 && (q !== start || path.length > 3));
        if (node !== undefined) path.push(node);
        break;
      }
      seen[next] = 1;
      path.push(next);
      prev = cur; cur = next;
    }
    return path;
  };
  for (let i = 0; i < w * h; i++) {
    if (kind[i] !== 1 && kind[i] !== 3) continue;
    for (const q of nbrs(i)) {
      if (kind[q] === 2 && !seen[q]) {
        const path = walk(i, q);
        const last = path[path.length - 1];
        lines.push({ pts: path.map(xy), closed: false, ends: (kind[i] === 1 ? 1 : 0) + (kind[last] === 1 ? 1 : 0) });
      } else if (kind[q] === 1 && kind[i] === 1 && i < q) {
        lines.push({ pts: [xy(i), xy(q)], closed: false, ends: 2 });
      }
    }
  }
  // Whatever path pixels are left form closed loops.
  for (let i = 0; i < w * h; i++) {
    if (kind[i] !== 2 || seen[i]) continue;
    seen[i] = 1;
    const ns = nbrs(i).filter((q) => kind[q] === 2 && !seen[q]);
    if (!ns.length) continue;
    const path = walk(i, ns[0]);
    lines.push({ pts: path.map(xy), closed: true, ends: 0 });
  }
  return lines;
}

function polyLength(pts, closed) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 2) L += Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);
  return L;
}

/** Douglas–Peucker for an open polyline. */
export function simplifyOpen(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    let best = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > best) { best = d; idx = i; }
    }
    if (best > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting; open polylines keep their end points. */
export function chaikin(pts, closed, iterations = 2) {
  let p = pts;
  for (let it = 0; it < iterations && p.length > 2; it++) {
    const out = closed ? [] : [p[0]];
    const n = p.length, segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = p[i], b = p[(i + 1) % n];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) out.push(p[n - 1]);
    p = out;
  }
  return p;
}

/**
 * Detail lines inside a cookie outline.
 *   binary:     Uint8Array w*h, foreground non-zero (the same mask the outline came from)
 *   cookiePts:  the cookie edge in pixels (inner edge of the cutter wall / drawn line)
 *   lineThickness: width of that wall/line in px, so it can be kept out of the details
 * Returns [{ pts, closed }] in pixel coordinates.
 */
export function extractStampLines(binary, w, h, cookiePts, { lineThickness = 0 } = {}) {
  const inside = fillPolygon(cookiePts, w, h);
  let area = 0;
  for (let i = 0; i < inside.length; i++) area += inside[i];
  if (!area) return [];
  const scale = Math.sqrt(area);
  const margin = Math.max(3, lineThickness * 0.5 + 2);
  const dist = distanceInside(inside, w, h);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (binary[i] && dist[i] > margin) mask[i] = 1;

  // Connected components (8-connected): drop specks, hollow out thick blobs.
  const minArea = Math.max(12, (0.012 * scale) ** 2);
  const thickPx = Math.max(6, 0.035 * scale);
  const label = new Int32Array(w * h).fill(-1);
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const comp = [];
    label[s] = s; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of NB) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && label[j] < 0) { label[j] = s; stack.push(j); }
      }
    }
    if (comp.length < minArea) { for (const i of comp) mask[i] = 0; continue; }
    const isEdge = (i) => {
      const x = i % w, y = (i - x) / w;
      return x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w];
    };
    const edge = comp.filter(isEdge);
    const width = (2 * comp.length) / edge.length;
    // Compact blobs (dots, short dashes) would thin to almost nothing: outline them too.
    // perimeter² / area is ~13 for a disc and grows with length for a line.
    const compact = (edge.length * edge.length) / comp.length < 30;
    if (width > thickPx || compact) {
      const keep = new Set(edge);
      for (const i of comp) if (!keep.has(i)) mask[i] = 0;
    }
  }

  const sk = thin(mask, w, h);
  const minLen = Math.max(4, 0.02 * scale);
  return traceSkeleton(sk, w, h)
    .filter((l) => !(l.ends > 0 && polyLength(l.pts, l.closed) < minLen))
    .filter((l) => polyLength(l.pts, l.closed) >= 2)
    .map((l) => {
      const simple = l.closed && l.pts.length > 8 ? simplifyClosed(l.pts, 0.7) : simplifyOpen(l.pts, 0.7);
      return { pts: chaikin(simple, l.closed), closed: l.closed };
    });
}
