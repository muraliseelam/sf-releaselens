/**
 * The sf-releaselens icon: a lens over a release pipeline.
 *
 * **This file is the source of truth.** `assets/icon.svg` and the four PNGs are
 * both generated from the shapes below, so they cannot drift apart — editing
 * the SVG by hand would be silently undone by the next `npm run icons`. Edit
 * here instead.
 *
 * Design notes, because a 16px icon is mostly constraint:
 *
 *  - Everything lives in a 128-unit square and is scaled down, so a stroke that
 *    reads at 128 also reads at 16.
 *  - Three bars, not five: at 16px each bar is ~1.5 device pixels, and more of
 *    them merge into a smear.
 *  - The lens ring is thick (7 units) and large. It is the only thing that
 *    survives legibly at 16px, so it has to carry the identity.
 *  - The plate is dark and opaque: Chrome toolbars are light *or* dark, and a
 *    transparent icon that works on one disappears on the other.
 */

import {
  capsule,
  disc,
  paint,
  parseColor,
  ring,
  roundedRect,
  subtract,
} from './lib/raster.mjs';

/** The design grid. Every coordinate below is in these units. */
export const DESIGN_SIZE = 128;

/** Sizes Chrome asks for. 128 is the store tile, 16 the favicon-scale one. */
export const ICON_SIZES = [16, 32, 48, 128];

const PALETTE = {
  plate: '#1b2430',
  pipelineDone: '#4c9aff',
  pipelineNext: '#4c9aff99',
  lens: '#e8eaf0',
  glass: '#4c9aff33',
};

/**
 * The icon, as an ordered list of `{ color, shape, svg }` layers.
 *
 * Each layer carries both its rasteriser predicate and its SVG equivalent, so
 * the two renderers stay in lockstep by construction rather than by discipline.
 */
export function layers() {
  // Composition: lens in the upper two thirds, pipeline along the bottom, and
  // the handle ending clear of both. An earlier version put the lens *over* the
  // bars, which looked fine at 128px and turned into an unreadable blob at 16 —
  // the two elements have to be vertically separated to survive the downscale.
  const barY = 102;
  const barHeight = 14;
  const barRadius = 7;
  const bars = [
    { x: 14, w: 32, color: PALETTE.pipelineDone },
    { x: 52, w: 30, color: PALETTE.pipelineDone },
    { x: 88, w: 26, color: PALETTE.pipelineNext },
  ];

  const lensCx = 56;
  const lensCy = 50;
  const lensR = 30;
  const lensWidth = 9;

  // Where the handle leaves the ring, at 45 degrees down-right.
  const handleFrom = { x: 77, y: 71 };
  const handleTo = { x: 98, y: 92 };
  const handleWidth = 12;

  return [
    {
      color: PALETTE.plate,
      shape: roundedRect(0, 0, DESIGN_SIZE, DESIGN_SIZE, 26),
      svg: `<rect x="0" y="0" width="128" height="128" rx="26" fill="${PALETTE.plate}"/>`,
    },

    ...bars.map((bar) => ({
      color: bar.color,
      shape: roundedRect(bar.x, barY, bar.w, barHeight, barRadius),
      svg: `<rect x="${bar.x}" y="${barY}" width="${bar.w}" height="${barHeight}" rx="${barRadius}" fill="${bar.color}"/>`,
    })),

    // The glass fill sits under the ring so the ring's inner edge stays crisp.
    {
      color: PALETTE.glass,
      shape: disc(lensCx, lensCy, lensR - lensWidth / 2),
      svg: `<circle cx="${lensCx}" cy="${lensCy}" r="${lensR - lensWidth / 2}" fill="${PALETTE.glass}"/>`,
    },

    // Handle first, then the ring paints over where they meet.
    {
      color: PALETTE.lens,
      shape: capsule(handleFrom.x, handleFrom.y, handleTo.x, handleTo.y, handleWidth),
      svg: `<line x1="${handleFrom.x}" y1="${handleFrom.y}" x2="${handleTo.x}" y2="${handleTo.y}" stroke="${PALETTE.lens}" stroke-width="${handleWidth}" stroke-linecap="round"/>`,
    },
    {
      color: PALETTE.lens,
      shape: ring(lensCx, lensCy, lensR, lensWidth),
      svg: `<circle cx="${lensCx}" cy="${lensCy}" r="${lensR}" fill="none" stroke="${PALETTE.lens}" stroke-width="${lensWidth}"/>`,
    },

    // A highlight arc on the upper left: what makes the circle read as glass
    // rather than as a plain "o". Dropped below 32px, where it is sub-pixel.
    {
      color: '#ffffffcc',
      minSize: 32,
      shape: subtract(
        ring(lensCx, lensCy, lensR - 9, 3.5),
        (px, py) => px > lensCx - 6 || py > lensCy,
      ),
      svg:
        `<path d="M ${lensCx - 6} ${lensCy - lensR + 9} A ${lensR - 9} ${lensR - 9} 0 0 0 ` +
        `${lensCx - lensR + 9} ${lensCy}" fill="none" stroke="#ffffffcc" stroke-width="3.5" stroke-linecap="round"/>`,
    },
  ];
}

/** Rasterises the icon at `size` pixels square. */
export function drawIcon(canvas) {
  const scale = canvas.size / DESIGN_SIZE;
  for (const layer of layers()) {
    // A layer may opt out below a size at which it would be sub-pixel noise.
    if (layer.minSize !== undefined && canvas.size < layer.minSize) continue;
    paint(canvas, scale, parseColor(layer.color), layer.shape);
  }
  return canvas;
}

/** The same icon as SVG, generated from the same layer list. */
export function toSvg() {
  const body = layers()
    .map((layer) => `  ${layer.svg}`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  GENERATED FILE - do not edit.

  Source of truth: scripts/icon-design.mjs
  Regenerate:      npm run icons
  Verify:          npm run icons:check
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"
     role="img" aria-label="sf-releaselens: a lens over a release pipeline">
${body}
</svg>
`;
}
