// Generates the sample/test photos in samples/:
//   cutter-ring.png   black ring cutter on white, with a stamp detail inside
//   drawn-star.png    wobbly marker star on paper, with a small gap in the line
//   shadow-photo.png  red heart cutter on paper with a soft shadow, noise and vignette
//   drawn-figure.png  minifigure-style outline with C-shaped hands and narrow gaps
//   stamp-photo.png   teal heart cutter with a stamp (inner heart, curl, dots) and shadows
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { figurePoints } from './figure-path.js';

const W = 1200, H = 900;

function png(w, h, rgb) {
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(rgb[y * w * 3 + x])));
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Anti-aliased stroke coverage of a closed polyline; width may vary per point. */
function stroke(pts, width, { skip = () => false } = {}) {
  const m = new Float32Array(W * H);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (skip(i / n)) continue;
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
    const hw = (typeof width === 'function' ? width(i / n) : width) / 2;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - 2)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + hw + 2));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - hw - 2)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + hw + 2));
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      const c = Math.max(0, Math.min(1, hw - d + 0.5));
      const k = y * W + x;
      if (c > m[k]) m[k] = c;
    }
  }
  return m;
}

function boxBlur(m, r, passes = 3) {
  let a = m, b = new Float32Array(W * H);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x <= r; x++) s += a[y * W + Math.max(0, Math.min(W - 1, x))];
      for (let x = 0; x < W; x++) { b[y * W + x] = s / (2 * r + 1); s += a[y * W + Math.min(W - 1, x + r + 1)] - a[y * W + Math.max(0, x - r)]; } }
    [a, b] = [b, a];
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += a[Math.max(0, Math.min(H - 1, y)) * W + x];
      for (let y = 0; y < H; y++) { b[y * W + x] = s / (2 * r + 1); s += a[Math.min(H - 1, y + r + 1) * W + x] - a[Math.max(0, y - r) * W + x]; } }
    [a, b] = [b, a];
  }
  return a;
}

function canvas(fill) { const c = new Float32Array(W * H * 3); for (let i = 0; i < W * H; i++) c.set(fill(i % W, Math.floor(i / W)), i * 3); return c; }
function paint(img, mask, color, alpha = 1) {
  for (let i = 0; i < W * H; i++) { const a = mask[i] * alpha; if (a <= 0) continue; for (let k = 0; k < 3; k++) img[i * 3 + k] = img[i * 3 + k] * (1 - a) + color[k] * a; }
}
function rand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

const circle = (cx, cy, r, n = 1200) => Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; });

mkdirSync('samples', { recursive: true });

// 1. Cutter: a black ring on white, with a small stamp detail inside.
{
  const img = canvas(() => [250, 250, 248]);
  paint(img, stroke(circle(600, 450, 320), 22), [25, 25, 28]);
  const starPts = [];
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 40 : 95, t = -Math.PI / 2 + (Math.PI * i) / 5; starPts.push([600 + r * Math.cos(t), 450 + r * Math.sin(t)]); }
  paint(img, stroke(starPts, 10), [25, 25, 28]);
  writeFileSync('samples/cutter-ring.png', png(W, H, img));
}

// 2. Hand-drawn star: wobbly radius, varying line weight, a little gap.
{
  const rnd = rand(7);
  const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
  const img = canvas((x, y) => { const v = 246 - 4 * Math.hypot(x - W / 2, y - H / 2) / W; return [v, v - 1, v - 4]; });
  const n = 1500, pts = [];
  for (let i = 0; i < n; i++) {
    const u = i / n, t = -Math.PI / 2 + 2 * Math.PI * u;
    // Star with slightly rounded tips (a marker can't draw a perfect point).
    const k = (u * 10) % 1, tip = Math.floor(u * 10) % 2 === 0;
    const lerp = tip ? 1 - k : k;
    const r = 150 + 230 * Math.pow(1 - lerp, 1.0);
    const wob = 1 + 0.025 * Math.sin(3 * t + ph[0]) + 0.015 * Math.sin(7 * t + ph[1]) + 0.01 * Math.sin(13 * t + ph[2]);
    pts.push([600 + r * wob * Math.cos(t) + 8 * Math.sin(2 * t), 470 + r * wob * Math.sin(t)]);
  }
  const mask = stroke(pts, (u) => 9 + 3 * Math.sin(u * 17 + 1) + 2 * Math.sin(u * 5), { skip: (u) => u > 0.305 && u < 0.309 });
  paint(img, mask, [28, 30, 45]);
  writeFileSync('samples/drawn-star.png', png(W, H, img));
}

