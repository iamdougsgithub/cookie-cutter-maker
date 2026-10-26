// Lettering cookies: hand-drawn words -> a "bubble" cookie outline round them, like
// cookies cut to follow a piped "Happy Birthday". Pure (Clipper only), so it can be tested.
//
//   1. Every ink blob (letters, dots, flourishes) grows outward by the border.
//   2. The grown blobs are merged; holes (inside an "o", between loops) are filled.
//   3. Parts that still don't touch (a far-off dot, a second word) are bridged by closing
//      (grow then shrink) with increasing reach, until it's one piece.
//   4. A final closing rounds off narrow dips between letters, for a soft, cuttable edge.

import ClipperLib from 'clipper-lib';
import { signedArea, simplifyClosed, bbox } from './geometry.js';

const SCALE = 100; // Clipper works in integers: 0.01 px

const toClip = (pts) => pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromClip = (path) => path.map((q) => [q.X / SCALE, q.Y / SCALE]);

/** Offset several y-up CCW polygons together (round joins); returns merged outers, largest first. */
function offsetAll(polys, delta) {
  const co = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
  for (const p of polys) co.AddPath(toClip(p), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, delta * SCALE);
  return sol.map(fromClip)
    .filter((p) => p.length >= 3 && signedArea(p) > 0) // outers only: holes get filled
    .sort((a, b) => signedArea(b) - signedArea(a));
}

const close = (polys, r) => offsetAll(offsetAll(polys, r), -r);

/**
 * Cookie outline round lettering.
 *   ink:        outlines of the ink blobs, in photo pixels (y down), any orientation
 *   borderPct:  how far the cookie reaches beyond the ink, as % of the lettering's
 *               longest side
 *   smoothPct:  how much the dips between letters are rounded off, same units
 * Returns { outline (photo pixels, y down), parts (pieces before bridging), joined,
 *           borderPx } or null if there's no ink.
 */
export function letteringOutline(ink, { borderPct = 6, smoothPct = 5 } = {}) {
  const blobs = ink.filter((c) => c.length >= 3);
  if (!blobs.length) return null;
  const b = bbox(blobs.flat());
  const span = Math.max(b.width, b.height);
  const border = (span * borderPct) / 100, smooth = (span * smoothPct) / 100;

  // y-up, counter-clockwise, lightly simplified (hand-drawn outlines are very dense).
  const polys = blobs.map((c) => {
    const up = simplifyClosed(c, 0.5).map(([x, y]) => [x, -y]);
    return signedArea(up) < 0 ? up.reverse() : up;
  });

  let parts = offsetAll(polys, border);
  const pieces = parts.length;
  for (let k = 1; parts.length > 1 && k <= 6; k++) parts = close(parts, border * k);
  const joined = parts.length === 1;
  let shape = parts.slice(0, 1);
  if (smooth > 0) shape = close(shape, smooth).slice(0, 1);
  if (!shape.length) return null;

  return { outline: shape[0].map(([x, y]) => [x, -y]), parts: pieces, joined, borderPx: border };
}
