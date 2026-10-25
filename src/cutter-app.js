// Cookie cutter page.
import { MM_PER_IN } from './geometry.js';
import { makeCutter, CUTTER_DEFAULTS } from './cutter.js';
import { startApp } from './app-core.js';

const fmt = (v, d) => Number(v.toFixed(d)).toString();

startApp({
  id: 'cutter',
  noun: 'cutter',
  defaults: {
    heightMM: CUTTER_DEFAULTS.heightMM, tipMM: CUTTER_DEFAULTS.tipMM, bevelMM: CUTTER_DEFAULTS.bevelMM,
    baseMM: CUTTER_DEFAULTS.baseMM, rimWidthMM: CUTTER_DEFAULTS.rimWidthMM,
  },
  build: (pts, s) => makeCutter(pts, {
    sizeMM: s.sizeMM, smoothness: s.smoothness, notchWidthMM: s.notchWidthMM,
    mirror: s.mirror, rotationDeg: s.rotationDeg,
    heightMM: s.heightMM, tipMM: s.tipMM, bevelMM: s.bevelMM, baseMM: Math.max(s.baseMM, s.tipMM), rimWidthMM: s.rimWidthMM,
  }),
  render: (s) => drawBladeProfile(s),
  fileName: (s, name) => `cookie_cutter_${name}_${fmt(s.sizeMM / MM_PER_IN, 3)}in.stl`,
  okNote: (r) => {
    const [w, h] = r.cuttingSize;
    return `Cuts a ${fmt(w / MM_PER_IN, 2)} × ${fmt(h / MM_PER_IN, 2)} in cookie (${fmt(w, 1)} × ${fmt(h, 1)} mm), the same as the practice blank.`;
  },
});

/** Cross-section of the blade and rim, as printed (rim down), widths exaggerated ×2.5. */
function drawBladeProfile(s) {
  const svg = document.getElementById('bladeProfile');
  if (!svg) return;
  const H = s.heightMM, T = CUTTER_DEFAULTS.rimThicknessMM;
  const tip = s.tipMM, base = Math.max(s.baseMM, s.tipMM);
  const bevel = Math.max(0, Math.min(s.bevelMM, H - T - 1));
  const shoulder = base;
  const ys = 108 / H, xs = ys * 2.5, x0 = 40, y0 = 120;
  const X = (mm) => x0 + mm * xs, Y = (mm) => y0 - mm * ys;
  const pts = [[0, 0], [base + s.rimWidthMM, 0], [base + s.rimWidthMM, T], [base, T],
    ...(bevel > 0 ? [[shoulder, H - bevel]] : []), [tip, H], [0, H]];
  const poly = pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
  const r1 = (v) => Number(v.toFixed(1));
  svg.innerHTML = `
    <text x="4" y="${Y(H / 2)}" >cookie</text><text x="4" y="${Y(H / 2) + 10}">side</text>
    <polygon class="steel" points="${poly}"/>
    <path class="dim" d="M${X(tip) + 6} ${Y(H)}h22"/><text x="${X(tip) + 30}" y="${Y(H) + 3}">edge ${r1(tip)} mm</text>
    ${bevel > 0 ? `<path class="dim" d="M${X(shoulder) + 6} ${Y(H - bevel)}h18"/><text x="${X(shoulder) + 26}" y="${Y(H - bevel) + 3}">bevel ${r1(bevel)} mm</text>` : ''}
    <text x="${X(base) + 6}" y="${Y(T) - 6}">${r1(base)} mm</text>
    <text x="${X(0)}" y="130">widths ×2.5</text>`;
}
