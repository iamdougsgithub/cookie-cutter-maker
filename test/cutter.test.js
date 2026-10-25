import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCutter, buildCutterMesh, CUTTER_DEFAULTS } from '../src/cutter.js';
import { processOutline, parseSTL, triangulateRegion, bbox } from '../src/geometry.js';
import { textShapes, labelShells } from '../src/text.js';
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';

const fontBytes = readFileSync(new URL('../fonts/Nunito-ExtraBold.woff', import.meta.url));
const FONT = opentype.parse(fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.length));
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

// ---- lip

test('lip: wide, rounded top edge, chamfered bed edge', () => {
  const res = makeCutter(SHAPES.circle, {});
  const { rimWidthMM, rimThicknessMM, lipRadiusMM, lipChamferMM, baseMM } = res.mesh.profile;
  assert.equal(rimWidthMM, 6); assert.equal(rimThicknessMM, 3); assert.equal(lipRadiusMM, 1.5); assert.equal(lipChamferMM, 0.6);
  const lip = res.mesh.lip;
  const width = (ring) => bbox(ring).width;
  const full = 88.9 + 2 * (baseMM + rimWidthMM);
  assert.ok(Math.abs(width(lip[0].ring) - (full - 2 * lipChamferMM)) < 0.1, 'bed ring is inset by the chamfer');
  assert.equal(lip[0].z, 0);
  assert.ok(Math.abs(width(lip.at(-1).ring) - (full - 2 * lipRadiusMM)) < 0.1, 'top ring is inset by the round-over');
  assert.equal(lip.at(-1).z, rimThicknessMM);
  // The round-over is a quarter circle.
  for (const l of lip.filter((q) => q.z > rimThicknessMM - lipRadiusMM)) {
    const dz = l.z - (rimThicknessMM - lipRadiusMM), dx = lipRadiusMM - l.inset;
    assert.ok(Math.abs(Math.hypot(dz, dx) - lipRadiusMM) < 1e-9);
  }
});

// ---- side text

test('text shapes: real letter outlines with holes', () => {
  const t = textShapes(FONT, 'Dispose of after use', 4);
  assert.ok(t.shapes.length >= 17, `${t.shapes.length} shapes`);
  assert.ok(t.shapes.filter((q) => q.holes.length).length >= 6, 'D, o, p, e, a... have holes');
  assert.ok(Math.abs(t.maxV - 4) < 0.6, `cap height ~4 mm, got ${t.maxV.toFixed(2)}`);
  assert.ok(t.width > 45 && t.width < 65, `width ${t.width.toFixed(1)} mm`);
});

test('side text: raised on the outside of the blade, readable as printed', () => {
  const res = makeCutter(SHAPES.circle, { font: FONT });
  assert.ok(res.validation.ok, res.validation.errors.join('; '));
  assert.deepEqual(res.label, { placed: true, capHeightMM: 4, text: 'Dispose of after use' });
  const plain = makeCutter(SHAPES.circle, {});
  const P = res.mesh.positions, start = plain.mesh.positions.length / 3;
  const { heightMM, bevelMM, rimThicknessMM, baseMM } = res.mesh.profile;
  for (let v = start; v < P.length / 3; v++) {
    const z = P[v * 3 + 2], d = distToPoly([P[v * 3], P[v * 3 + 1]], res.mesh.inner);
    assert.ok(z >= rimThicknessMM + 0.79 && z <= heightMM - bevelMM - 0.99, `z ${z}`);
    assert.ok(d > baseMM - 0.45 && d < baseMM + 0.65, `distance from the cut edge ${d.toFixed(2)}`);
  }
  // Reading order follows the CCW tangent (left to right seen from outside, blade up).
  const label = labelShells(FONT, 'Dispose of after use', res.mesh.base, { zMin: 3.8, zMax: 14.5 });
  const centroid = (from, to) => { let x = 0, y = 0; for (let v = from; v < to; v++) { x += label.positions[v * 3]; y += label.positions[v * 3 + 1]; } return [x / (to - from), y / (to - from)]; };
  const ss = label.shapeStarts, nv = label.positions.length / 3;
  const a0 = Math.atan2(...centroid(ss[0], ss[1]).reverse()), a1 = Math.atan2(...centroid(ss.at(-1), nv).reverse());
  let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
  assert.ok(da > 0, 'first letter comes before the last going counter-clockwise');
});

test('side text on curved and tricky shapes: placed or skipped, never a broken mesh', () => {
  for (const name of ['heart', 'figure', 'square']) {
    const res = makeCutter(SHAPES[name], { font: FONT });
    assert.ok(res.validation.ok, `${name}: ${res.validation.errors.join('; ')}`);
    assert.ok(res.label.placed || res.label.reason, name);
  }
  assert.ok(makeCutter(SHAPES.heart, { font: FONT }).label.placed, 'the heart has room for it');
  const tiny = makeCutter(SHAPES.star, { font: FONT, sizeMM: 40 });
  assert.ok(tiny.validation.ok);
  assert.equal(tiny.label.placed, false);
  assert.match(tiny.label.reason, /long enough/);
  assert.equal(makeCutter(SHAPES.circle, { font: FONT, labelText: '   ' }).label, null, 'blank text: no label');
});
