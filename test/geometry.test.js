import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, makeBlank, buildMesh, validateMesh, meshToSTL, parseSTL, edgeProfile,
  signedArea, bbox, processOutline, triangulateCap,
} from '../src/geometry.js';
import { findCookieCandidates, centerlineOf, candidateAt, guessMode, pointInPolygon } from '../src/contours.js';

// ---- test shapes, in pixel space (y-down), centred at (500, 500)
const C = 500;
const circle = (r, n = 400, cx = C, cy = C) =>
  Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; });
const square = (s) => [[C - s / 2, C - s / 2], [C + s / 2, C - s / 2], [C + s / 2, C + s / 2], [C - s / 2, C + s / 2]];
const star = (ro, ri, k = 5) =>
  Array.from({ length: 2 * k }, (_, i) => { const r = i % 2 ? ri : ro; const t = -Math.PI / 2 + (Math.PI * i) / k; return [C + r * Math.cos(t), C + r * Math.sin(t)]; });
const heart = (s, n = 600) =>
  Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return [C + s * x, C - s * y];
  });

const SHAPES = {
  circle: circle(300),
  square: square(600),
  star: star(320, 130),
  heart: heart(18),
};

/** Local radius of curvature via the circumcircle of points k apart. +convex / -concave. */
function minRadii(pts, spanMM = 1.2) {
  const n = pts.length;
  const step = perim(pts) / n;
  const k = Math.max(1, Math.round(spanMM / step));
  let convex = Infinity, concave = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - k + n) % n], b = pts[i], c = pts[(i + k) % n];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const R = (ab * bc * ca) / (2 * Math.abs(cross));
    if (cross > 0) convex = Math.min(convex, R); else concave = Math.min(concave, R);
  }
  return { convex, concave };
}
function perim(p) { let L = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; L += Math.hypot(q[0] - p[i][0], q[1] - p[i][1]); } return L; }

for (const [name, pts] of Object.entries(SHAPES)) {
  test(`${name}: watertight, manifold, correct size`, () => {
    const res = makeBlank(pts, {});
    const v = res.validation;
    assert.ok(v.ok, `validation failed: ${v.errors.join('; ')}`);
    const [w, h, t] = v.bounds.size;
    assert.ok(Math.abs(Math.max(w, h) - 88.9) < 0.01, `longest side ${Math.max(w, h)}`);
    assert.ok(Math.abs(t - 12.7) < 1e-9, `thickness ${t}`);
    assert.ok(v.volume > 0);
    assert.ok(res.outline.length >= 720);
    assert.ok(signedArea(res.outline) > 0, 'outline is CCW');
  });

  test(`${name}: strict mode rounds every corner to >= 3 mm`, () => {
    const res = makeBlank(pts, { convexRadiusMM: 3, notchWidthMM: 6 });
    assert.ok(res.validation.ok, res.validation.errors.join('; '));
    const r = minRadii(res.outline);
    assert.ok(r.convex >= 2.85, `convex radius ${r.convex.toFixed(2)} mm`);
    assert.ok(r.concave >= 2.85, `concave radius ${r.concave.toFixed(2)} mm`);
  });
}

test('narrow slots survive by default, and fill when asked', () => {
  // 1000 x 600 px block (1 px = 0.0889 mm) with a 34 px (3 mm) wide, 300 px deep slot.
  const slot = [[0, 0], [483, 0], [483, 300], [517, 300], [517, 0], [1000, 0], [1000, 600], [0, 600]];
  const inSlot = [500, 150];
  const def = makeBlank(slot, {});
  assert.ok(def.validation.ok, def.validation.errors.join('; '));
  assert.equal(pointInPolygon(inSlot, def.overlayPx), false, '3 mm slot kept');
  assert.equal(pointInPolygon([500, 290], def.overlayPx), false, 'slot keeps nearly its full depth');
  const filled = makeBlank(slot, { notchWidthMM: 6 });
  assert.ok(filled.validation.ok);
  assert.equal(pointInPolygon(inSlot, filled.overlayPx), true, 'slot filled with 6 mm notch width');
});

