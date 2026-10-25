// Photo -> contour candidates, with OpenCV.js. Everything stays in the browser.

import { findCookieCandidates, guessMode } from './contours.js';

const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const MAX_DIM = 1100; // working resolution

let cvPromise = null;

/** Load OpenCV.js once. Resolves with the ready `cv` module. */
export function loadOpenCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    // The Emscripten module has a then() that resolves to the module itself, so awaiting or
    // resolving with it spins forever. Strip it once the runtime is up.
    const done = (cv) => { try { delete cv.then; } catch {} if (typeof cv.then === 'function') cv.then = undefined; resolve(cv); };
    const ready = async () => {
      let cv = window.cv;
      if (cv instanceof Promise) cv = await cv; // some builds expose a real promise of the module
      if (cv && cv.Mat) { window.cv = cv; done(cv); return; }
      cv.onRuntimeInitialized = () => done(cv);
    };
    const s = document.createElement('script');
    s.src = OPENCV_URL;
    s.async = true;
    s.onload = () => ready().catch(reject);
    s.onerror = () => reject(new Error('Could not load OpenCV.js — check your connection.'));
    document.head.appendChild(s);
  });
  return cvPromise;
}

/** Draw an image into a working canvas no bigger than MAX_DIM. */
export function toWorkingCanvas(img) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const k = Math.min(1, MAX_DIM / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k);
  c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/**
 * Find cookie-edge candidates in a working canvas.
 * opts: { mode: 'auto'|'cutter'|'drawing', threshold: null (Otsu) | 0..255 }
 * Returns { candidates, binary (w*h mask, foreground 255), thresholdUsed, channel, foregroundIsDark, detectedMode, width, height }.
 */
export function detect(cv, canvas, { mode = 'auto', threshold = null } = {}) {
  const width = canvas.width, height = canvas.height;
  const mats = [];
  const M = (m) => (mats.push(m), m);
  try {
    const src = M(cv.imread(canvas));
    const gray = M(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const grayBlur = M(new cv.Mat());
    cv.GaussianBlur(gray, grayBlur, new cv.Size(5, 5), 0);

    // Chroma (max - min of RGB). Shadows darken things but add almost no colour, so for a
    // coloured cutter on neutral paper, thresholding chroma ignores the shadow entirely.
    const ch = M(new cv.MatVector());
    cv.split(src, ch);
    const r = ch.get(0), g = ch.get(1), b = ch.get(2), a = ch.get(3);
    const mx = M(new cv.Mat()), mn = M(new cv.Mat()), chroma = M(new cv.Mat());
    cv.max(r, g, mx); cv.max(mx, b, mx);
    cv.min(r, g, mn); cv.min(mn, b, mn);
    cv.subtract(mx, mn, chroma);
    [r, g, b, a].forEach((m) => m.delete());
    const chromaBlur = M(new cv.Mat());
    cv.GaussianBlur(chroma, chromaBlur, new cv.Size(5, 5), 0);
    const useColor = colorSeparates(cv, chromaBlur, width, height, M);

    // Background = what's around the edge of the frame. Foreground is the other side
    // of the threshold, made white in the binary image.
    const blur = useColor ? chromaBlur : grayBlur;
    const otsuProbe = M(new cv.Mat());
    const otsu = cv.threshold(blur, otsuProbe, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    const foregroundIsDark = !useColor && meanBorder(blur, width, height) > otsu;
    const t = threshold == null ? otsu : threshold;
    const raw = M(new cv.Mat());
    cv.threshold(blur, raw, t, 255, foregroundIsDark ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY);

    // Seal small gaps in drawn lines, then knock out specks. If no closed ring turns up,
    // retry with stronger closing (a drawing with a gap in its line).
    const dim = Math.max(width, height);
    // Start gentle so thin channels (the inside of a drawn C-shaped hand) stay open.
    const closeFracs = [0.004, 0.008, 0.014, 0.022, 0.03];
    const kOpen = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
    const bin = M(new cv.Mat());
    let candidates = null;
    let binary = null; // gentlest cleaned mask: stamp details are read from this
    for (const frac of closeFracs) {
      raw.copyTo(bin);
      const closeK = oddAtLeast3(Math.round(dim * frac));
      const kClose = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeK, closeK)));
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
      if (!binary) binary = Uint8Array.from(bin.data);
      const found = findContoursIn(cv, bin, width, height);
      if (!candidates) candidates = found; // no ring anywhere -> keep the gentlest result
      if (found.some((c) => c.kind === 'inner')) { candidates = found; break; }
    }

    const detectedMode = guessMode({ candidate: candidates[0], foregroundIsDark, colored: useColor });

    return { candidates, binary, thresholdUsed: Math.round(t), otsu: Math.round(otsu), channel: useColor ? 'color' : 'brightness', foregroundIsDark, detectedMode, width, height };
  } finally {
    for (const m of mats) m.delete();
  }
}

function findContoursIn(cv, bin, width, height) {
  const contoursV = new cv.MatVector();
  const hier = new cv.Mat();
  const work = bin.clone(); // findContours may modify its input in older builds
  try {
    cv.findContours(work, contoursV, hier, cv.RETR_TREE, cv.CHAIN_APPROX_NONE);
    const contours = [];
    for (let i = 0; i < contoursV.size(); i++) {
      const c = contoursV.get(i);
      const d = c.data32S, pts = new Array(d.length / 2);
      for (let k = 0; k < pts.length; k++) pts[k] = [d[2 * k], d[2 * k + 1]];
      contours.push(pts);
      c.delete();
    }
    const h = hier.data32S, hierarchy = [];
    for (let i = 0; i < contours.length; i++) hierarchy.push([h[4 * i], h[4 * i + 1], h[4 * i + 2], h[4 * i + 3]]);
    return findCookieCandidates(contours, hierarchy, { width, height });
  } finally {
    contoursV.delete(); hier.delete(); work.delete();
  }
}

/** True when a strongly coloured object sits on a fairly neutral background. */
function colorSeparates(cv, chroma, width, height, M) {
  const mask = M(new cv.Mat());
  const tc = cv.threshold(chroma, mask, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const frac = cv.countNonZero(mask) / (width * height);
  if (frac < 0.003 || frac > 0.6) return false;
  const inv = M(new cv.Mat());
  cv.bitwise_not(mask, inv);
  const hi = cv.mean(chroma, mask)[0], lo = cv.mean(chroma, inv)[0];
  return hi - lo > 45 && meanBorder(chroma, width, height) < tc;
}

function oddAtLeast3(k) { k = Math.max(3, k); return k % 2 ? k : k + 1; }

function meanBorder(mat, w, h) {
  const d = mat.data, band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  let sum = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (y >= band && y < h - band && x >= band && x < w - band) continue;
      sum += d[y * w + x]; n++;
    }
  }
  return sum / n;
}
