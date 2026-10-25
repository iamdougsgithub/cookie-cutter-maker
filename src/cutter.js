// Cookie cutter geometry: outline (mm) -> cutter mesh -> validation. Pure, like geometry.js.
//
// Modelled as printed: rim flat on the bed (z = 0), blade pointing up. The cutting edge's
// inside is exactly the cookie outline, so it cuts cookies the same shape and size as the
// practice blank. Seen from above as printed, a cutter shows its shape mirrored (you flip
// it over to use it), so the outline is mirrored here.
//
//   z = H          ┌┐ cutting edge (tipMM wide, exact offset, so sharp in tight corners too)
//                  │ \  bevel (~26° with the defaults) over the top bevelMM
//   z = H - bevel  │  │ shoulder: full blade thickness (baseMM)
//                  │  │ inside face: vertical, exactly the outline
//   z = rimT    ┌──┘  └──────┐
//   z = 0       └────────────┘ rim (rimWidthMM beyond the blade)
//
// With bevelMM = 0 the outside face is instead a plain taper from baseMM to tipMM.

import {
  DEFAULTS, ensureCCW, inwardNormals, offsetPolygon, perimeter, processOutline,
  resampleClosed, triangulateRegion, validateMesh, meshToSTL, bbox,
} from './geometry.js';

export const CUTTER_DEFAULTS = Object.freeze({
  heightMM: 18,          // overall height, rim included
  tipMM: 0.4,            // cutting edge: one perimeter with a 0.4 mm nozzle
  bevelMM: 2.5,          // height of the sharpening bevel at the top of the blade
  baseMM: 1.6,           // blade thickness below the bevel
  rimWidthMM: 4,         // rim beyond the blade base
  rimThicknessMM: 2,
});

const spacedRing = (pts, spacing = 0.4) => ensureCCW(resampleClosed(pts, Math.max(360, Math.round(perimeter(pts) / spacing))));

function outward(pts, d) {
  const polys = offsetPolygon(pts, d);
  if (!polys.length) throw new Error('Could not offset the outline for the cutter wall.');
  return polys[0];
}

/**
 * Build the cutter mesh from a cookie outline (mm, CCW, as seen on the cookie's top).
 * Returns { positions, indices, rings, inner, tip, shoulder, base, rim, profile }.
 */
