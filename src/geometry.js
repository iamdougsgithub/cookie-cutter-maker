// Geometry pipeline: outline (pixels) -> rounded outline (mm) -> mesh -> STL.
// Pure functions, no DOM. Runs in the browser (via import map) and in Node (tests).
//
// Conventions
//  - A polygon is an array of [x, y] points, closed implicitly (last != first).
//  - Pixel outlines are y-down (image space). Millimetre outlines are y-up,
//    counter-clockwise, centred on the origin, as seen looking down on the cookie's top.

import earcut from 'earcut';
import ClipperLib from 'clipper-lib';

export const DEFAULTS = Object.freeze({
  sizeMM: 88.9,          // longest side (3.5 in)
  thicknessMM: 12.7,     // 1/2 in
  topRadiusMM: 2.0,      // round-over on the top edge
  chamferMM: 0.4,        // bottom chamfer (elephant's foot)
  arcSegments: 16,       // segments in the top round-over quarter circle
  // Optional minimum convex corner radius. 0 = keep every part of the shape; thin or
  // tightly curved parts get a narrower round-over instead (see buildMesh).
  convexRadiusMM: 0,
  // Inside corners don't constrain the edge profile (the inset moves away from them), so
  // they only get a light rounding: gaps narrower than notchWidthMM are filled.
  notchWidthMM: 1.0,
  points: 720,           // minimum points around the final outline (~0.4 mm spacing)
  smoothness: 1,         // 0..10, Gaussian sigma of 0.1 + 0.2 * smoothness mm
  rotationDeg: 0,
  mirror: false,
});

export const MM_PER_IN = 25.4;

// ---------------------------------------------------------------- basic polygon utils

export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function perimeter(pts) {
  let L = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    L += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return L;
}

export function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function ensureCCW(pts) {
  return signedArea(pts) < 0 ? pts.slice().reverse() : pts;
}

function dedupe(pts, eps = 1e-9) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps) out.push(p);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop(); else break;
  }
  return out;
}

/** Resample a closed polygon to n points evenly spaced along its perimeter. */
export function resampleClosed(pts, n) {
  pts = dedupe(pts);
  const m = pts.length;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const p = pts[i], q = pts[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  const L = cum[m];
  const out = new Array(n);
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = (k * L) / n;
    while (seg < m - 1 && cum[seg + 1] <= s) seg++;
    const p = pts[seg], q = pts[(seg + 1) % m];
    const len = cum[seg + 1] - cum[seg];
    const t = len > 0 ? (s - cum[seg]) / len : 0;
    out[k] = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  }
  return out;
}

/** Circular Gaussian smoothing of a closed point list (sigma in points). */
export function gaussianSmoothClosed(pts, sigma) {
  if (!(sigma > 0.05)) return pts.slice();
  const n = pts.length;
  const r = Math.min(Math.ceil(sigma * 3), Math.floor((n - 1) / 2));
  const w = [];
  let sum = 0;
  for (let k = -r; k <= r; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); w.push(v); sum += v; }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    for (let k = -r; k <= r; k++) {
      const p = pts[((i + k) % n + n) % n];
      const wk = w[k + r];
      x += p[0] * wk; y += p[1] * wk;
    }
    out[i] = [x / sum, y / sum];
  }
  return out;
}

