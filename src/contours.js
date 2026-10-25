// Picks the cookie edge out of a contour tree. Pure (no OpenCV), so it can be unit tested.
//
// Input mirrors OpenCV's findContours(RETR_TREE) output:
//   contours:  array of point lists [[x, y], ...] in pixel space
//   hierarchy: array of [next, prev, firstChild, parent] per contour
//
// Foreground (the cutter wall or pen line) is white in the binary image, so:
//   even depth = outer boundary of a foreground blob
//   odd depth  = hole inside a blob — for a ring, that's the cookie edge.

import { signedArea, perimeter, bbox, offsetPolygon } from './geometry.js';

function depthOf(i, hierarchy) {
  let d = 0;
  for (let p = hierarchy[i][3]; p >= 0; p = hierarchy[p][3]) d++;
  return d;
}

function touchesBorder(pts, w, h, margin = 2) {
  const b = bbox(pts);
  return b.minX <= margin || b.minY <= margin || b.maxX >= w - 1 - margin || b.maxY >= h - 1 - margin;
}

/**
 * Returns plausible cookie outlines, largest first:
 *   { points, area, kind: 'inner' | 'outer', lineThickness, outerPoints }
 * 'inner' = hole of a ring (cutter wall / pen line). 'outer' = a solid blob, used only
 * when there are no rings (e.g. a cutter photographed as a filled silhouette).
 */
export function findCookieCandidates(contours, hierarchy, { width, height, minAreaFrac = 0.01 } = {}) {
  const imgArea = width * height;
  const minArea = imgArea * minAreaFrac;
  const inner = [], outer = [];
  for (let i = 0; i < contours.length; i++) {
    const pts = contours[i];
    if (pts.length < 8) continue;
    const area = Math.abs(signedArea(pts));
    if (area < minArea) continue;
    const depth = depthOf(i, hierarchy);
    if (depth % 2 === 1) {
      const parent = hierarchy[i][3];
      const outerPts = contours[parent];
      // The blob around the hole touching the frame edge is usually the table around the
      // paper, or a shadow running off-frame — its hole is the paper, not a cookie.
      if (touchesBorder(outerPts, width, height)) continue;
      const outerArea = Math.abs(signedArea(outerPts));
      const ringArea = outerArea - area;
      const avgPerim = (perimeter(outerPts) + perimeter(pts)) / 2;
      inner.push({
        index: i, points: pts, area, kind: 'inner', outerPoints: outerPts,
        lineThickness: Math.max(0, ringArea / avgPerim),
        thicknessVariation: thicknessVariation(pts, outerPts),
      });
    } else if (!touchesBorder(pts, width, height)) {
      outer.push({ index: i, points: pts, area, kind: 'outer', lineThickness: 0, outerPoints: pts });
    }
  }
  // A small ring's hole can sit inside a bigger cookie (stamp details, a drawn eye):
  // drop holes that lie inside another, larger candidate hole.
  inner.sort((a, b) => b.area - a.area);
  const keptInner = inner.filter((c, k) => !inner.slice(0, k).some((big) => isInside(c.points, big.points)));
  if (keptInner.length) return keptInner;
  outer.sort((a, b) => b.area - a.area);
  return outer.filter((c, k) => !outer.slice(0, k).some((big) => isInside(c.points, big.points)));
}

/**
 * Coefficient of variation of the line width (inner edge -> nearest outer-edge point).
 * Marker lines wobble in width; cutter walls are uniform.
 */
export function thicknessVariation(innerPts, outerPts, samples = 160) {
  const step = Math.max(1, Math.floor(innerPts.length / samples));
  const ostep = Math.max(1, Math.floor(outerPts.length / 1500));
  const d = [];
  for (let i = 0; i < innerPts.length; i += step) {
    const [x, y] = innerPts[i];
    let best = Infinity;
    for (let j = 0; j < outerPts.length; j += ostep) {
      const dx = outerPts[j][0] - x, dy = outerPts[j][1] - y, q = dx * dx + dy * dy;
      if (q < best) best = q;
    }
    d.push(Math.sqrt(best));
  }
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  if (!(mean > 0)) return 0;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
  return sd / mean;
}

export function pointInPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isInside(small, big) {
  // Sample a few points; contours from one tree never cross, so any sample decides.
  const step = Math.max(1, Math.floor(small.length / 5));
  let votes = 0, total = 0;
  for (let i = 0; i < small.length; i += step) { total++; if (pointInPolygon(small[i], big)) votes++; }
  return votes > total / 2;
}

/** Candidate under a click: the smallest one containing the point. */
export function candidateAt(candidates, pt) {
  let best = -1, bestArea = Infinity;
  candidates.forEach((c, i) => {
    if (c.area < bestArea && pointInPolygon(pt, c.outerPoints || c.points)) { best = i; bestArea = c.area; }
  });
  return best;
}

/** Centerline of a drawn line: the inner edge pushed outward by half the line width. */
export function centerlineOf(candidate) {
  if (candidate.kind !== 'inner' || !(candidate.lineThickness > 0)) return candidate.points;
  // offsetPolygon expects CCW in a y-up frame; flip y, offset, flip back.
  const up = candidate.points.map(([x, y]) => [x, -y]);
  const ccw = signedArea(up) < 0 ? up.reverse() : up;
  const res = offsetPolygon(ccw, candidate.lineThickness / 2, { scale: 100, arcTolerance: 0.25 });
  return res.length ? res[0].map(([x, y]) => [x, -y]) : candidate.points;
}

/**
 * Guess cutter vs drawing. Cutters: a light cutter on a dark ground, coloured plastic,
 * thick walls/flanges, or a solid silhouette. Otherwise a dark line on paper is a drawing
 * if its width wobbles the way a marker's does, and a cutter if it's machine-uniform.
 */
export function guessMode({ candidate, foregroundIsDark, colored = false }) {
  if (!candidate || !foregroundIsDark || candidate.kind === 'outer') return 'cutter';
  if (colored) return 'cutter';
  if (candidate.lineThickness / Math.sqrt(candidate.area) >= 0.06) return 'cutter';
  return (candidate.thicknessVariation ?? 0) > 0.12 ? 'drawing' : 'cutter';
}
