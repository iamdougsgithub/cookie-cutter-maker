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
//                  │  │ inside face: vertical, exactly the outline; optional raised side
//                  │  │ text on the outside face
//   z = lipT       │  └──────╮  lip: rimWidthMM beyond the blade, rounded top edge
//   z = 0          └─────────╯  (lipRadiusMM) and a small bed chamfer (lipChamferMM)
//
// With bevelMM = 0 the outside face is instead a plain taper from baseMM to tipMM.

import {
  DEFAULTS, ensureCCW, inwardNormals, offsetPolygon, perimeter, processOutline,
  resampleClosed, triangulateRegion, validateMesh, meshToSTL, bbox,
} from './geometry.js';
import { labelShells } from './text.js';

export const CUTTER_DEFAULTS = Object.freeze({
  heightMM: 18,          // overall height, lip included
  tipMM: 0.4,            // cutting edge: one perimeter with a 0.4 mm nozzle
  bevelMM: 2.5,          // height of the sharpening bevel at the top of the blade
  baseMM: 1.6,           // blade thickness below the bevel
  rimWidthMM: 6,         // lip beyond the blade
  rimThicknessMM: 3,     // lip thickness
  lipRadiusMM: 1.5,      // round-over on the lip's outer top edge (the edge you hold)
  lipChamferMM: 0.6,     // 45° chamfer on the lip's bed edge (prints cleanly, no elephant's foot)
  labelText: 'Dispose of after use',
});

const spacedRing = (pts, spacing = 0.4) => ensureCCW(resampleClosed(pts, Math.max(360, Math.round(perimeter(pts) / spacing))));

function outward(pts, d) {
  const polys = offsetPolygon(pts, d);
  if (!polys.length) throw new Error('Could not offset the outline for the cutter wall.');
  return polys[0];
}

/**
 * Build the cutter mesh from a cookie outline (mm, CCW, as seen on the cookie's top).
 * opts.font (an opentype.js Font) + opts.labelText add raised text on the blade's outside.
 * Returns { positions, indices, rings, inner, tip, shoulder, base, rim, profile, label, flatBands }.
 */