// 3. Photo-like: red heart cutter on paper, soft shadow to the lower right, noise, vignette.
{
  const rnd = rand(42);
  const heart = Array.from({ length: 1400 }, (_, i) => {
    const t = (2 * Math.PI * i) / 1400;
    const x = 16 * Math.sin(t) ** 3, y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return [590 + 19 * x, 430 - 19 * y];
  });
  const img = canvas((x, y) => {
    const v = 238 - 40 * (Math.hypot((x - W * 0.45) / W, (y - H * 0.4) / H) ** 2) * 2;
    return [v + 2, v, v - 6];
  });
  const shadowSrc = stroke(heart.map(([x, y]) => [x + 16, y + 20]), 34);
  const shadow = boxBlur(shadowSrc, 12);
  for (let i = 0; i < W * H; i++) { const s = 1 - 0.45 * shadow[i]; for (let k = 0; k < 3; k++) img[i * 3 + k] *= s; }
  paint(img, stroke(heart, 20), [190, 38, 52]);
  // Highlight on the rim for a bit of realism.
  paint(img, stroke(heart.map(([x, y]) => [x - 2, y - 3]), 5), [235, 120, 125], 0.6);
  for (let i = 0; i < img.length; i++) img[i] += (rnd() - 0.5) * 14;
  writeFileSync('samples/shadow-photo.png', png(W, H, img));
}
// 4. Minifigure-style marker drawing: C-shaped hands, narrow gaps, small notches.
{
  const img = canvas(() => [250, 250, 248]);
  const pts = figurePoints().map(([x, y]) => [600 + (x - 400) * 0.85, 60 + (y - 82) * 0.85]);
  paint(img, stroke(pts, 8), [20, 20, 22]);
  writeFileSync('samples/drawn-figure.png', png(W, H, img));
}
// 5. Stamp cutter photo: teal plastic heart cutter with a stamp (inner heart outline, a
//    curl and three solid dots), soft shadows, noise.
{
  const rnd = rand(9);
  const heartAt = (cx, cy, k, n = 1400) => Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return [cx + k * 16 * Math.sin(t) ** 3, cy - k * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))];
  });
  const img = canvas((x, y) => { const v = 240 - 30 * (Math.hypot((x - W / 2) / W, (y - H / 2) / H) ** 2) * 2; return [v, v - 1, v - 5]; });
  const wall = heartAt(600, 430, 19);
  const inner = heartAt(600, 440, 9, 900);
  const curl = Array.from({ length: 300 }, (_, i) => { const t = i / 299, a = 1.2 + t * 4.2, r = 18 + 60 * t; return [600 + r * Math.cos(a), 440 + r * Math.sin(a)]; });
  const dots = [[470, 330], [730, 330], [600, 640]];
  const shapes = [[wall, 20], [inner, 9], [curl, 9]];
  // Shadows first (offset, blurred), then the plastic.
  const sh = new Float32Array(W * H);
  for (const [pts, w] of shapes) { const m = stroke(pts.map(([x, y]) => [x + 10, y + 12]), w + 6, { skip: pts === curl ? () => false : undefined }); for (let i = 0; i < m.length; i++) sh[i] = Math.max(sh[i], m[i]); }
  for (const [cx, cy] of dots) for (let y = cy - 30; y < cy + 30; y++) for (let x = cx - 30; x < cx + 30; x++) if (Math.hypot(x - cx - 10, y - cy - 12) < 16) sh[y * W + x] = 1;
  const blurred = boxBlur(sh, 9);
  for (let i = 0; i < W * H; i++) { const k = 1 - 0.35 * blurred[i]; for (let c = 0; c < 3; c++) img[i * 3 + c] *= k; }
  const teal = [32, 150, 160];
  // The curl is open-ended: stroke it without closing back to its start.
  paint(img, stroke(wall, 20), teal);
  paint(img, stroke(inner, 9), teal);
  paint(img, stroke(curl, 9, { skip: (u) => u > 0.995 }), teal);
  const dm = new Float32Array(W * H);
  for (const [cx, cy] of dots) for (let y = cy - 20; y < cy + 20; y++) for (let x = cx - 20; x < cx + 20; x++) dm[y * W + x] = Math.max(dm[y * W + x], Math.max(0, Math.min(1, 14.5 - Math.hypot(x - cx, y - cy))));
  paint(img, dm, teal);
  for (let i = 0; i < img.length; i++) img[i] += (rnd() - 0.5) * 10;
  writeFileSync('samples/stamp-photo.png', png(W, H, img));
}
console.log('wrote samples/cutter-ring.png, drawn-star.png, shadow-photo.png, drawn-figure.png, stamp-photo.png');
