import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCutter, buildCutterMesh, CUTTER_DEFAULTS } from '../src/cutter.js';
import { processOutline, parseSTL, triangulateRegion } from '../src/geometry.js';
import { figurePoints } from '../tools/figure-path.js';

const C = 500;
const circle = (r, n = 400) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return [C + r * Math.cos(t), C + r * Math.sin(t)]; });
const square = (s) => [[C - s / 2, C - s / 2], [C + s / 2, C - s / 2], [C + s / 2, C + s / 2], [C - s / 2, C + s / 2]];
const star = (ro, ri) => Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? ri : ro; const t = -Math.PI / 2 + (Math.PI * i) / 5; return [C + r * Math.cos(t), C + r * Math.sin(t)]; });
const heart = (s, n = 600) => Array.from({ length: n }, (_, i) => {
  const t = (2 * Math.PI * i) / n;
  return [C + s * 16 * Math.sin(t) ** 3, C - s * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))];
});

const SHAPES = { circle: circle(300), square: square(600), star: star(320, 130), heart: heart(18), figure: figurePoints() };

/** Distance from point p to the closest segment of a closed polygon. */
function distToPoly([x, y], poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

for (const [name, pts] of Object.entries(SHAPES)) {
  test(`cutter ${name}: watertight, manifold, cuts the right size`, () => {
    const res = makeCutter(pts, {});
    assert.ok(res.validation.ok, res.validation.errors.join('; '));
    assert.ok(Math.abs(Math.max(...res.cuttingSize) - 88.9) < 0.01, `cutting edge ${res.cuttingSize}`);
    assert.ok(Math.abs(res.validation.bounds.size[2] - CUTTER_DEFAULTS.heightMM) < 1e-9);
    assert.ok(res.validation.volume > 0);
  });
}

test('cutter circle: rim and blade dimensions', () => {
  const res = makeCutter(SHAPES.circle, {});
  const [w, h] = res.validation.bounds.size;
  const expected = 88.9 + 2 * (CUTTER_DEFAULTS.baseMM + CUTTER_DEFAULTS.rimWidthMM);
  assert.ok(Math.abs(w - expected) < 0.15 && Math.abs(h - expected) < 0.15, `${w} x ${h}, expected ${expected}`);
  // Blade is tipMM at the edge and full baseMM thickness from the bevel's shoulder down.
  const thick = (ring) => ring.map((p) => distToPoly(p, res.mesh.inner));
  const range = (v, lo, hi, what) => assert.ok(Math.min(...v) > lo && Math.max(...v) < hi, `${what} ${Math.min(...v).toFixed(3)}..${Math.max(...v).toFixed(3)}`);
  range(thick(res.mesh.tip), 0.38, 0.45, 'tip');
  range(thick(res.mesh.shoulder), 1.57, 1.65, 'shoulder');
  range(thick(res.mesh.base), 1.57, 1.65, 'base');
  assert.equal(res.mesh.profile.bevelMM, 2.5);
});

test('cutter bevel: sharpened profile, or a plain taper with bevel 0', () => {
  const res = makeCutter(SHAPES.circle, {});
  const { tipMM, shoulderMM, bevelMM } = res.mesh.profile;
  // A chisel edge: the blade narrows to under a third of its thickness, at a clearly
  // visible angle (not a near-vertical taper).
  const angle = (Math.atan((shoulderMM - tipMM) / bevelMM) * 180) / Math.PI;
  assert.ok(angle > 20, `bevel angle ${angle.toFixed(1)}°`);
  assert.ok(tipMM < shoulderMM / 3);
  const flat = makeCutter(SHAPES.circle, { bevelMM: 0 });
  assert.ok(flat.validation.ok, flat.validation.errors.join('; '));
  assert.equal(flat.mesh.shoulder, null);
});

test('cutter is mirrored so it cuts the shape the right way round', () => {
  // An "L": as printed (rim down, blade up) the cutter must look like the mirror image.
  const L = [[200, 200], [400, 200], [400, 600], [700, 600], [700, 800], [200, 800]];
  const outline = processOutline(L, {}).outline;
  const mesh = buildCutterMesh(outline, {});
  // The top of the L's upright sits wholly on one side of centre.
  const topSide = (pts) => { const maxY = Math.max(...pts.map((p) => p[1])); const top = pts.filter((p) => p[1] > maxY * 0.6); return top.reduce((s, p) => s + p[0], 0) / top.length; };
  assert.ok(topSide(outline) < 0, 'cookie: upright on the left');
  assert.ok(topSide(mesh.inner) > 0, 'printed cutter: upright on the right');
});

test('cutter settings: height, blade and rim', () => {
  const res = makeCutter(SHAPES.star, { heightMM: 25, tipMM: 1.0, baseMM: 2.0, rimWidthMM: 6, sizeMM: 76.2 });
  assert.ok(res.validation.ok, res.validation.errors.join('; '));
  assert.equal(res.validation.bounds.size[2], 25);
  assert.ok(Math.abs(Math.max(...res.cuttingSize) - 76.2) < 0.01);
  assert.throws(() => makeCutter(SHAPES.star, { baseMM: 0.5, tipMM: 0.8 }));
  assert.throws(() => makeCutter(SHAPES.star, { heightMM: 4 }));
});

test('cutting edge stays sharp at tight inside corners', () => {
  // Heart's top dip, star's inner corners, the figure's neck, armpits and hands.
  for (const name of ['heart', 'star', 'figure']) {
    const res = makeCutter(SHAPES[name], {});
    assert.ok(res.validation.ok, `${name}: ${res.validation.errors.join('; ')}`);
    const widths = res.mesh.tip.map((p) => distToPoly(p, res.mesh.inner));
    assert.ok(Math.max(...widths) < 0.45, `${name}: edge up to ${Math.max(...widths).toFixed(2)} mm wide`);
  }
});

test('bevel never folds over itself (faces up and out everywhere)', () => {
  for (const name of ['heart', 'star', 'figure']) {
    for (const bevelMM of [2.5, 0]) {
      const res = makeCutter(SHAPES[name], { bevelMM });
      const P = res.mesh.positions, I = res.mesh.indices, H = res.mesh.profile.heightMM;
      const zLow = bevelMM ? H - bevelMM : res.mesh.profile.rimThicknessMM;
      let down = 0;
      for (let t = 0; t < I.length; t += 3) {
        const v = [0, 1, 2].map((k) => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]);
        if (v.some((q) => q[2] < zLow - 1e-9)) continue; // only the bevel band and the edge
        const nz = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0]);
        if (nz < -1e-9) down++;
      }
      assert.equal(down, 0, `${name} bevel ${bevelMM}: ${down} folded triangles`);
    }
  }
});

