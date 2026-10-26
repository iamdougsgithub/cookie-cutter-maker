import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbToLab, deltaE, sampleColor, colorMask, toHex } from '../src/colorpick.js';

/** Test image: background colour, with rectangles of other colours painted on. */
function image(w, h, bg, rects = []) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...bg, 255], i * 4);
  for (const { x0, y0, x1, y1, rgb } of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...rgb, 255], (y * w + x) * 4);
  }
  return { data, width: w, height: h };
}
const count = (m) => m.reduce((a, v) => a + (v ? 1 : 0), 0);

test('Lab: known colours', () => {
  const near = (p, q) => p.every((v, i) => Math.abs(v - q[i]) < 0.5);
  assert.ok(near(rgbToLab(255, 255, 255), [100, 0, 0]), 'white');
  assert.ok(near(rgbToLab(0, 0, 0), [0, 0, 0]), 'black');
  assert.ok(near(rgbToLab(255, 0, 0), [53.24, 80.09, 67.2]), 'red');
  assert.ok(deltaE(rgbToLab(200, 50, 50), rgbToLab(202, 52, 49)) < 2, 'barely different');
  assert.ok(deltaE(rgbToLab(200, 50, 50), rgbToLab(50, 50, 200)) > 50, 'red vs blue');
});

test('sampling averages a small square, clipped at the edges', () => {
  const img = image(10, 10, [0, 0, 0], [{ x0: 0, y0: 0, x1: 5, y1: 10, rgb: [200, 100, 50] }]);
  assert.deepEqual(sampleColor(img, 1, 5), [200, 100, 50]);
  assert.deepEqual(sampleColor(img, 0, 0), [200, 100, 50], 'corner');
  const mixed = sampleColor(img, 4.6, 5); // straddles the edge: 3 of 5 columns coloured
  assert.ok(mixed[0] > 60 && mixed[0] < 200);
  assert.equal(toHex([255, 16, 0]), '#ff1000');
});

test('mask selects the picked colour and nothing else', () => {
  // Wood-brown background, a pale teal cutter ring and a similar-but-darker stripe.
  const teal = [80, 180, 170], darker = [60, 150, 140], wood = [120, 80, 50];
  const img = image(60, 40, wood, [
    { x0: 10, y0: 10, x1: 30, y1: 30, rgb: teal },
    { x0: 40, y0: 10, x1: 50, y1: 30, rgb: darker },
  ]);
  const tight = colorMask(img, teal, 8);
  const inner = (x0, y0, x1, y1, m) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += m[y * 60 + x] ? 1 : 0; return n; };
  assert.equal(inner(11, 11, 29, 29, tight), 18 * 18, 'all of the teal (inside the blur margin)');
  assert.equal(inner(41, 11, 49, 29, tight), 0, 'not the darker teal at a tight tolerance');
  assert.equal(inner(0, 0, 8, 40, tight), 0, 'no wood');
  const loose = colorMask(img, teal, 25);
  assert.ok(inner(41, 11, 49, 29, loose) > 0, 'a looser tolerance takes in the darker teal too');
  assert.ok(count(loose) > count(tight));
  assert.equal(inner(0, 0, 8, 40, loose), 0, 'still no wood');
});

test('grain-like single-pixel noise does not speckle the mask', () => {
  const img = image(40, 40, [240, 240, 240]);
  // Isolated dark pixels (noise) on white paper: picking the dark ink colour shouldn't grab them.
  for (let i = 0; i < 40; i += 7) img.data.set([20, 20, 20, 255], (i * 40 + i) * 4);
  assert.equal(count(colorMask(img, [20, 20, 20], 15)), 0);
});
