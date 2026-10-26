// Photo -> contour candidates, with OpenCV.js. Everything stays in the browser.

import { findCookieCandidates, guessMode } from './contours.js';

// Same build from two CDNs: if one is blocked or down, try the other.
const OPENCV_URLS = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
];
const LOAD_TIMEOUT_MS = 60000;
const MAX_DIM = 1100; // working resolution

let cvPromise = null;

/** A loading failure with a plain-language reason. kind: 'wasm' | 'download' | 'timeout'. */
function loadError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

/** Can this browser actually run WebAssembly? (Edge's enhanced security mode turns it off.) */
async function webAssemblyWorks() {
  try {
    if (typeof WebAssembly !== 'object') return false;
    // The smallest valid module: just the header.
    await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  } catch {
    return false;
  }
}

function addScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`failed to download ${url}`)); };
    document.head.appendChild(s);
  });
}

/**
 * Load OpenCV.js once. Resolves with the ready `cv` module; rejects with a loadError if
 * WebAssembly is unavailable, the download is blocked, or it takes too long.
 */
export function loadOpenCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    // The Emscripten module has a then() that resolves to the module itself, so awaiting or
    // resolving with it spins forever. Strip it once the runtime is up.
    let settled = false;
    const done = (cv) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { delete cv.then; } catch {} if (typeof cv.then === 'function') cv.then = undefined;
      resolve(cv);
    };
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } };
    const timer = setTimeout(() => fail(loadError('timeout',
      'The shape finder is taking too long to load (it’s a 10 MB download). Check your connection, then reload the page.')), LOAD_TIMEOUT_MS);

    (async () => {
      if (!(await webAssemblyWorks())) {
        throw loadError('wasm', 'This browser has WebAssembly switched off, so the automatic shape finder can’t run. ' +
          'In Microsoft Edge this is “Enhance your security on the web” (edge://settings/privacy): add this site as an exception, or turn it off.');
      }
      let lastErr = null;
      for (const url of OPENCV_URLS) {
        try { await addScript(url); lastErr = null; break; } catch (e) { lastErr = e; }
      }
      if (lastErr) {
        throw loadError('download', 'Couldn’t download the shape finder from cdn.jsdelivr.net or unpkg.com. ' +
          'A network filter, firewall or content blocker may be blocking it.');
      }
      let cv = window.cv;
      if (cv instanceof Promise) cv = await cv; // some builds expose a real promise of the module
      if (cv && cv.Mat) { window.cv = cv; done(cv); return; }
      cv.onRuntimeInitialized = () => done(cv);
    })().catch(fail);
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
 * Returns { candidates, thresholdUsed, channel, foregroundIsDark, detectedMode, width, height }.
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
    for (const frac of closeFracs) {
      raw.copyTo(bin);
      const closeK = oddAtLeast3(Math.round(dim * frac));
      const kClose = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeK, closeK)));
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
      const found = findContoursIn(cv, bin, width, height);
      if (!candidates) candidates = found; // no ring anywhere -> keep the gentlest result
      if (found.some((c) => c.kind === 'inner')) { candidates = found; break; }
    }

    const detectedMode = guessMode({ candidate: candidates[0], foregroundIsDark, colored: useColor });

    return { candidates, thresholdUsed: Math.round(t), otsu: Math.round(otsu), channel: useColor ? 'color' : 'brightness', foregroundIsDark, detectedMode, width, height };
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