export function buildCutterMesh(outline, opts = {}) {
  const o = { ...CUTTER_DEFAULTS, ...opts };
  const H = o.heightMM, T = o.rimThicknessMM;
  if (!(o.tipMM > 0) || o.baseMM < o.tipMM) throw new Error('Blade must be at least as thick at the base as at the tip.');
  if (H < T + 3) throw new Error(`Height must be at least ${(T + 3).toFixed(0)} mm.`);
  if (!(o.rimWidthMM >= 1)) throw new Error('Rim must be at least 1 mm wide.');

  const inner = ensureCCW(outline.map(([x, y]) => [-x, y])); // mirrored for print orientation
  const bevel = Math.max(0, Math.min(o.bevelMM ?? 0, H - T - 1));

  // Every outside ring is an exact Clipper offset of the outline (round joins; walls that
  // meet across a narrow gap merge), so the cutting edge is tipMM wide everywhere —
  // including tight inside corners. Rings with different vertex counts are joined by
  // stitched strips (see stitch below).
  const tip = spacedRing(outward(inner, o.tipMM));
  const base = spacedRing(outward(inner, o.baseMM));
  const shoulder = bevel > 0 ? base : null; // full thickness right up to the bevel
  const rim = spacedRing(outward(base, o.rimWidthMM));
  // The bevel (or plain taper) is a surface whose height drops linearly with distance
  // from the outline: exact offset rings every ~0.2 mm between the edge and the wall.
  const zTop = H, zLow = shoulder ? H - bevel : T;
  const steps = Math.max(1, Math.round((o.baseMM - o.tipMM) / 0.2));
  const levels = [{ ring: tip, z: zTop }];
  for (let k = 1; k < steps; k++) {
    const d = o.tipMM + ((o.baseMM - o.tipMM) * k) / steps;
    levels.push({ ring: spacedRing(outward(inner, d)), z: zTop - ((zTop - zLow) * k) / steps });
  }
  levels.push({ ring: base, z: zLow });

  // Vertex layout: each ring placed at its z.
  const layout = [
    ['inner0', inner, 0], ['inner1', inner, H],
    ['rim0', rim, 0], ['rim1', rim, T],
    ['base', base, T], ...(shoulder ? [['shoulder', shoulder, H - bevel]] : []),
    ...levels.slice(1, -1).map((l, k) => [`level${k + 1}`, l.ring, l.z]),
    ['tip', tip, H],
  ];
  const at = {};
  let count = 0;
  for (const [name, ring] of layout) { at[name] = count; count += ring.length; }
  const positions = new Float64Array(count * 3);
  for (const [name, ring, z] of layout) {
    ring.forEach(([x, y], i) => { const j = (at[name] + i) * 3; positions[j] = x; positions[j + 1] = y; positions[j + 2] = z; });
  }

  const tris = [];
  // Side wall between two corresponding rings; flip = face toward the ring's inside.
  const wall = (lo, hi, n, flip) => {
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const a = lo + i, b = lo + i1, c = hi + i1, d = hi + i;
      if (flip) tris.push(a, c, b, a, d, c); else tris.push(a, b, c, a, c, d);
    }
  };
  wall(at.inner0, at.inner1, inner.length, true); // inside face looks into the cookie
  wall(at.rim0, at.rim1, rim.length, false);
  if (shoulder) wall(at.base, at.shoulder, base.length, false); // vertical, full thickness
  // Flat annular faces: region between an outer ring and a hole ring.
  const face = (outerName, outerRing, holeName, holeRing, up) => {
    const local = triangulateRegion(outerRing, [holeRing]);
    const map = (k) => (k < outerRing.length ? at[outerName] + k : at[holeName] + k - outerRing.length);
    for (const [a, b, c] of local) {
      if (up) tris.push(map(a), map(b), map(c)); else tris.push(map(a), map(c), map(b));
    }
  };
  face('rim0', rim, 'inner0', inner, false); // underside, on the bed
  face('rim1', rim, 'base', base, true);     // top of the rim
  face('tip', tip, 'inner1', inner, true);   // cutting edge
  // Bevel: join each pair of neighbouring offset rings (0.2 mm apart) with a zipper strip,
  // every triangle touching both rings, so the slope is even. Where a band changes shape
  // too much for that (e.g. walls merging inside a hooked hand) and the strip would fold,
  // that band is triangulated flat instead (earcut) and lifted: a height map, which
  // can't fold.
  const levelName = (k) => (k === 0 ? 'tip' : k === levels.length - 1 ? (shoulder ? 'shoulder' : 'base') : `level${k}`);
  const flatBands = [];
  for (let k = 0; k + 1 < levels.length; k++) {
    const loName = levelName(k + 1), hiName = levelName(k);
    const band = zipper(levels[k + 1].ring, levels[k].ring) ?? nearestZipper(levels[k + 1].ring, levels[k].ring);
    if (band) {
      const L = (i) => at[loName] + i, U = (j) => at[hiName] + j;
      for (const [a, b, c] of band) tris.push(a.lo ? L(a.i) : U(a.i), b.lo ? L(b.i) : U(b.i), c.lo ? L(c.i) : U(c.i));
    } else {
      flatBands.push(k);
      const lo = levels[k + 1].ring, hi = levels[k].ring;
      const map = (v) => (v < lo.length ? at[loName] + v : at[hiName] + v - lo.length);
      for (const [a, b, c] of spanningTriangulation(lo, hi)) tris.push(map(a), map(b), map(c));
    }
  }

  const profile = { tipMM: o.tipMM, shoulderMM: shoulder ? o.baseMM : null, baseMM: o.baseMM, bevelMM: bevel, heightMM: H, rimThicknessMM: T };
  return {
    positions, indices: Uint32Array.from(tris), rings: [inner, tip, ...(shoulder ? [shoulder] : []), base, rim],
    inner, tip, shoulder, base, rim, profile, flatBands,
  };
}

/**
 * Zipper strip between a lower ring and an upper ring (both CCW, any vertex counts):
 * walk both rings, always taking the shorter diagonal. Returns triangles as
 * [{ lo, i }, ...] vertex refs, facing up/out — or null if any triangle would fold
 * (face down in plan view), so the caller can fall back to a safe triangulation.
 */
function zipper(lo, hi) {
  const n = lo.length, m = hi.length;
  let k0 = 0, best = Infinity;
  hi.forEach(([x, y], k) => { const d = (x - lo[0][0]) ** 2 + (y - lo[0][1]) ** 2; if (d < best) { best = d; k0 = k; } });
  const pL = (i) => lo[i % n], pU = (k) => hi[(k0 + k) % m];
  const rL = (i) => ({ lo: true, i: i % n }), rU = (k) => ({ lo: false, i: (k0 + k) % m });
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const out = [];
  let i = 0, k = 0;
  while (i < n || k < m) {
    const advanceLower = k >= m || (i < n && d2(pL(i + 1), pU(k)) <= d2(pL(i), pU(k + 1)));
    let tri, pts;
    if (advanceLower) { tri = [rL(i), rL(i + 1), rU(k)]; pts = [pL(i), pL(i + 1), pU(k)]; i++; }
    else { tri = [rL(i), rU(k + 1), rU(k)]; pts = [pL(i), pU(k + 1), pU(k)]; k++; }
    if (cross(...pts) < -1e-12) return null;
    out.push(tri);
  }
  return out;
}

