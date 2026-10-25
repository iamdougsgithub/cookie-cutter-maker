// Raised text on a cutter's outside wall. Pure: takes an opentype.js Font object (loaded by
// the caller) and a wall ring (mm, CCW, z-up, as printed), returns closed triangle shells.
//
// Text is laid out flat in (u, v) — u along the reading direction, v up — then wrapped onto
// the wall: u becomes arc length along the ring, v becomes height, and the letters are
// extruded along the wall's outward normal, from slightly inside the wall to RAISE_MM out.

import ClipperLib from 'clipper-lib';
import { ensureCCW, signedArea, triangulateRegion } from './geometry.js';

const RAISE_MM = 0.6;   // how far letters stand out from the wall
const EMBED_MM = 0.4;   // how far they sink in, so they fuse with it when sliced
const CLIP = 1000;

/** Flatten an opentype path into closed contours, y-up (mm). */
function contours(path) {
  const out = [];
  let cur = null, x = 0, y = 0;
  const add = (px, py) => cur.push([px, -py]);
  for (const c of path.commands) {
    if (c.type === 'M') { cur = []; out.push(cur); add(c.x, c.y); x = c.x; y = c.y; }
    else if (c.type === 'L') { add(c.x, c.y); x = c.x; y = c.y; }
    else if (c.type === 'Q') {
      for (let k = 1; k <= 6; k++) { const t = k / 6, u = 1 - t; add(u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y); }
      x = c.x; y = c.y;
    } else if (c.type === 'C') {
      for (let k = 1; k <= 8; k++) {
        const t = k / 8, u = 1 - t;
        add(u ** 3 * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x, u ** 3 * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y);
      }
      x = c.x; y = c.y;
    }
  }
  return out.filter((p) => p.length >= 3);
}

/**
 * Text as clean polygons-with-holes in mm: [{ outer, holes }], plus its extent.
 * capHeightMM sets the size (height of a capital letter).
 */
export function textShapes(font, text, capHeightMM) {
  const capRatio = (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7) / font.unitsPerEm;
  const size = capHeightMM / capRatio;
  const raw = contours(font.getPath(text, 0, 0, size));
  // Normalise with a non-zero union: fixes overlaps and gives a proper outer/hole tree.
  const c = new ClipperLib.Clipper();
  c.AddPaths(raw.map((p) => p.map(([px, py]) => ({ X: Math.round(px * CLIP), Y: Math.round(py * CLIP) }))), ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const toMM = (path) => path.map((q) => [q.X / CLIP, q.Y / CLIP]);
  const shapes = [];
  const walk = (node) => {
    for (const child of node.Childs()) {
      if (child.IsHole()) continue;
      const outer = ensureCCW(toMM(child.Contour()));
      const holes = child.Childs().map((h) => { const p = toMM(h.Contour()); return signedArea(p) > 0 ? p.reverse() : p; });
      if (outer.length >= 3) shapes.push({ outer, holes });
      for (const h of child.Childs()) walk(h); // islands inside holes
    }
  };
  walk(tree);
  // Reading order (left to right), whatever order the union returned them in.
  const left = (sh) => Math.min(...sh.outer.map((q) => q[0]));
  shapes.sort((a, b) => left(a) - left(b));
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const { outer } of shapes) for (const [u, v] of outer) {
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  return { shapes, minU, maxU, minV, maxV, width: maxU - minU, height: maxV - minV };
}

/** Arc-length parameterisation of a closed ring, with smoothed outward normals. */
function ringFrame(ring, smoothMM = 1.5) {
  const n = ring.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const L = cum[n], step = L / n;
  const raw = ring.map((_, i) => {
    const a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    const tx = b[0] - a[0], ty = b[1] - a[1], len = Math.hypot(tx, ty) || 1;
    return [ty / len, -tx / len]; // right of travel = outside for CCW
  });
  const w = Math.max(1, Math.round(smoothMM / step));
  const normals = raw.map((_, i) => {
    let x = 0, y = 0;
    for (let k = -w; k <= w; k++) { const q = raw[((i + k) % n + n) % n]; x += q[0]; y += q[1]; }
    const len = Math.hypot(x, y) || 1;
    return [x / len, y / len];
  });
  const at = (s) => {
    s = ((s % L) + L) % L;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const t = (s - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1);
    const a = ring[lo], b = ring[(lo + 1) % n], na = normals[lo], nb = normals[(lo + 1) % n];
    const nx = na[0] + (nb[0] - na[0]) * t, ny = na[1] + (nb[1] - na[1]) * t, nl = Math.hypot(nx, ny) || 1;
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], n: [nx / nl, ny / nl] };
  };
  // Total turning (radians) of the ring between arc lengths s0 and s0 + len.
  const turn = raw.map((q, i) => {
    const r = raw[(i + 1) % n];
    return Math.abs(Math.atan2(q[0] * r[1] - q[1] * r[0], q[0] * r[0] + q[1] * r[1]));
  });
  const turning = (s0, len) => {
    let sum = 0;
    const i0 = Math.floor(((s0 % L) + L) % L / step), count = Math.ceil(len / step);
    for (let k = 0; k < count; k++) sum += turn[(i0 + k) % n];
    return sum;
  };
  // Local radius of curvature, measured over ±1.5 mm so pixel jitter doesn't count.
  const kw = Math.max(1, Math.round(1.5 / step));
  const radius = turn.map((_, i) => {
    let sum = 0;
    for (let k = -kw; k < kw; k++) sum += turn[((i + k) % n + n) % n];
    return sum > 1e-9 ? (2 * kw * step) / sum : Infinity;
  });
  const minRadius = (s0, len) => {
    let r = Infinity;
    const i0 = Math.floor(((s0 % L) + L) % L / step), count = Math.ceil(len / step);
    for (let k = 0; k <= count; k++) r = Math.min(r, radius[(i0 + k) % n]);
    return r;
  };
  return { L, step, at, turning, minRadius };
}

