/**
 * A tiny anti-aliased rasteriser for the shapes the icon is made of.
 *
 * Coverage is computed by supersampling: each pixel is sampled on an N×N grid
 * and the fraction of samples inside the shape becomes its alpha. That is
 * slower than analytic coverage and entirely fast enough for a 128px icon, and
 * it keeps every shape a single "is this point inside?" predicate — which is
 * what makes the whole file reviewable in one sitting.
 *
 * Output is straight (non-premultiplied) 8-bit RGBA, which is what
 * `encodePng` expects.
 */

/** Samples per axis. 4 gives 16 levels of edge alpha; visually clean at 16px. */
const SAMPLES = 4;

export function createCanvas(size) {
  return { size, rgba: new Uint8ClampedArray(size * size * 4) };
}

/** `#rrggbb` or `#rrggbbaa` to `[r, g, b, a]` with a 0..1 alpha. */
export function parseColor(hex) {
  const value = hex.replace('#', '');
  const read = (index) => parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return [read(0), read(1), read(2), value.length >= 8 ? read(3) / 255 : 1];
}

/**
 * Composites `color` over the canvas wherever `inside(x, y)` is true.
 *
 * `inside` takes coordinates in the shape's own 128-unit design space, so a
 * shape is written once and drawn at any output size.
 */
export function paint(canvas, scale, color, inside) {
  const [r, g, b, a] = color;
  const { size, rgba } = canvas;
  const step = 1 / SAMPLES;
  const offset = step / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + offset + sx * step) / scale;
          const y = (py + offset + sy * step) / scale;
          if (inside(x, y)) hits += 1;
        }
      }
      if (hits === 0) continue;

      const alpha = (hits / (SAMPLES * SAMPLES)) * a;
      const index = (py * size + px) * 4;
      const dstA = rgba[index + 3] / 255;
      const outA = alpha + dstA * (1 - alpha);
      if (outA === 0) continue;

      // Standard source-over on straight alpha.
      rgba[index] = (r * alpha + rgba[index] * dstA * (1 - alpha)) / outA;
      rgba[index + 1] = (g * alpha + rgba[index + 1] * dstA * (1 - alpha)) / outA;
      rgba[index + 2] = (b * alpha + rgba[index + 2] * dstA * (1 - alpha)) / outA;
      rgba[index + 3] = outA * 255;
    }
  }
}

/**
 * Euclidean distance, via `sqrt` rather than `Math.hypot`.
 *
 * `Math.hypot` is not required by the spec to be correctly rounded, so its last
 * bits may differ between engines. `sqrt` is exactly specified by IEEE 754.
 * Everything here is `+ - * /` and `sqrt`, which makes the rasteriser
 * bit-identical on every platform — and that is what lets CI compare the
 * committed PNGs against a fresh render without flaking.
 */
function distance(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

// --- Shape predicates, all in the 128-unit design space ----------------------

export function roundedRect(x, y, w, h, radius) {
  return (px, py) => {
    if (px < x || py < y || px > x + w || py > y + h) return false;
    const cx = Math.min(Math.max(px, x + radius), x + w - radius);
    const cy = Math.min(Math.max(py, y + radius), y + h - radius);
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
  };
}

export function disc(cx, cy, radius) {
  return (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

/** An annulus: the stroked outline of a circle. */
export function ring(cx, cy, radius, width) {
  const half = width / 2;
  return (px, py) => {
    const d = distance(px - cx, py - cy);
    return d >= radius - half && d <= radius + half;
  };
}

/** A thick line segment with round caps. */
export function capsule(x1, y1, x2, y2, width) {
  const half = width / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  return (px, py) => {
    const t =
      lengthSquared === 0
        ? 0
        : Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
    return distance(px - (x1 + t * dx), py - (y1 + t * dy)) <= half;
  };
}

/** Everything in `shape` except what `hole` covers. */
export function subtract(shape, hole) {
  return (px, py) => shape(px, py) && !hole(px, py);
}