test('cutter STL round-trips', () => {
  const res = makeCutter(SHAPES.heart, {});
  const tris = parseSTL(res.stl());
  assert.equal(tris.length, res.mesh.indices.length / 3);
});

test('narrow gaps: neighbouring walls merge instead of overlapping', () => {
  // Two lobes 1 mm apart (11 px at this scale): the blades meet and must merge cleanly.
  const k = 1 / 0.0889;
  const pts = [[0, 0], [1000, 0], [1000, 600], [500 + 0.5 * k, 600], [500 + 0.5 * k, 200], [500 - 0.5 * k, 200], [500 - 0.5 * k, 600], [0, 600]];
  const res = makeCutter(pts, {});
  assert.ok(res.validation.ok, res.validation.errors.join('; '));
});

test('region triangulation with a hole uses every vertex', () => {
  const outer = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]];
  const hole = [[3, 3], [3, 7], [5, 7], [7, 7], [7, 3]];
  const tris = triangulateRegion(outer, [hole]);
  assert.equal(new Set(tris.flat()).size, outer.length + hole.length);
  let area = 0;
  const all = [...outer, ...hole];
  for (const [a, b, c] of tris) area += ((all[b][0] - all[a][0]) * (all[c][1] - all[a][1]) - (all[c][0] - all[a][0]) * (all[b][1] - all[a][1])) / 2;
  assert.ok(Math.abs(area - 84) < 1e-9, `area ${area}`);
});