export function buildCutterMesh(outline, opts = {}) {
  const o = { ...CUTTER_DEFAULTS, ...opts };
  const H = o.heightMM, T = o.rimThicknessMM;
  if (!(o.tipMM > 0) || o.baseMM < o.tipMM) throw new Error('Blade must be at least as thick at the base as at the tip.');
  if (H < T + 3) throw new Error(`Height must be at least ${(T + 3).toFixed(0)} mm.`);
  if (!(o.rimWidthMM >= 1)) throw new Error('Lip must be at least 1 mm wide.');

  const inner = ensureCCW(outline.map(([x, y]) => [-x, y])); // mirrored for print orientation
  const bevel = Math.max(0, Math.min(o.bevelMM ?? 0, H - T - 1));

  // Every outside ring is an exact Clipper offset of the outline (round joins; walls that
  // meet across a narrow gap merge), so the cutting edge is tipMM wide everywhere —
  // including tight inside corners. Rings with different vertex counts are joined by
  // fold-checked strips (band, below).
  const tip = spacedRing(outward(inner, o.tipMM));
  const base = spacedRing(outward(inner, o.baseMM));
  const shoulder = bevel > 0 ? base : null; // full thickness right up to the bevel
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

  // Lip profile, bottom to top: (z, inset from the lip's outer edge). The outer edge is an
  // offset of the blade base, so its outside curves are at least rimWidthMM in radius; the
  // insets (≤ lipRadiusMM) are plain per-point shifts of it, so every lip ring has the same
  // vertices and neighbouring rings join with simple quads.
  const chamfer = Math.max(0, Math.min(o.lipChamferMM, T / 3, o.rimWidthMM / 3));
  const lipR = Math.max(0, Math.min(o.lipRadiusMM, T - chamfer - 0.2, o.rimWidthMM - 1));
  const lipProfile = [];
  if (chamfer > 0) lipProfile.push({ z: 0, inset: chamfer });
  lipProfile.push({ z: chamfer, inset: 0 });
  if (lipR > 0) {
    const segs = 8;
    lipProfile.push({ z: T - lipR, inset: 0 });
    for (let k = 1; k <= segs; k++) {
      const th = (k / segs) * (Math.PI / 2);
      lipProfile.push({ z: T - lipR + lipR * Math.sin(th), inset: lipR * (1 - Math.cos(th)) });
    }
    lipProfile[lipProfile.length - 1].z = T;
  } else {
    lipProfile.push({ z: T, inset: 0 });
  }
  const rim = spacedRing(outward(base, o.rimWidthMM)); // outermost lip ring (footprint)
  const rimIn = inwardNormals(rim);
  const lip = lipProfile.map((p, k) => ({
    ...p, name: `lip${k}`,
    ring: p.inset ? rim.map(([x, y], i) => [x + rimIn[i][0] * p.inset, y + rimIn[i][1] * p.inset]) : rim,
  }));

  // Vertex layout: each ring placed at its z.
  const layout = [
    ['inner0', inner, 0], ['inner1', inner, H],
    ...lip.map((l) => [l.name, l.ring, l.z]),
    ['base', base, T], ...(shoulder ? [['shoulder', shoulder, H - bevel]] : []),
    ...levels.slice(1, -1).map((l, k) => [`level${k + 1}`, l.ring, l.z]),
    ['tip', tip, H],
  ];
  const at = {};
  let count = 0;
  for (const [name, ring] of layout) { at[name] = count; count += ring.length; }
  const positions = [];
  for (const [, ring, z] of layout) for (const [x, y] of ring) positions.push(x, y, z);

  const tris = [];
  const flatBands = [];
  // Side wall between two corresponding rings; flip = face toward the ring's inside.
  const wall = (lo, hi, n, flip) => {
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const a = lo + i, b = lo + i1, c = hi + i1, d = hi + i;
      if (flip) tris.push(a, c, b, a, d, c); else tris.push(a, b, c, a, c, d);
    }
  };
  // Flat annular faces: region between an outer ring and a hole ring.
  const face = (outerName, outerRing, holeName, holeRing, up) => {
    const local = triangulateRegion(outerRing, [holeRing]);
    const map = (k) => (k < outerRing.length ? at[outerName] + k : at[holeName] + k - outerRing.length);
    for (const [a, b, c] of local) {
      if (up) tris.push(map(a), map(b), map(c)); else tris.push(map(a), map(c), map(b));
    }
  };
  // Sloped band between an outer and an inner ring (in plan view) at different heights:
  // a zipper strip where every triangle touches both rings, so the slope is even; if that
  // would fold, nearest-point pairing; failing that, a flat triangulation with diagonals
  // flipped to span the rings. facesUp: the inner ring is the higher one.
  const band = (outerName, outer, innerName, innerRing, facesUp, tag) => {
    let local;
    const strip = zipper(outer, innerRing) ?? nearestZipper(outer, innerRing);
    if (strip) {
      local = strip.map((t) => t.map((r) => (r.lo ? at[outerName] + r.i : at[innerName] + r.i)));
    } else {
      flatBands.push(tag);
      local = spanningTriangulation(outer, innerRing)
        .map((t) => t.map((v) => (v < outer.length ? at[outerName] + v : at[innerName] + v - outer.length)));
    }
    for (const [a, b, c] of local) if (facesUp) tris.push(a, b, c); else tris.push(a, c, b);
  };

  wall(at.inner0, at.inner1, inner.length, true); // inside face looks into the cookie
  if (shoulder) wall(at.base, at.shoulder, base.length, false); // vertical, full thickness
  face(lip[0].name, lip[0].ring, 'inner0', inner, false);              // underside, on the bed
  face(lip.at(-1).name, lip.at(-1).ring, 'base', base, true);          // top of the lip
  face('tip', tip, 'inner1', inner, true);                             // cutting edge
  // Lip: matching rings, so plain quads; they face out-and-down on the chamfer and
  // out-and-up on the round-over automatically.
  for (let k = 0; k + 1 < lip.length; k++) wall(at[lip[k].name], at[lip[k + 1].name], rim.length, false);
  const levelName = (k) => (k === 0 ? 'tip' : k === levels.length - 1 ? (shoulder ? 'shoulder' : 'base') : `level${k}`);
  for (let k = 0; k + 1 < levels.length; k++) band(levelName(k + 1), levels[k + 1].ring, levelName(k), levels[k].ring, true, k);

  // Raised side text: separate closed solids, sunk slightly into the outside face of the
  // blade between the lip and the bevel. Slicers merge overlapping solids when printing.
  let label = null;
  if (o.font && o.labelText && o.labelText.trim()) {
    label = labelShells(o.font, o.labelText.trim(), base, {
      zMin: T + 0.8, zMax: (shoulder ? H - bevel : H) - 1.0,
    });
    if (label.positions) {
      const off = positions.length / 3;
      positions.push(...label.positions);
      for (const v of label.indices) tris.push(v + off);
    }
  }

  const profile = {
    tipMM: o.tipMM, shoulderMM: shoulder ? o.baseMM : null, baseMM: o.baseMM, bevelMM: bevel, heightMM: H,
    rimThicknessMM: T, rimWidthMM: o.rimWidthMM, lipRadiusMM: lipR, lipChamferMM: chamfer,
  };
  return {
    positions: Float64Array.from(positions), indices: Uint32Array.from(tris),
    rings: [inner, tip, ...(shoulder ? [shoulder] : []), base, ...lip.map((l) => l.ring).filter((r, i, a) => a.indexOf(r) === i)],
    inner, tip, shoulder, base, rim, lip, profile, flatBands,
    label: label && (label.positions ? { placed: true, capHeightMM: label.capHeightMM, text: o.labelText.trim() } : { placed: false, reason: label.reason }),
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
  return { ...res, mesh, validation, cuttingSize: [cut.width, cut.height], label: mesh.label, stl: () => meshToSTL(mesh, 'Cookie Cutter and Practice Blank Maker: cutter') };
}
