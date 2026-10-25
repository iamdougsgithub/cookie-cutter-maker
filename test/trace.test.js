import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curvePoints, nodesFromContour, nodeAt, segmentAt } from '../src/trace.js';
import { makeBlank, bbox, isSimplePolygon } from '../src/geometry.js';

const node = (x, y, corner = false) => ({ x, y, corner });
const near = (p, q, tol = 1e-6) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
const distToSeg = ([x, y], [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};

test('the curve passes through every point, in order, and closes', () => {
  const nodes = [node(100, 100), node(300, 80), node(420, 260), node(200, 380), node(60, 250)];
  const { points, segStart } = curvePoints(nodes);
  assert.equal(segStart.length, nodes.length);
  nodes.forEach((n, i) => assert.ok(near(points[segStart[i]], [n.x, n.y]), `passes through node ${i}`));
  // Closed: the last sample leads back towards the first node.
  assert.ok(Math.hypot(points.at(-1)[0] - 100, points.at(-1)[1] - 100) < 5);
});

test('smooth points make a smooth, overshoot-free round shape', () => {
  // Eight points on a circle: the curve should stay close to the circle.
  const nodes = Array.from({ length: 8 }, (_, i) => node(500 + 200 * Math.cos((i * Math.PI) / 4), 500 + 200 * Math.sin((i * Math.PI) / 4)));
  const { points } = curvePoints(nodes);
  for (const [x, y] of points) {
    const r = Math.hypot(x - 500, y - 500);
    assert.ok(r > 190 && r < 206, `radius ${r.toFixed(1)}`);
  }
  assert.ok(isSimplePolygon(points));
});

test('two corners in a row give a straight edge; corners keep sharp angles', () => {
  const square = [node(100, 100, true), node(400, 100, true), node(400, 400, true), node(100, 400, true)];
  const { points } = curvePoints(square);
  const edges = [[[100, 100], [400, 100]], [[400, 100], [400, 400]], [[400, 400], [100, 400]], [[100, 400], [100, 100]]];
  for (const p of points) assert.ok(Math.min(...edges.map(([a, b]) => distToSeg(p, a, b))) < 1e-6, 'on the square');
  const b = bbox(points);
  assert.ok(near([b.minX, b.minY], [100, 100]) && near([b.maxX, b.maxY], [400, 400]));
});

test('open path (while still placing points) runs first to last without closing', () => {
  const nodes = [node(0, 0), node(100, 0), node(100, 100)];
  const { points } = curvePoints(nodes, { closed: false });
  assert.ok(near(points[0], [0, 0]) && near(points.at(-1), [100, 100]));
});

test('detected outlines become a sensible number of editable points', () => {
  const circle = Array.from({ length: 1000 }, (_, i) => [500 + 300 * Math.cos((2 * Math.PI * i) / 1000), 500 + 300 * Math.sin((2 * Math.PI * i) / 1000)]);
  const c = nodesFromContour(circle);
  assert.ok(c.length >= 12 && c.length <= 40, `${c.length} points`);
  assert.ok(c.every((n) => !n.corner), 'a circle has no corners');
  const { points } = curvePoints(c);
  for (const [x, y] of points) assert.ok(Math.abs(Math.hypot(x - 500, y - 500) - 300) < 6);

  const sq = [];
  for (let i = 0; i < 100; i++) sq.push([100 + 4 * i, 100]);
  for (let i = 0; i < 100; i++) sq.push([500, 100 + 4 * i]);
  for (let i = 0; i < 100; i++) sq.push([500 - 4 * i, 500]);
  for (let i = 0; i < 100; i++) sq.push([100, 500 - 4 * i]);
  const s = nodesFromContour(sq);
  assert.equal(s.filter((n) => n.corner).length, 4, 'a square has four corners');
});

test('hit testing: grab a point, or insert on the line between two', () => {
  const nodes = [node(100, 100, true), node(400, 100, true), node(400, 400, true), node(100, 400, true)];
  assert.equal(nodeAt(nodes, [404, 97], 10), 1);
  assert.equal(nodeAt(nodes, [250, 250], 10), -1);
  assert.deepEqual(segmentAt(nodes, [250, 103], 8), { index: 0 }, 'top edge: insert after node 0');
  assert.deepEqual(segmentAt(nodes, [104, 250], 8), { index: 3 }, 'left edge: closing segment');
  assert.equal(segmentAt(nodes, [250, 250], 8), null);
});

test('a traced outline builds a valid blank', () => {
  // A rough apple, traced with a handful of points (two corners at the stalk dip).
  const nodes = [node(500, 220, true), node(640, 160), node(800, 260), node(830, 480), node(720, 760),
    node(560, 820), node(500, 790, true), node(440, 820), node(280, 760), node(170, 480), node(200, 260), node(360, 160)];
  const { points } = curvePoints(nodes);
  const res = makeBlank(points, {});
  assert.ok(res.validation.ok, res.validation.errors.join('; '));
});
