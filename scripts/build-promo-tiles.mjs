/**
 * The promotional tiles the Chrome Web Store asks for.
 *
 *   node scripts/build-promo-tiles.mjs
 *
 * Two sizes, and the store treats them very differently:
 *
 *   440x280   **required.** A listing without a small promotional tile is
 *             rejected. `docs/STORE-LISTING.md` used to call it "optional but
 *             strongly recommended", which was wrong.
 *   1400x560  optional — but an extension with no marquee tile cannot be
 *             featured, so it is optional in the sense that being unfeatured is.
 *
 * Both are drawn from `scripts/icon-design.mjs`, the same definition that
 * produces the icon and the SVG, using the project's own PNG codec. No image
 * dependency, and no way for a tile to depict an icon the extension does not
 * ship.
 *
 * **No text.** The store's own guidance is to keep promotional images free of
 * it, and this project has no font renderer — hand-plotted letterforms would
 * look worse than the absence of any. The wordmark is on the listing page
 * beside the tile in any case.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drawIcon } from './icon-design.mjs';
import { encodePng } from './lib/png.mjs';
import { createCanvas } from './lib/raster.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(projectRoot, 'build-assets', 'promo');

/** The icon's own plate colour, so the tiles and the icon agree. */
const PLATE = { r: 0x1b, g: 0x24, b: 0x30 };

/**
 * A gentle vertical lift, lightest at the top.
 *
 * Flat `#1b2430` at 1400x560 reads as a rendering failure rather than a design
 * choice. Eight points of lightness is enough to look intentional and small
 * enough that the tile still matches the icon beside it.
 */
const LIFT = 8;

const TILES = [
  { name: 'small-tile-440x280.png', width: 440, height: 280, icon: 152 },
  { name: 'marquee-1400x560.png', width: 1400, height: 560, icon: 288 },
];

async function main() {
  await mkdir(OUT, { recursive: true });

  for (const tile of TILES) {
    const pixels = plate(tile.width, tile.height);
    const icon = drawIcon(createCanvas(tile.icon));
    centre(pixels, tile, icon);
    const path = join(OUT, tile.name);
    await writeFile(path, encodePng(pixels, tile.width, tile.height));
    process.stdout.write(`  wrote build-assets/promo/${tile.name} (${tile.width}x${tile.height})\n`);
  }

  process.stdout.write(
    '\nsf-releaselens: 440x280 is required by the store; 1400x560 is what a featured listing needs.\n',
  );
}

/** An opaque plate with the vertical lift applied. */
function plate(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const lift = Math.round(LIFT * (1 - y / (height - 1)));
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      pixels[index] = PLATE.r + lift;
      pixels[index + 1] = PLATE.g + lift;
      pixels[index + 2] = PLATE.b + lift;
      pixels[index + 3] = 255;
    }
  }

  return pixels;
}

/**
 * Composites the icon in the middle of the tile.
 *
 * Source-over on straight alpha: the icon's plate is a rounded rectangle, so
 * its corners are transparent and a straight copy would punch four square holes
 * of nothing into the tile.
 */
function centre(pixels, tile, icon) {
  const offsetX = Math.floor((tile.width - icon.size) / 2);
  const offsetY = Math.floor((tile.height - icon.size) / 2);

  for (let y = 0; y < icon.size; y += 1) {
    for (let x = 0; x < icon.size; x += 1) {
      const from = (y * icon.size + x) * 4;
      const alpha = icon.rgba[from + 3] / 255;
      if (alpha === 0) continue;

      const to = ((y + offsetY) * tile.width + (x + offsetX)) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[to + channel] =
          icon.rgba[from + channel] * alpha + pixels[to + channel] * (1 - alpha);
      }
      pixels[to + 3] = 255;
    }
  }
}

main().catch((cause) => {
  process.stderr.write(`\nsf-releaselens: building promo tiles failed: ${cause.message}\n`);
  process.exitCode = 1;
});