/**
 * Second strip strategy, for bands where the shorter-diagonal walk folds (typically a sharp
 * corner on one ring facing a rounded one on the other): pair each upper vertex with its
 * nearest lower vertex, never letting the pairing run backwards, and fan between pairs.
 * Same output and fold rule as zipper.
 */
function nearestZipper(lo, hi) {
  const n = lo.length, m = hi.length;
  const nearest = hi.map(([x, y]) => {
    let best = Infinity, j = 0;
    for (let k = 0; k < n; k++) { const d = (lo[k][0] - x) ** 2 + (lo[k][1] - y) ** 2; if (d < best) { best = d; j = k; } }
    return j;
  });
  const J = [nearest[0]];
  for (let i = 1; i < m; i++) {
    let d = (nearest[i] - nearest[i - 1]) % n;
    if (d > n / 2) d -= n; else if (d < -n / 2) d += n;
    J.push(Math.min(J[0] + n, Math.max(J[i - 1], J[i - 1] + d)));
  }
  J.push(J[0] + n);
  const rL = (j) => ({ lo: true, i: ((j % n) + n) % n }), rU = (i) => ({ lo: false, i: i % m });
  const p = (r) => (r.lo ? lo[r.i] : hi[r.i]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const out = [];
  for (let i = 0; i < m; i++) {
    for (let j = J[i]; j < J[i + 1]; j++) out.push([rL(j), rL(j + 1), rU(i)]);
    out.push([rL(J[i + 1]), rU(i + 1), rU(i)]);
  }
  return out.every((t) => cross(p(t[0]), p(t[1]), p(t[2])) >= -1e-12) ? out : null;
}

/**
 * Last-resort band triangulation: earcut the band (outer lo, hole hi), then flip diagonals
 * so as many triangles as possible touch both rings — a triangle on a single ring lies
 * flat and shows as a terrace. Flips only where the new pair stays CCW, so it never folds;
 * flat triangles remain only where the band genuinely changes shape (walls merging).
 * Indices refer to [...lo, ...hi].
 */
function spanningTriangulation(lo, hi) {
  const pts = [...lo, ...hi];
  const onLo = (v) => v < lo.length;
  const flat = (t) => onLo(t[0]) === onLo(t[1]) && onLo(t[1]) === onLo(t[2]);
  const cross = (a, b, c) => (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]);
  const tris = triangulateRegion(lo, [hi]).map((t) => t.slice());
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const edges = new Map();
  const index = (ti) => { const t = tris[ti]; for (let e = 0; e < 3; e++) { const k = key(t[e], t[(e + 1) % 3]); const l = edges.get(k) || []; if (!l.includes(ti)) l.push(ti); edges.set(k, l); } };
  const unindex = (ti) => { const t = tris[ti]; for (let e = 0; e < 3; e++) { const k = key(t[e], t[(e + 1) % 3]); edges.set(k, (edges.get(k) || []).filter((x) => x !== ti)); } };
  tris.forEach((_, ti) => index(ti));
  for (let pass = 0, changed = true; changed && pass < 50; pass++) {
    changed = false;
    for (let ti = 0; ti < tris.length; ti++) {
      if (!flat(tris[ti])) continue;
      for (let e = 0; e < 3; e++) {
        const t = tris[ti];
        const a = t[e], b = t[(e + 1) % 3], c = t[(e + 2) % 3];
        const ui = (edges.get(key(a, b)) || []).find((x) => x !== ti);
        if (ui === undefined) continue;
        const u = tris[ui];
        const d = u.find((v) => v !== a && v !== b);
        const t2 = [c, a, d], u2 = [c, d, b];
        if (cross(...t2) <= 1e-12 || cross(...u2) <= 1e-12) continue;
        const before = flat(t) + flat(u), after = flat(t2) + flat(u2);
        if (after >= before) continue;
        unindex(ti); unindex(ui);
        tris[ti] = t2; tris[ui] = u2;
        index(ti); index(ui);
        changed = true;
        break;
      }
    }
  }
  return tris;
}

/** Full pipeline: pixel contour -> { outline, mesh, validation, stl() }. */
export function makeCutter(pixelPts, opts = {}) {
  const o = { ...DEFAULTS, ...CUTTER_DEFAULTS, ...opts };
  const res = processOutline(pixelPts, o);
  const mesh = buildCutterMesh(res.outline, o);
  const validation = validateMesh(mesh, { thicknessMM: o.heightMM });
  const cut = bbox(mesh.inner);
  if (Math.abs(Math.max(cut.width, cut.height) - o.sizeMM) > 0.05) {
    validation.errors.push(`Cutting edge is ${Math.max(cut.width, cut.height).toFixed(2)} mm, expected ${o.sizeMM.toFixed(2)} mm.`);
    validation.ok = false;
  }
  return { ...res, mesh, validation, cuttingSize: [cut.width, cut.height], stl: () => meshToSTL(mesh, 'Cookie Cutter and Practice Blank Maker: cutter') };
}