/** Douglas–Peucker simplification of a closed polygon. */
export function simplifyClosed(pts, tol) {
  const n = pts.length;
  if (n < 8 || !(tol > 0)) return pts.slice();
  // Split at the two mutually farthest-ish points so both halves are open polylines.
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) { best = d; b = i; }
  }
  best = -1;
  for (let i = 0; i < n; i++) {
    const d = (pts[i][0] - pts[b][0]) ** 2 + (pts[i][1] - pts[b][1]) ** 2;
    if (d > best) { best = d; a = i; }
  }
  if (a > b) [a, b] = [b, a];
  const keep = new Uint8Array(n);
  keep[a] = keep[b] = 1;
  const stack = [[a, b], [b, a + n]];
  const at = (i) => pts[i % n];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const p = at(i0), q = at(i1);
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1e-12;
    let maxD = -1, idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const s = at(i);
      const d = Math.abs((s[0] - p[0]) * dy - (s[1] - p[1]) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > tol) {
      keep[idx % n] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// ---------------------------------------------------------------- offsetting (Clipper)

const CLIP_SCALE = 1000; // 1 unit -> 1000 integer units (mm -> µm)

/**
 * Offset a polygon by delta (positive = outward) with round joins.
 * Returns all resulting outer polygons (CCW), largest first.
 */
export function offsetPolygon(pts, delta, { scale = CLIP_SCALE, arcTolerance = 0.005 } = {}) {
  const path = pts.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) }));
  const co = new ClipperLib.ClipperOffset(2, arcTolerance * scale);
  co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, delta * scale);
  return sol
    .map((p) => p.map((q) => [q.X / scale, q.Y / scale]))
    .filter((p) => p.length >= 3 && signedArea(p) > 0)
    .sort((p, q) => signedArea(q) - signedArea(p));
}

function largest(polys) {
  if (!polys.length) throw new Error('Shape vanished while rounding corners — it may be too thin or too small.');
  return polys[0];
}

/**
 * Round corners so concave corners have radius >= concaveR and, if convexR > 0, convex
 * corners >= convexR. Closing (out, in) fills gaps narrower than 2*concaveR — so a hooked
 * part such as a C-shaped hand becomes solid rather than lost if the user asks for it —
 * then the optional opening (in, out) removes parts thinner than 2*convexR, and a final
 * closing rounds the inside corners it leaves. Closing also cleans up self-intersections.
 */
export function roundCorners(pts, { convexR = DEFAULTS.convexRadiusMM, concaveR = DEFAULTS.notchWidthMM / 2 } = {}) {
  let p = ensureCCW(pts);
  // A hair over the target so chord sampling never drops a radius below spec.
  const rv = convexR * 1.02, rc = concaveR * 1.02;
  const close = (q, r) => largest(offsetPolygon(largest(offsetPolygon(q, r)), -r));
  p = close(p, rc);
  if (!(rv > 0)) return p;
  p = largest(offsetPolygon(p, -rv));
  p = largest(offsetPolygon(p, rv));
  // Slightly larger than the first closing: inside arcs it left have radius exactly rc,
  // and offsetting by exactly rc again collapses them to cusps Clipper handles badly.
  return close(p, rc * 1.03);
}

// ---------------------------------------------------------------- transforms

export function transformPoints(pts, { rotationDeg = 0, mirror = false, scale = 1 } = {}) {
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const out = pts.map(([x, y]) => {
    if (mirror) x = -x;
    return [(x * c - y * s) * scale, (x * s + y * c) * scale];
  });
  return mirror ? out.reverse() : out; // keep orientation
}

export function centerOnOrigin(pts) {
  const b = bbox(pts);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return pts.map(([x, y]) => [x - cx, y - cy]);
}

// ---------------------------------------------------------------- outline pipeline

/**
 * Turn a raw pixel contour (y-down) into the final cookie outline in mm.
 * Returns { outline, overlayPx, widthMM, heightMM } where overlayPx is the rounded
 * outline mapped back into pixel space for display on the photo.
 */
