// Cookie cutter page.
import { MM_PER_IN } from './geometry.js';
import { makeCutter, CUTTER_DEFAULTS } from './cutter.js';
import { startApp } from './app-core.js';
import opentype from 'opentype.js';

const fmt = (v, d) => Number(v.toFixed(d)).toString();

// Font for the raised side text (Nunito ExtraBold, SIL Open Font License; see fonts/OFL.txt).
// The cutter builds without it until it arrives, then rebuilds.
let font = null;
let fontError = null;

const app = startApp({
  id: 'cutter',
  noun: 'cutter',
  defaults: {
    heightMM: CUTTER_DEFAULTS.heightMM, tipMM: CUTTER_DEFAULTS.tipMM, bevelMM: CUTTER_DEFAULTS.bevelMM,
    baseMM: CUTTER_DEFAULTS.baseMM, rimWidthMM: CUTTER_DEFAULTS.rimWidthMM, labelText: CUTTER_DEFAULTS.labelText,
  },
  build: (pts, s) => makeCutter(pts, {
    sizeMM: s.sizeMM, smoothness: s.smoothness, notchWidthMM: s.notchWidthMM,
    mirror: s.mirror, rotationDeg: s.rotationDeg,
    heightMM: s.heightMM, tipMM: s.tipMM, bevelMM: s.bevelMM, baseMM: Math.max(s.baseMM, s.tipMM), rimWidthMM: s.rimWidthMM,
    font, labelText: s.labelText,
  }),
  render: (s, r) => { drawBladeProfile(s); describeLabel(s, r); },
  fileName: (s, name) => `cookie_cutter_${name}_${fmt(s.sizeMM / MM_PER_IN, 3)}in.stl`,
  okNote: (r) => {
    const [w, h] = r.cuttingSize;
    return `Cuts a ${fmt(w / MM_PER_IN, 2)} × ${fmt(h / MM_PER_IN, 2)} in cookie (${fmt(w, 1)} × ${fmt(h, 1)} mm), the same as the practice blank.`;
  },
});

fetch('fonts/Nunito-ExtraBold.woff')
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
  .then((buf) => { font = opentype.parse(buf); app.rebuild(); })
  .catch((e) => { fontError = e; console.error('Side text font failed to load', e); app.rebuild(); });

/** Say whether the side text fitted, and how big. */
function describeLabel(s, r) {
  const note = document.getElementById('labelNote');
  if (!note) return;
  const want = (s.labelText || '').trim();
  note.classList.remove('warn-note');
  if (!want) note.textContent = 'No side text.';
  else if (fontError) { note.textContent = 'Couldn’t load the font for the side text, so it’s left off.'; note.classList.add('warn-note'); }
  else if (!font) note.textContent = 'Loading the font for the side text…';
  else if (!r) note.textContent = 'Raised letters on the outside of the blade, just above the lip.';
  else if (r.label?.placed) note.textContent = `Raised ${fmt(r.label.capHeightMM, 1)} mm letters on the smoothest stretch of the blade, just above the lip.`;
  else if (r.label) { note.textContent = `Left off: ${r.label.reason}`; note.classList.add('warn-note'); }
}

/** Cross-section of the blade and lip, as printed (lip down), widths exaggerated ×2.5. */
function drawBladeProfile(s) {
  const svg = document.getElementById('bladeProfile');
  if (!svg) return;
  const H = s.heightMM, T = CUTTER_DEFAULTS.rimThicknessMM;
  const tip = s.tipMM, base = Math.max(s.baseMM, s.tipMM);
  const bevel = Math.max(0, Math.min(s.bevelMM, H - T - 1));
  const W = base + s.rimWidthMM;
  const c = Math.min(CUTTER_DEFAULTS.lipChamferMM, T / 3, s.rimWidthMM / 3);
  const r = Math.max(0, Math.min(CUTTER_DEFAULTS.lipRadiusMM, T - c - 0.2, s.rimWidthMM - 1));
  const ys = 108 / H, xs = ys * 2.5, x0 = 40, y0 = 120;
  const X = (mm) => x0 + mm * xs, Y = (mm) => y0 - mm * ys;
  const arc = Array.from({ length: 9 }, (_, k) => { const th = (k / 8) * (Math.PI / 2); return [W - r * (1 - Math.cos(th)), T - r + r * Math.sin(th)]; });
  const pts = [[0, 0], [W - c, 0], [W, c], ...arc, [base, T],
    ...(bevel > 0 ? [[base, H - bevel]] : []), [tip, H], [0, H]];
  const poly = pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
  const r1 = (v) => Number(v.toFixed(1));
  const hasText = (s.labelText || '').trim();
  // Raised letters: a small bump on the outside face just above the lip.
  const text = hasText ? `<rect class="steel" x="${X(base).toFixed(1)}" y="${Y(T + 0.8 + 4).toFixed(1)}" width="${(0.6 * xs).toFixed(1)}" height="${(4 * ys).toFixed(1)}"/>
    <text x="${X(base) + 0.6 * xs + 4}" y="${Y(T + 3)}">text</text>` : '';
  svg.innerHTML = `
    <text x="4" y="${Y(H / 2)}" >cookie</text><text x="4" y="${Y(H / 2) + 10}">side</text>
    <polygon class="steel" points="${poly}"/>
    ${text}
    <path class="dim" d="M${X(tip) + 6} ${Y(H)}h22"/><text x="${X(tip) + 30}" y="${Y(H) + 3}">edge ${r1(tip)} mm</text>
    ${bevel > 0 ? `<path class="dim" d="M${X(base) + 6} ${Y(H - bevel)}h18"/><text x="${X(base) + 26}" y="${Y(H - bevel) + 3}">bevel ${r1(bevel)} mm</text>` : ''}
    <text x="${X(W) - 16}" y="${Y(T) - 6}">lip</text>
    <text x="${X(0)}" y="130">widths ×2.5</text>`;
}
