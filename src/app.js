// Practice blank page.
import { DEFAULTS, MM_PER_IN, makeBlank } from './geometry.js';
import { startApp } from './app-core.js';

const fmt = (v, d) => Number(v.toFixed(d)).toString();

startApp({
  id: 'blank',
  noun: 'blank',
  defaults: { thicknessMM: DEFAULTS.thicknessMM },
  build: (pts, s) => makeBlank(pts, {
    sizeMM: s.sizeMM, thicknessMM: s.thicknessMM, smoothness: s.smoothness,
    notchWidthMM: s.notchWidthMM, mirror: s.mirror, rotationDeg: s.rotationDeg,
  }),
  fileName: (s, name) => `practice_cookie_${name}_${fmt(s.sizeMM / MM_PER_IN, 3)}x${fmt(s.thicknessMM / MM_PER_IN, 3)}in.stl`,
  okNote: (b) => (b.mesh.reducedFraction > 0.002 ? 'The top round-over is narrower on thin or tight parts so they keep their shape.' : ''),
});