export function processOutline(pixelPts, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!pixelPts || pixelPts.length < 3) throw new Error('No outline to process.');

  // 1. y-up, CCW. Work out the mm scale from the bbox *after* rotation/mirror, so the
  //    smoothing below can be specified in real millimetres.
  let p = ensureCCW(dedupe(pixelPts.map(([x, y]) => [x, -y])));
  const b0 = bbox(p);
  if (!(Math.max(b0.width, b0.height) > 0)) throw new Error('Outline has no size.');
  const rb = bbox(transformPoints(p, { rotationDeg: o.rotationDeg, mirror: o.mirror }));
  const s = o.sizeMM / Math.max(rb.width, rb.height);

  // 2. Dense even resample (~0.2 mm spacing), Gaussian smoothing, simplify.
  const perimMM = perimeter(p) * s;
  const nDense = Math.round(Math.min(6000, Math.max(720, perimMM / 0.2)));
  p = resampleClosed(p, nDense);
  const sigmaMM = 0.1 + 0.2 * o.smoothness;
  p = gaussianSmoothClosed(p, sigmaMM / (perimMM / nDense));
  p = simplifyClosed(p, 0.02 / s);

  // 3. Round corners in the un-rotated frame (rounding is rotation/mirror invariant),
  //    so the result can be mapped straight back onto the photo.
  const ox = (b0.minX + b0.maxX) / 2, oy = (b0.minY + b0.maxY) / 2;
  const concaveR = Math.max(0.2, o.notchWidthMM / 2);
  let mm = p.map(([x, y]) => [(x - ox) * s, (y - oy) * s]);
  mm = roundCorners(mm, { convexR: o.convexRadiusMM, concaveR });
  const overlayPx = mm.map(([x, y]) => [x / s + ox, -(y / s + oy)]);

  // 4. Rotate/mirror, then rescale so the longest side is exact. Opening only shrinks
  //    the shape and closing stays inside its hull, so this factor is >= 1.
  let out = transformPoints(mm, { rotationDeg: o.rotationDeg, mirror: o.mirror });
  const ob = bbox(out);
  const f = o.sizeMM / Math.max(ob.width, ob.height);
  out = out.map(([x, y]) => [x * f, y * f]);
  const n = Math.round(Math.min(4000, Math.max(o.points, perimeter(out) / 0.4)));
  out = ensureCCW(resampleClosed(out, n));
  const cb = bbox(out);
  const cx = (cb.minX + cb.maxX) / 2, cy = (cb.minY + cb.maxY) / 2;
  out = out.map(([x, y]) => [x - cx, y - cy]);
  // Resampling can shave the extreme points by microns; snap the bbox back.
  const fb = bbox(out);
  const g = o.sizeMM / Math.max(fb.width, fb.height);
  out = out.map(([x, y]) => [x * g, y * g]);

  /** Map any pixel-space points (e.g. stamp lines) into the outline's final mm frame. */
  const toMM = (px) => {
    const local = px.map(([x, y]) => [(x - ox) * s, (-y - oy) * s]);
    const t = transformPoints(local, { rotationDeg: o.rotationDeg, mirror: o.mirror });
    if (o.mirror) t.reverse(); // transformPoints reverses to keep polygon orientation
    return t.map(([x, y]) => [(x * f - cx) * g, (y * f - cy) * g]);
  };

  const fin = bbox(out);
  return { outline: out, overlayPx, toMM, widthMM: fin.width, heightMM: fin.height };
}

// ---------------------------------------------------------------- mesh

/** Edge profile from bottom to top: [{ z, inset }]. */
export function edgeProfile({
  thicknessMM = DEFAULTS.thicknessMM, topRadiusMM = DEFAULTS.topRadiusMM,
  chamferMM = DEFAULTS.chamferMM, arcSegments = DEFAULTS.arcSegments,
} = {}) {
  if (thicknessMM < topRadiusMM + chamferMM + 0.2) {
    throw new Error(`Thickness must be at least ${(topRadiusMM + chamferMM + 0.2).toFixed(1)} mm.`);
  }
  const prof = [];
  if (chamferMM > 0) prof.push({ z: 0, inset: chamferMM }, { z: chamferMM, inset: 0 });
  else prof.push({ z: 0, inset: 0 });
  const z0 = thicknessMM - topRadiusMM;
  const segs = Math.max(16, arcSegments);
  for (let k = 0; k <= segs; k++) {
    const th = (k / segs) * (Math.PI / 2);
    prof.push({ z: z0 + topRadiusMM * Math.sin(th), inset: topRadiusMM * (1 - Math.cos(th)) });
  }
  prof[prof.length - 1].z = thicknessMM; // exact
  return prof;
}