/**
 * Raised text wrapped onto the wall ring, sitting near zMin (the lip), within [zMin, zMax].
 * Tries a few sizes and picks the straightest stretch of wall long enough for the text that
 * has no bend tighter than minRadiusMM.
 * Returns { positions, indices, capHeightMM, shapeStarts } (first vertex of each letter
 * shape, in reading order) or { reason } if it doesn't fit anywhere.
 */
export function labelShells(font, text, wallRing, { zMin, zMax, minRadiusMM = 8, sizes = [4, 3.5, 3, 2.5] } = {}) {
  const frame = ringFrame(wallRing);
  for (const cap of sizes) {
    const t = textShapes(font, text, cap);
    if (!t.shapes.length) return { reason: 'The text has no printable letters.' };
    if (t.height > zMax - zMin) continue;
    const margin = 3;
    const need = t.width + 2 * margin;
    if (need > frame.L * 0.8) continue;
    // The straightest stretch of wall this long with no bend tighter than minRadiusMM
    // (letters wrap fine round gentle curves, but not round corners).
    let bestS = -1, bestTurn = Infinity;
    for (let s = 0; s < frame.L; s += frame.step * 2) {
      if (frame.minRadius(s, need) < minRadiusMM) continue;
      const tr = frame.turning(s, need);
      if (tr < bestTurn) { bestTurn = tr; bestS = s; }
    }
    if (bestS < 0) continue;
    const s0 = bestS + margin - t.minU;
    const zBase = zMin - t.minV; // descenders just clear the lip
    const positions = [], indices = [], shapeStarts = [];
    const place = (u, v, w) => {
      const { p, n } = frame.at(s0 + u);
      positions.push(p[0] + n[0] * w, p[1] + n[1] * w, zBase + v);
    };
    for (const { outer, holes } of t.shapes) {
      const rings = [outer, ...holes];
      const K = rings.reduce((k, r) => k + r.length, 0);
      const base = positions.length / 3;
      shapeStarts.push(base);
      for (const w of [-EMBED_MM, RAISE_MM]) for (const r of rings) for (const [u, v] of r) place(u, v, w);
      // Caps: the raised face looks outward, the buried face inward.
      for (const [a, b, c] of triangulateRegion(outer, holes)) {
        indices.push(base + K + a, base + K + b, base + K + c);
        indices.push(base + a, base + c, base + b);
      }
      // Sides: outer ring is CCW and holes CW in (u, v), so these face out of the letter.
      let start = 0;
      for (const r of rings) {
        const m = r.length;
        for (let i = 0; i < m; i++) {
          const i1 = (i + 1) % m;
          const a = base + start + i, b = base + start + i1, c = base + K + start + i1, d = base + K + start + i;
          indices.push(a, b, c, a, c, d);
        }
        start += m;
      }
    }
    return { positions, indices, capHeightMM: cap, shapeStarts };
  }
  return { reason: 'No smooth stretch of wall is long enough for the text. Try shorter text or a bigger cutter.' };
}
