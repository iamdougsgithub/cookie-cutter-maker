// Line drawing for a cookie projector: cookie outline + stamp/detail lines as SVG, at true
// size (mm). Pure: works on mm polylines (y-up, as seen on the cookie's top).

const num = (v) => Number(v.toFixed(3)).toString();

function pathData(pts, closed) {
  // SVG is y-down: flip y.
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${num(x)} ${num(-y)}`).join('');
  return closed ? d + 'Z' : d;
}

/**
 * opts: { outline: [[x,y]] mm, lines: [{ pts, closed }] mm, strokeMM, invert,
 *         showOutline, showLines, marginMM }
 * Returns { svg, widthMM, heightMM, lineCount }.
 */
export function projectorSVG({
  outline, lines = [], strokeMM = 0.8, invert = false, showOutline = true, showLines = true, marginMM = 3,
}) {
  const all = [...(showOutline ? outline : []), ...(showLines ? lines.flatMap((l) => l.pts) : [])];
  const src = all.length ? all : outline;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of src) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, -y); maxY = Math.max(maxY, -y); }
  const pad = marginMM + strokeMM / 2;
  const vx = minX - pad, vy = minY - pad, vw = maxX - minX + 2 * pad, vh = maxY - minY + 2 * pad;
  const ink = invert ? '#ffffff' : '#000000', paper = invert ? '#000000' : '#ffffff';
  const paths = [];
  if (showOutline) paths.push(`<path d="${pathData(outline, true)}"/>`);
  if (showLines) for (const l of lines) paths.push(`<path d="${pathData(l.pts, l.closed)}"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(vw)}mm" height="${num(vh)}mm" viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}">`
    + `<rect x="${num(vx)}" y="${num(vy)}" width="${num(vw)}" height="${num(vh)}" fill="${paper}"/>`
    + `<g fill="none" stroke="${ink}" stroke-width="${num(strokeMM)}" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g></svg>`;
  return { svg, widthMM: vw, heightMM: vh, lineCount: showLines ? lines.length : 0 };
}