/** Inward unit normals for a CCW polygon (per point, from neighbours). */
export function inwardNormals(pts) {
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const tx = b[0] - a[0], ty = b[1] - a[1];
    const L = Math.hypot(tx, ty) || 1;
    out[i] = [-ty / L, tx / L]; // left of travel = inside for CCW
  }
  return out;
}

/**
 * Triangulate a simple polygon with earcut, guaranteeing every input vertex is used
 * (earcut drops collinear points; we re-insert them as fans so the cap stays
 * watertight with the wall). Returns CCW index triples referencing 0..n-1.
 */
export function triangulateCap(pts) {
  return triangulateRegion(pts);
}

/**
 * Triangulate a polygon with holes (outer + hole rings, any orientation). Indices refer
 * to the rings concatenated in order: outer, then each hole. Every vertex is used, and
 * triangles come out CCW.
 */
export function triangulateRegion(outer, holes = []) {
  const rings = [outer, ...holes];
  const starts = [];
  let total = 0;
  for (const r of rings) { starts.push(total); total += r.length; }
  const all = rings.flat();
  const flat = new Float64Array(total * 2);
  all.forEach(([x, y], i) => { flat[2 * i] = x; flat[2 * i + 1] = y; });
  const idx = earcut(flat, holes.length ? starts.slice(1) : undefined);
  let tris = [];
  for (let i = 0; i < idx.length; i += 3) tris.push([idx[i], idx[i + 1], idx[i + 2]]);
  // Make every triangle CCW (earcut is consistent, but check the total).
  let area = 0;
  for (const [a, b, c] of tris) {
    area += (all[b][0] - all[a][0]) * (all[c][1] - all[a][1]) - (all[c][0] - all[a][0]) * (all[b][1] - all[a][1]);
  }
  if (area < 0) tris = tris.map(([a, b, c]) => [a, c, b]);

  const used = new Uint8Array(total);
  for (const t of tris) for (const v of t) used[v] = 1;
  if (used.every((u) => u)) return tris;

  const key = (a, b) => (a < b ? a * total + b : b * total + a);
  const byEdge = new Map();
  tris.forEach((t, ti) => { for (let k = 0; k < 3; k++) byEdge.set(key(t[k], t[(k + 1) % 3]), ti); });
  rings.forEach((ring, r) => {
    const n = ring.length, s0 = starts[r];
    const usedList = [];
    for (let i = 0; i < n; i++) if (used[s0 + i]) usedList.push(i);
    if (usedList.length === n) return;
    if (usedList.length < 3) throw new Error('Cap triangulation failed.');
    for (let u = 0; u < usedList.length; u++) {
      const a = usedList[u], b = usedList[(u + 1) % usedList.length];
      const gap = (b - a + n) % n;
      if (gap <= 1) continue;
      const skipped = [];
      for (let k = 1; k < gap; k++) skipped.push(s0 + (a + k) % n);
      const ga = s0 + a, gb = s0 + b;
      const ti = byEdge.get(key(ga, gb));
      if (ti === undefined) throw new Error('Cap triangulation left a hole.');
      const t = tris[ti];
      const c = t.find((v) => v !== ga && v !== gb);
      // Orientation of a->b within t
      const forward = t[(t.indexOf(ga) + 1) % 3] === gb;
      const chain = forward ? [ga, ...skipped, gb] : [gb, ...skipped.reverse(), ga];
      const fan = [];
      for (let k = 0; k < chain.length - 1; k++) fan.push([chain[k], chain[k + 1], c]);
      tris[ti] = fan[0];
      fan.slice(1).forEach((f) => { tris.push(f); for (let k = 0; k < 3; k++) byEdge.set(key(f[k], f[(k + 1) % 3]), tris.length - 1); });
      byEdge.set(key(fan[0][0], fan[0][1]), ti); byEdge.set(key(fan[0][1], fan[0][2]), ti); byEdge.set(key(fan[0][2], fan[0][0]), ti);
    }
  });
  return tris;
}

