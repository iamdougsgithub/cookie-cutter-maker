// Minifigure-style outline (800 x 1100 px) used as a test drawing: C-shaped hands,
// ~3.5 mm gaps between hands and hips, a neck notch and a notch between the legs.
// Returns a closed polyline; the right half is built and mirrored.

function quad(out, [x0, y0], [cx, cy], [x1, y1], n = 16) {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
  }
}
function arc(out, [cx, cy], r, a0, a1, n = 40) {
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
}

export function figurePoints() {
  const R = [[400, 82], [455, 82]];
  const last = () => R[R.length - 1];
  const Q = (c, p) => quad(R, last(), c, p);
  const L = (p) => R.push(p);
  Q([470, 82], [470, 97]); L([470, 125]); Q([472, 140], [492, 143]);       // stud
  Q([545, 152], [545, 230]); L([545, 318]); Q([545, 342], [528, 350]);     // head
  L([530, 358]);                                                           // neck notch
  Q([605, 380], [635, 455]); L([688, 625]); Q([694, 642], [708, 655]);     // shoulder, arm
  Q([730, 680], [712, 708]);                                               // end of arm
  // C-shaped hand, mouth facing the body: outer edge down and round to the lower lip,
  // into the hook and round its inside, out past the upper lip, then up to the wrist.
  const hc = [670, 748];
  arc(R, hc, 48, -0.75, Math.PI - 0.45);
  arc(R, hc, 22, Math.PI - 0.45, -Math.PI + 0.45, 60);
  arc(R, hc, 48, Math.PI + 0.45, Math.PI + 1.05, 8);
  Q([622, 712], [604, 740]); L([586, 752]);                               // wrist into hip
  L([586, 1018]); Q([586, 1040], [564, 1040]); L([420, 1040]); Q([406, 1040], [400, 1026]); // leg + notch
  const left = R.slice(1, -1).reverse().map(([x, y]) => [800 - x, y]);
  return [...R, ...left];
}