test('small shoulder-style notch is not smoothed away', () => {
  // A 2 mm deep, 2.5 mm wide V notch in the side of a block.
  const k = 1 / 0.0889; // px per mm
  const v = [[0, 0], [1000, 0], [1000, 300 - 1.25 * k], [1000 - 2 * k, 300], [1000, 300 + 1.25 * k], [1000, 600], [0, 600]];
  const res = makeBlank(v, {});
  const minX = Math.min(...res.overlayPx.filter(([, y]) => Math.abs(y - 300) < 5).map(([x]) => x));
  const depthMM = (1000 - minX) / k;
  assert.ok(depthMM > 1.2, `notch depth kept: ${depthMM.toFixed(2)} mm`);
});

test('circle: dimensions and volume are what the geometry says', () => {
  const { validation: v } = makeBlank(SHAPES.circle, {});
  const [w, h] = v.bounds.size;
  assert.ok(Math.abs(w - 88.9) < 0.05 && Math.abs(h - 88.9) < 0.05, `${w} x ${h}`);
  const r = 88.9 / 2, T = 12.7;
  // Cylinder minus the round-over ring (r²(1-π/4) cross-section, r=2) and the chamfer ring.
  const chamferLoss = 2 * Math.PI * r * (0.4 * 0.4 / 2);
  const expected = Math.PI * r * r * T - (2 * Math.PI * r * (2 * 2 * (1 - Math.PI / 4))) - chamferLoss;
  assert.ok(Math.abs(v.volume - expected) / expected < 0.003, `volume ${v.volume} vs ${expected}`);
});

test('square: stays square, settings respected (size, thickness, rotation)', () => {
  const sizeMM = 76.2, thicknessMM = 10;
  const res = makeBlank(SHAPES.square, { sizeMM, thicknessMM });
  assert.ok(res.validation.ok, res.validation.errors.join('; '));
  const [w, h, t] = res.validation.bounds.size;
  assert.ok(Math.abs(w - sizeMM) < 0.01 && Math.abs(h - sizeMM) < 0.05, `${w} x ${h}`);
  assert.ok(Math.abs(t - thicknessMM) < 1e-9);
  // Rotated 45°, the diagonal becomes the longest side, still scaled to sizeMM.
  const rot = makeBlank(SHAPES.square, { sizeMM, rotationDeg: 45 });
  assert.ok(rot.validation.ok, rot.validation.errors.join('; '));
  assert.ok(Math.abs(Math.max(...rot.validation.bounds.size.slice(0, 2)) - sizeMM) < 0.01);
});

test('mirror flips the shape left-right and keeps it valid', () => {
  // An "L" — asymmetric, so mirroring is observable.
  const L = [[200, 200], [400, 200], [400, 600], [700, 600], [700, 800], [200, 800]];
  const a = processOutline(L, {}).outline;
  const b = processOutline(L, { mirror: true }).outline;
  const cx = (pts) => pts.reduce((s, p) => s + p[0] * (p[1] < 0 ? 1 : 0), 0);
  // Lower half's mass is on the right in one and on the left in the other.
  assert.ok(Math.sign(cx(a)) === -Math.sign(cx(b)) && cx(a) !== 0);
  assert.ok(signedArea(b) > 0);
  const m = buildMesh(b, {});
  assert.ok(validateMesh(m, { sizeMM: 88.9, thicknessMM: 12.7 }).ok);
});

test('edge profile: chamfer, vertical wall, quarter-circle round-over', () => {
  const p = edgeProfile({ thicknessMM: 12.7 });
  assert.deepEqual(p[0], { z: 0, inset: 0.4 });
  assert.deepEqual(p[1], { z: 0.4, inset: 0 });
  assert.equal(p.length, 2 + 17);
  assert.ok(Math.abs(p[2].z - 10.7) < 1e-9 && p[2].inset === 0);
  assert.equal(p.at(-1).z, 12.7);
  assert.ok(Math.abs(p.at(-1).inset - 2) < 1e-9);
  for (const q of p.slice(2)) {
    const dz = q.z - 10.7, dx = 2 - q.inset; // distance from arc centre
    assert.ok(Math.abs(Math.hypot(dz, dx) - 2) < 1e-9);
  }
  assert.throws(() => edgeProfile({ thicknessMM: 2 }));
});

test('STL is binary with one record per triangle', () => {
  const res = makeBlank(SHAPES.heart, {});
  const buf = res.stl();
  const nt = res.mesh.indices.length / 3;
  assert.equal(buf.byteLength, 84 + 50 * nt);
  const tris = parseSTL(buf);
  assert.equal(tris.length, nt);
  const zs = tris.flat().map((v) => v[2]);
  assert.ok(Math.abs(Math.max(...zs) - 12.7) < 1e-5 && Math.min(...zs) === 0);
});