/**
 * Local clearance at each point: radius of the largest disc that touches the outline at
 * that point (tangent, on the inside) without crossing it — the "shrinking ball" medial
 * axis method. Small on thin parts (half their width) and on tight convex curves (their
 * radius). Capped at maxR. Points within `skip` indices along the outline are ignored, so
 * pixel-level jitter isn't mistaken for a tight curve.
 */
export function localClearance(pts, normals, maxR, skip = 0) {
  const n = pts.length;
  const cell = maxR;
  const grid = new Map();
  const key = (gx, gy) => gx * 73856093 ^ gy * 19349663;
  pts.forEach(([x, y], i) => {
    const k = key(Math.floor(x / cell), Math.floor(y / cell));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(i);
  });
  // Nearest point to c strictly inside radius r (ignoring i's neighbours), or -1.
  const nearestWithin = (cx, cy, r, i) => {
    let best = -1, bestD = r * r;
    const g0 = Math.floor((cx - r) / cell), g1 = Math.floor((cx + r) / cell);
    const h0 = Math.floor((cy - r) / cell), h1 = Math.floor((cy + r) / cell);
    for (let gx = g0; gx <= g1; gx++) for (let gy = h0; gy <= h1; gy++) {
      const list = grid.get(key(gx, gy));
      if (!list) continue;
      for (const j of list) {
        const di = Math.abs(j - i);
        if (Math.min(di, n - di) <= skip) continue;
        const dx = pts[j][0] - cx, dy = pts[j][1] - cy, d = dx * dx + dy * dy;
        if (d < bestD * (1 - 1e-9)) { bestD = d; best = j; }
      }
    }
    return best;
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i], [nx, ny] = normals[i];
    let t = maxR;
    for (let iter = 0; iter < 40; iter++) {
      const j = nearestWithin(px + nx * t, py + ny * t, t, i);
      if (j < 0) break;
      const qx = pts[j][0] - px, qy = pts[j][1] - py;
      const dot = nx * qx + ny * qy;
      const next = dot > 1e-12 ? (qx * qx + qy * qy) / (2 * dot) : 0;
      if (!(next < t - 1e-9)) break;
      t = next;
    }
    out[i] = t;
  }
  return out;
}

/** Sliding-window minimum then mean over a closed sequence (half-width w). */
function erodeSmooth(v, w) {
  const n = v.length;
  if (w < 1) return Float64Array.from(v);
  const m = new Float64Array(n), out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let lo = Infinity;
    for (let k = -w; k <= w; k++) lo = Math.min(lo, v[((i + k) % n + n) % n]);
    m[i] = lo;
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -w; k <= w; k++) sum += m[((i + k) % n + n) % n];
    out[i] = sum / (2 * w + 1);
  }
  return out;
}

/**
 * Build the blank mesh: stacked offset rings joined by quads, plus earcut caps.
 * Where the shape is too thin or too tightly curved for the full edge profile, the
 * profile's insets are scaled down at those points (a narrower round-over) instead of
 * changing the outline. Returns { positions: Float64Array (xyz), indices: Uint32Array,
 * rings, profile, edgeScale (per point, 1 = full profile), reducedFraction }.
 */
