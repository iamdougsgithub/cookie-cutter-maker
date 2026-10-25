import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPolygon, thin, traceSkeleton, extractStampLines } from '../src/lines.js';
import { projectorSVG } from '../src/projector.js';
import { processOutline } from '../src/geometry.js';

const W = 400, H = 400;
const blank = () => new Uint8Array(W * H);
const disc = (m, cx, cy, r, v = 1) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * W + x] = v; };
const ring = (m, cx, cy, r0, r1) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x - cx, y - cy); if (d >= r0 && d <= r1) m[y * W + x] = 1; } };
const bar = (m, x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * W + x] = 1; };
const circlePts = (cx, cy, r, n = 200) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
const len = (pts, closed) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return closed ? L + Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) : L; };

test('fillPolygon matches the polygon area', () => {
  const m = fillPolygon(circlePts(200, 200, 100, 400), W, H);
  const area = m.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(area - Math.PI * 100 * 100) / (Math.PI * 1e4) < 0.01, `area ${area}`);
});

test('a thick bar thins to one centre line', () => {
  const m = blank(); bar(m, 50, 196, 350, 204);
  const lines = traceSkeleton(thin(m, W, H), W, H);
  assert.equal(lines.length, 1);
  const ys = lines[0].pts.map((p) => p[1]);
  assert.ok(Math.min(...ys) >= 198 && Math.max(...ys) <= 202, 'runs down the middle');
  assert.ok(len(lines[0].pts) > 280);
});

test('a thick ring thins to one closed loop', () => {
  const m = blank(); ring(m, 200, 200, 90, 100);
  const lines = traceSkeleton(thin(m, W, H), W, H);
  const loops = lines.filter((l) => l.closed);
  assert.equal(loops.length, 1, JSON.stringify(lines.map((l) => [l.closed, l.pts.length])));
  const rs = loops[0].pts.map(([x, y]) => Math.hypot(x - 200, y - 200));
  assert.ok(Math.min(...rs) > 92 && Math.max(...rs) < 98);
});

test('a plus sign gives branches meeting in the middle', () => {
  const m = blank(); bar(m, 100, 196, 300, 204); bar(m, 196, 100, 204, 300);
  const lines = traceSkeleton(thin(m, W, H), W, H);
  const total = lines.reduce((s, l) => s + len(l.pts, l.closed), 0);
  assert.ok(lines.length >= 2 && lines.length <= 5, `${lines.length} lines`);
  assert.ok(total > 360 && total < 420, `total length ${total}`);
});

test('stamp lines: details inside the cutter wall, wall and specks ignored', () => {
  const m = blank();
  ring(m, 200, 200, 160, 172);           // cutter wall
  bar(m, 120, 196, 280, 203);            // stamp line across the middle
  disc(m, 140, 120, 1.5);                // speck
  const cookie = circlePts(200, 200, 160, 400);
  const lines = extractStampLines(m, W, H, cookie, { lineThickness: 12 });
  assert.equal(lines.length, 1, `${lines.length} lines`);
  const xs = lines[0].pts.map((p) => p[0]), ys = lines[0].pts.map((p) => p[1]);
  assert.ok(Math.min(...xs) < 130 && Math.max(...xs) > 270, 'spans the stamp line');
  assert.ok(Math.min(...ys) > 195 && Math.max(...ys) < 205, 'on its centre');
});

test('stamp lines: a filled blob is drawn as its outline, not a dot', () => {
  const m = blank();
  ring(m, 200, 200, 160, 172);
  disc(m, 200, 200, 40);                 // solid round stamp feature
  const lines = extractStampLines(m, W, H, circlePts(200, 200, 160, 400), { lineThickness: 12 });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].closed);
  const rs = lines[0].pts.map(([x, y]) => Math.hypot(x - 200, y - 200));
  assert.ok(Math.min(...rs) > 36 && Math.max(...rs) < 42, `radius ${Math.min(...rs)}..${Math.max(...rs)}`);
});

test('stamp lines: small solid dots become small circles', () => {
  const m = blank();
  ring(m, 200, 200, 160, 172);
  disc(m, 150, 150, 7); disc(m, 250, 150, 7);
  const lines = extractStampLines(m, W, H, circlePts(200, 200, 160, 400), { lineThickness: 12 });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.closed));
});

test('plain cutter (no stamp) gives no detail lines', () => {
  const m = blank(); ring(m, 200, 200, 160, 172);
  assert.deepEqual(extractStampLines(m, W, H, circlePts(200, 200, 160, 400), { lineThickness: 12 }), []);
});

test('toMM puts details in the same frame as the outline (rotation, mirror, size)', () => {
  // Square cookie 0..400 px with a detail point near its top-left corner.
  const sq = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const corner = [[20, 20]];
  for (const opts of [{}, { mirror: true }, { rotationDeg: 90 }, { sizeMM: 50 }]) {
    const res = processOutline(sq, opts);
    const [[x, y]] = res.toMM(corner);
    const half = (opts.sizeMM ?? 88.9) / 2;
    const inset = (20 / 400) * 2 * half;
    // Top-left in the photo is (-, +) in mm; mirror flips x; +90° turns it to (-, -).
    const ex = opts.mirror ? half - inset : -half + inset;
    const ey = opts.rotationDeg ? -half + inset : half - inset;
    assert.ok(Math.abs(x - ex) < 0.6 && Math.abs(y - ey) < 0.6, `${JSON.stringify(opts)}: got ${x.toFixed(2)},${y.toFixed(2)} expected ${ex.toFixed(2)},${ey.toFixed(2)}`);
  }
});

test('projector SVG: true size, styles and toggles', () => {
  const outline = circlePts(0, 0, 40, 100);
  const lines = [{ pts: [[-20, 0], [20, 0]], closed: false }];
  const a = projectorSVG({ outline, lines, strokeMM: 1, marginMM: 4 });
  assert.match(a.svg, /width="89mm" height="89mm"/);
  assert.equal((a.svg.match(/<path /g) || []).length, 2);
  assert.match(a.svg, /fill="#ffffff"/);
  assert.match(a.svg, /stroke="#000000"/);
  const b = projectorSVG({ outline, lines, invert: true, showOutline: false });
  assert.equal((b.svg.match(/<path /g) || []).length, 1);
  assert.match(b.svg, /stroke="#ffffff"/);
  assert.equal(projectorSVG({ outline, lines, showLines: false }).lineCount, 0);
});