test('cap triangulation keeps collinear vertices (no T-junctions)', () => {
  // A square with many collinear points per side — earcut drops these on its own.
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push([i, 0]);
  for (let i = 0; i < 10; i++) pts.push([10, i]);
  for (let i = 0; i < 10; i++) pts.push([10 - i, 10]);
  for (let i = 0; i < 10; i++) pts.push([0, 10 - i]);
  const tris = triangulateCap(pts);
  const used = new Set(tris.flat());
  assert.equal(used.size, pts.length);
  // Every boundary edge is in exactly one triangle.
  const edges = new Map();
  for (const t of tris) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; edges.set(`${a},${b}`, (edges.get(`${a},${b}`) || 0) + 1); }
  for (let i = 0; i < pts.length; i++) assert.equal(edges.get(`${i},${(i + 1) % pts.length}`), 1, `edge ${i}`);
});

test('validation catches a broken mesh', () => {
  const m = buildMesh(processOutline(SHAPES.circle).outline, {});
  const broken = { ...m, indices: m.indices.slice(0, m.indices.length - 3) };
  const v = validateMesh(broken, { sizeMM: 88.9, thicknessMM: 12.7 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /open edge/.test(e)));
  const flipped = { ...m, indices: m.indices.slice() };
  [flipped.indices[0], flipped.indices[1]] = [flipped.indices[1], flipped.indices[0]];
  assert.equal(validateMesh(flipped, {}).ok, false);
  assert.equal(validateMesh(m, { sizeMM: 80, thicknessMM: 12.7 }).ok, false, 'wrong size is flagged');
});

test('thin parts are kept, with a narrower round-over', () => {
  // A block with a 2 mm wide arm sticking out — too thin for two 2 mm round-overs.
  const k = 1 / 0.0889; // px per mm at 88.9 mm across 1000 px
  const arm = [[0, 0], [600, 0], [600, 280], [1000, 280], [1000, 280 + 2 * k], [600, 280 + 2 * k], [600, 600], [0, 600]];
  const res = makeBlank(arm, {});
  assert.ok(res.validation.ok, res.validation.errors.join('; '));
  assert.equal(pointInPolygon([950, 280 + k], res.overlayPx), true, 'arm tip is still there');
  assert.ok(res.mesh.reducedFraction > 0, 'round-over narrowed somewhere');
  const scale = res.mesh.edgeScale;
  assert.ok(Math.min(...scale) < 0.5 && Math.max(...scale) === 1, 'full profile on the block, reduced on the arm');
});

test('minifigure drawing keeps its C-shaped hands', async () => {
  const { figurePoints } = await import('../tools/figure-path.js');
  const fig = figurePoints();
  const res = makeBlank(fig, {});
  assert.ok(res.validation.ok, res.validation.errors.join('; '));
  // A point in the middle of the right hand's ring (between r 22 and r 48 about (670, 748)).
  assert.equal(pointInPolygon([670, 748 + 35], res.overlayPx), true, 'right hand kept');
  assert.equal(pointInPolygon([130, 748 + 35], res.overlayPx), true, 'left hand kept');
  assert.equal(pointInPolygon([670, 748], res.overlayPx), false, 'hole of the hand stays open');
});

test('sliver shapes still give a valid (if edge-less) mesh', () => {
  const sliver = [[0, 0], [1000, 0], [1000, 10], [0, 10]]; // 0.9 mm wide
  const res = makeBlank(sliver, {});
  assert.ok(res.validation.ok, res.validation.errors.join('; '));
});

// ---- contour selection