export function buildMesh(outline, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const base = ensureCCW(outline);
  const n = base.length;
  const nrm = inwardNormals(base);
  const profile = edgeProfile(o);
  const R = profile.length;
  const maxInset = Math.max(...profile.map((q) => q.inset));
  const spacing = perimeter(base) / n;
  const clearance = localClearance(base, nrm, maxInset * 2, Math.round(0.8 / spacing));
  const w = Math.ceil(1.0 / spacing); // blend the scale over ~1 mm either side

  let rings, edgeScale;
  // Try progressively more conservative scaling until every ring is a simple polygon.
  for (const safety of [0.7, 0.5, 0.35, 0.2, 0.1]) {
    const raw = Array.from(clearance, (c) => Math.min(1, (safety * c) / maxInset));
    edgeScale = erodeSmooth(raw, w);
    rings = profile.map(({ inset }) => base.map(([x, y], i) => {
      const d = inset * edgeScale[i];
      return [x + nrm[i][0] * d, y + nrm[i][1] * d];
    }));
    if (rings.every((ring) => signedArea(ring) > 0 && isSimplePolygon(ring))) break;
  }

  const positions = new Float64Array(R * n * 3);
  for (let r = 0; r < R; r++) {
    const z = profile[r].z;
    for (let i = 0; i < n; i++) {
      const j = (r * n + i) * 3;
      positions[j] = rings[r][i][0]; positions[j + 1] = rings[r][i][1]; positions[j + 2] = z;
    }
  }

  const tris = [];
  for (let r = 0; r < R - 1; r++) {
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const a = r * n + i, b = r * n + i1, c = (r + 1) * n + i1, d = (r + 1) * n + i;
      tris.push(a, b, c, a, c, d);
    }
  }
  const topCap = triangulateCap(rings[R - 1]);
  const topOff = (R - 1) * n;
  for (const [a, b, c] of topCap) tris.push(topOff + a, topOff + b, topOff + c);
  const botCap = triangulateCap(rings[0]);
  for (const [a, b, c] of botCap) tris.push(a, c, b); // facing down

  const reducedFraction = edgeScale.reduce((k, v) => k + (v < 0.95 ? 1 : 0), 0) / n;
  return { positions, indices: Uint32Array.from(tris), rings, profile, edgeScale, reducedFraction };
}

// ---------------------------------------------------------------- validation

function segmentsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if a closed polygon has no self-intersections (grid-bucketed check). */
export function isSimplePolygon(pts) {
  const n = pts.length;
  const b = bbox(pts);
  const cells = Math.max(4, Math.ceil(Math.sqrt(n)));
  const cw = (b.width || 1) / cells, ch = (b.height || 1) / cells;
  const grid = new Map();
  const cell = (x, y) => [Math.min(cells - 1, Math.floor((x - b.minX) / cw)), Math.min(cells - 1, Math.floor((y - b.minY) / ch))];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const [x0, y0] = cell(Math.min(p[0], q[0]), Math.min(p[1], q[1]));
    const [x1, y1] = cell(Math.max(p[0], q[0]), Math.max(p[1], q[1]));
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = gx * cells + gy;
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      for (const j of list) {
        if (Math.abs(i - j) <= 1 || Math.abs(i - j) === n - 1) continue;
        if (segmentsIntersect(p, q, pts[j], pts[(j + 1) % n])) return false;
      }
      list.push(i);
    }
  }
  return true;
}

