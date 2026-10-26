// Select by colour: pick a colour in the photo, keep every pixel that looks like it.
// Pure (works on ImageData-shaped { data, width, height }), so it can be unit tested.
//
// "Looks like" is CIE Lab distance (ΔE 1976): roughly, 2 is just noticeable, 10 is clearly
// different, 50 is a different colour altogether.

/** sRGB 0..255 -> CIE Lab (D65). */
export function rgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const deltaE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** Average colour in a (2r+1)-pixel square round (x, y), as [r, g, b] 0..255. */
export function sampleColor(img, x, y, r = 2) {
  const { data, width, height } = img;
  let R = 0, G = 0, B = 0, n = 0;
  for (let j = Math.max(0, Math.round(y) - r); j <= Math.min(height - 1, Math.round(y) + r); j++) {
    for (let i = Math.max(0, Math.round(x) - r); i <= Math.min(width - 1, Math.round(x) + r); i++) {
      const k = (j * width + i) * 4;
      R += data[k]; G += data[k + 1]; B += data[k + 2]; n++;
    }
  }
  return n ? [R / n, G / n, B / n].map(Math.round) : [0, 0, 0];
}

/**
 * Mask of pixels within `tolerance` (ΔE) of `rgb`: 255 = selected, 0 = not.
 * The image is lightly blurred first (3x3) so grain and sensor noise don't speckle it.
 */
export function colorMask(img, rgb, tolerance) {
  const { data, width: w, height: h } = img;
  const target = rgbToLab(...rgb);
  const out = new Uint8Array(w * h);
  // Lab conversion is the slow part: cache it per (quantised) colour.
  const cache = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let R = 0, G = 0, B = 0, n = 0;
      for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) {
        for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) {
          const k = (j * w + i) * 4;
          R += data[k]; G += data[k + 1]; B += data[k + 2]; n++;
        }
      }
      R = Math.round(R / n) >> 2; G = Math.round(G / n) >> 2; B = Math.round(B / n) >> 2; // 64 levels each
      const key = (R << 12) | (G << 6) | B;
      let hit = cache.get(key);
      if (hit === undefined) { hit = deltaE(rgbToLab(R * 4 + 2, G * 4 + 2, B * 4 + 2), target) <= tolerance; cache.set(key, hit); }
      if (hit) out[y * w + x] = 255;
    }
  }
  return out;
}

export const toHex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
