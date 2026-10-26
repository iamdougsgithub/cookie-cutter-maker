import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { letteringOutline } from '../src/lettering.js';
import { textShapes } from '../src/text.js';
import { makeBlank, bbox, signedArea, isSimplePolygon } from '../src/geometry.js';
import { makeCutter } from '../src/cutter.js';
import { pointInPolygon } from '../src/contours.js';

const bytes = readFileSync(new URL('../fonts/Nunito-ExtraBold.woff', import.meta.url));
const FONT = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));

/** Word as "ink": outer outlines of each letter, in photo pixels (y down), like OpenCV gives. */
function ink(text, cap = 10, scale = 20) {
  return textShapes(FONT, text, cap).shapes.map((s) => s.outer.map(([x, y]) => [100 + x * scale, 400 - y * scale]));
}

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

test('one bubble outline round a word, keeping the border clear of the ink', () => {
  const letters = ink('happy');
  const res = letteringOutline(letters, { borderPct: 6, smoothPct: 5 });
  assert.ok(res.joined, 'one piece');
  assert.ok(isSimplePolygon(res.outline));
  // Every bit of ink is inside, at least most of a border from the edge.
  for (const l of letters) for (const p of l) {
    assert.ok(pointInPolygon(p, res.outline), 'ink inside the cookie');
    assert.ok(distToPoly(p, res.outline) > res.borderPx * 0.9, `ink too close to the edge: ${distToPoly(p, res.outline).toFixed(1)} px`);
  }
  // ...and the edge hugs the lettering rather than being a plain rectangle.
  const area = Math.abs(signedArea(res.outline)), b = bbox(res.outline);
  assert.ok(area < b.width * b.height * 0.9, 'follows the letters, not their bounding box');
});

test('holes inside letters and gaps between them are filled', () => {
  const res = letteringOutline(ink('oo'), { borderPct: 6 });
  // The middle of each "o" is cookie, not a hole: the outline is a single ring with no holes.
  const t = textShapes(FONT, 'oo', 10);
  for (const s of t.shapes) {
    const xs = s.outer.map((q) => q[0]), ys = s.outer.map((q) => q[1]);
    const centre = [100 + ((Math.min(...xs) + Math.max(...xs)) / 2) * 20, 400 - ((Math.min(...ys) + Math.max(...ys)) / 2) * 20];
    assert.ok(pointInPolygon(centre, res.outline), 'centre of the o is inside');
  }
});

test('a wider border gives a bigger, rounder cookie', () => {
  const thin = letteringOutline(ink('happy'), { borderPct: 3 });
  const wide = letteringOutline(ink('happy'), { borderPct: 10 });
  const area = (r) => Math.abs(signedArea(r.outline));
  assert.ok(area(wide) > area(thin) * 1.2);
  assert.ok(bbox(wide.outline).width > bbox(thin.outline).width);
});

test('far-apart pieces are bridged into one cookie', () => {
  // Two blobs 300 px apart: much more than the border, so they need bridging.
  const square = (x0) => [[x0, 100], [x0 + 200, 100], [x0 + 200, 300], [x0, 300]];
  const res = letteringOutline([square(0), square(500)], { borderPct: 6 });
  assert.equal(res.parts, 2, 'two pieces before bridging');
  assert.ok(res.joined, 'bridged into one');
  assert.ok(pointInPolygon([350, 200], res.outline), 'the gap between them is filled');
});

test('no ink: no outline', () => {
  assert.equal(letteringOutline([]), null);
});

test('lettering outlines make valid blanks and cutters', () => {
  const res = letteringOutline(ink('Breathe'), { borderPct: 6 });
  const blank = makeBlank(res.outline, {});
  assert.ok(blank.validation.ok, blank.validation.errors.join('; '));
  const cutter = makeCutter(res.outline, {});
  assert.ok(cutter.validation.ok, cutter.validation.errors.join('; '));
});