export function meshBounds(mesh) {
  const P = mesh.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) {
    if (P[i + k] < min[k]) min[k] = P[i + k];
    if (P[i + k] > max[k]) max[k] = P[i + k];
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

export function meshVolume(mesh) {
  const P = mesh.positions, I = mesh.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
       - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
       + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

/**
 * Validate watertightness, manifoldness, orientation, volume and dimensions.
 * expected: { sizeMM, thicknessMM, tolMM }
 */
export function validateMesh(mesh, expected = {}) {
  const errors = [];
  const I = mesh.indices;
  const nv = mesh.positions.length / 3;
  const directed = new Map();
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = I[t + k], b = I[t + (k + 1) % 3];
      if (a === b) { errors.push('Degenerate triangle with repeated vertex.'); continue; }
      const key = a * nv + b;
      directed.set(key, (directed.get(key) || 0) + 1);
    }
  }
  let open = 0, nonManifold = 0, flipped = 0;
  const undirected = new Map();
  for (const [key, count] of directed) {
    const a = Math.floor(key / nv), b = key % nv;
    if (count > 1) flipped++;
    const u = a < b ? a * nv + b : b * nv + a;
    undirected.set(u, (undirected.get(u) || 0) + count);
  }
  for (const [, count] of undirected) {
    if (count === 1) open++; else if (count > 2) nonManifold++;
  }
  if (open) errors.push(`${open} open edge(s): mesh is not watertight.`);
  if (nonManifold) errors.push(`${nonManifold} edge(s) shared by more than 2 triangles.`);
  if (flipped) errors.push(`${flipped} edge(s) with inconsistent triangle orientation.`);

  const volume = meshVolume(mesh);
  if (!(volume > 0)) errors.push(`Volume is ${volume.toFixed(2)} mm³ (must be positive; normals may point inward).`);

  if (mesh.rings) {
    mesh.rings.forEach((ring, r) => {
      if (signedArea(ring) <= 0) errors.push(`Edge ring ${r} collapsed or turned inside out.`);
      else if (!isSimplePolygon(ring)) errors.push(`Edge ring ${r} self-intersects (shape too thin for the edge profile).`);
    });
  }

  const bounds = meshBounds(mesh);
  const tol = expected.tolMM ?? 0.05;
  const [w, h, t] = bounds.size;
  if (expected.sizeMM != null && Math.abs(Math.max(w, h) - expected.sizeMM) > tol) {
    errors.push(`Longest side is ${Math.max(w, h).toFixed(2)} mm, expected ${expected.sizeMM.toFixed(2)} mm.`);
  }
  if (expected.thicknessMM != null && Math.abs(t - expected.thicknessMM) > tol) {
    errors.push(`Thickness is ${t.toFixed(2)} mm, expected ${expected.thicknessMM.toFixed(2)} mm.`);
  }
  if (Math.abs(bounds.min[2]) > 1e-6) errors.push('Bottom is not at z = 0.');

  return { ok: errors.length === 0, errors, volume, bounds, triangles: I.length / 3 };
}

// ---------------------------------------------------------------- STL

/** Binary STL as an ArrayBuffer. Units: mm. */
export function meshToSTL(mesh, header = 'Cookie Cutter and Practice Blank Maker: blank') {
  const P = mesh.positions, I = mesh.indices;
  const nt = I.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) & 0x7f : 0x20);
  dv.setUint32(80, nt, true);
  let off = 84;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    for (const v of [nx, ny, nz]) { dv.setFloat32(off, v, true); off += 4; }
    for (const j of [a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(off, P[j + k], true); off += 4; }
    dv.setUint16(off, 0, true); off += 2;
  }
  return buf;
}

/** Parse a binary STL back into triangles (used by tests). */
export function parseSTL(buf) {
  const dv = new DataView(buf);
  const nt = dv.getUint32(80, true);
  const tris = [];
  let off = 84;
  for (let t = 0; t < nt; t++) {
    off += 12;
    const tri = [];
    for (let v = 0; v < 3; v++) { tri.push([dv.getFloat32(off, true), dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true)]); off += 12; }
    off += 2;
    tris.push(tri);
  }
  return tris;
}

// ---------------------------------------------------------------- one-shot helper

/** Full pipeline: pixel contour -> { outline, mesh, validation, stl() }. */
export function makeBlank(pixelPts, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const res = processOutline(pixelPts, o);
  const mesh = buildMesh(res.outline, o);
  const validation = validateMesh(mesh, { sizeMM: o.sizeMM, thicknessMM: o.thicknessMM });
  return { ...res, mesh, validation, stl: () => meshToSTL(mesh) };
}