test('ring-shaped cutter contour yields the inner outline', () => {
  // Cutter wall: outer r=300, inner r=280. Inside: a stamp detail ring (r=120/100)
  // and a speck of noise. Hierarchy rows are [next, prev, firstChild, parent].
  const contours = [
    circle(300).map(([x, y]) => [x, y]),       // 0 outer edge of the wall
    circle(280),                                // 1 inner edge of the wall = cookie
    circle(120, 200, 520, 480),                 // 2 stamp detail outer
    circle(100, 200, 520, 480),                 // 3 stamp detail inner
    circle(6, 20, 400, 600),                    // 4 noise speck
  ];
  const hierarchy = [
    [-1, -1, 1, -1],
    [-1, -1, 2, 0],
    [4, -1, 3, 1],
    [-1, -1, -1, 2],
    [-1, 2, -1, 1],
  ];
  const cands = findCookieCandidates(contours, hierarchy, { width: 1000, height: 1000 });
  assert.equal(cands.length, 1, 'stamp detail and noise are ignored');
  assert.equal(cands[0].index, 1);
  assert.equal(cands[0].kind, 'inner');
  assert.ok(Math.abs(cands[0].lineThickness - 20) < 1, `wall thickness ${cands[0].lineThickness}`);

  // Centerline sits halfway through the wall.
  const mid = centerlineOf(cands[0]);
  const rs = mid.map(([x, y]) => Math.hypot(x - C, y - C));
  assert.ok(Math.abs(Math.min(...rs) - 290) < 1.5 && Math.abs(Math.max(...rs) - 290) < 1.5);

  // Pipeline turns it into the right-size circle.
  const res = makeBlank(cands[0].points, {});
  assert.ok(res.validation.ok);
  const b = bbox(res.outline);
  assert.ok(Math.abs(b.width - 88.9) < 0.05 && Math.abs(b.height - 88.9) < 0.1);
});

test('several cookies: all offered, click selects the one under the pointer', () => {
  const contours = [circle(150, 200, 250, 500), circle(135, 200, 250, 500), circle(200, 200, 700, 500), circle(185, 200, 700, 500)];
  const hierarchy = [[2, -1, 1, -1], [-1, -1, -1, 0], [-1, 0, 3, -1], [-1, -1, -1, 2]];
  const cands = findCookieCandidates(contours, hierarchy, { width: 1000, height: 1000 });
  assert.deepEqual(cands.map((c) => c.index), [3, 1]);
  assert.equal(candidateAt(cands, [250, 500]), 1);
  assert.equal(candidateAt(cands, [700, 520]), 0);
  assert.equal(candidateAt(cands, [20, 20]), -1);
});

test('blob touching the frame edge (table around the paper) is not a cookie', () => {
  const frame = [[0, 0], [999, 0], [999, 999], [0, 999]];
  const paper = [[50, 50], [950, 50], [950, 950], [50, 950]];
  const contours = [frame, paper, circle(200), circle(185)];
  const hierarchy = [[-1, -1, 1, -1], [-1, -1, 2, 0], [-1, -1, 3, 1], [-1, -1, -1, 2]];
  const cands = findCookieCandidates(contours, hierarchy, { width: 1000, height: 1000 });
  assert.deepEqual(cands.map((c) => c.index), [3]);
});

test('solid silhouette (no ring) falls back to the outer contour', () => {
  const cands = findCookieCandidates([circle(250)], [[-1, -1, -1, -1]], { width: 1000, height: 1000 });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].kind, 'outer');
});

test('defaults match the spec', () => {
  assert.equal(DEFAULTS.sizeMM, 88.9);
  assert.equal(DEFAULTS.thicknessMM, 12.7);
  assert.equal(DEFAULTS.topRadiusMM, 2.0);
  assert.equal(DEFAULTS.chamferMM, 0.4);
  assert.ok(DEFAULTS.arcSegments >= 16);
  assert.equal(DEFAULTS.points, 720);
  assert.equal(DEFAULTS.convexRadiusMM, 0, 'thin parts are kept by default');
});

test('auto mode: uniform ring reads as a cutter, wobbly line as a drawing', () => {
  const ring = findCookieCandidates([circle(300), circle(282)], [[-1, -1, 1, -1], [-1, -1, -1, 0]], { width: 1000, height: 1000 })[0];
  assert.equal(guessMode({ candidate: ring, foregroundIsDark: true }), 'cutter');
  // Same shape, but the line width wobbles between ~6 and ~18 px.
  const wobbly = circle(282).map(([x, y], i) => { const t = (2 * Math.PI * i) / 400; const r = 300 + 6 * Math.sin(7 * t); return [C + r * Math.cos(t), C + r * Math.sin(t)]; });
  const drawn = findCookieCandidates([wobbly, circle(288)], [[-1, -1, 1, -1], [-1, -1, -1, 0]], { width: 1000, height: 1000 })[0];
  assert.equal(guessMode({ candidate: drawn, foregroundIsDark: true }), 'drawing');
  assert.equal(guessMode({ candidate: drawn, foregroundIsDark: false }), 'cutter', 'light shape on dark = cutter');
  assert.equal(guessMode({ candidate: drawn, foregroundIsDark: true, colored: true }), 'cutter', 'coloured plastic = cutter');
});
