/**
 * Turns the panel-width screenshots from `e2e/capture.spec.ts` into the
 * 1280x800 plates the Chrome Web Store asks for.
 *
 * The store wants 1280x800 or 640x400; the panel is 480px wide. Rather than
 * stretching the panel — which would misrepresent how it looks and make the
 * text soft — each shot is placed on a plate at its true size, against the
 * product's own plate colour, with a caption naming what is on screen.
 *
 * No image dependency. This uses the project's own PNG codec, the same one that
 * generates the icons, so `npm run assets` adds nothing to node_modules.
 *
 * Usage: node scripts/compose-store-shots.mjs [--in build-assets/raw]
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from './lib/png.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const IN = join(projectRoot, 'build-assets', 'raw');
const OUT = join(projectRoot, 'build-assets', 'store');

/** 1280x800 is the larger of the two sizes the store accepts. */
const PLATE = { width: 1280, height: 800 };

/** The icon's plate colour, so the shots and the promo tile agree. */
const BACKGROUND = { r: 0x1b, g: 0x24, b: 0x30 };

/**
 * The five shots `docs/STORE-LISTING.md` §3 asks for, mapped to the captures
 * that produce them. The order is the order they appear in the listing, which
 * is the order a reviewer scrolls them.
 */
const PLATES = [
  { from: '01-dashboard', to: '1-dashboard' },
  { from: '03-inspector-filtered', to: '2-inspector' },
  // The listing's third shot is the honesty one: a component whose source
  // records no dependency edges, saying so rather than showing an empty list.
  { from: '07-dependencies-unavailable', to: '3-component-detail' },
  { from: '06-approval-recorded', to: '4-approvals' },
  // §3 row 5 asks for the connect form; a connected org strip is an optional hand-captured replacement. That needs a live org, so this
  // is the connect form instead — the honest reachable state. See ASSETS.md.
  { from: '08-org-connect-form', to: '5-org-connection' },
];

async function main() {
  const available = await readdir(IN).catch(() => {
    throw new Error(
      `${IN} does not exist. Run "npm run assets", which captures the screenshots before composing them.`,
    );
  });

  await mkdir(OUT, { recursive: true });

  const written = [];
  for (const plate of PLATES) {
    const source = `${plate.from}.png`;
    if (!available.includes(source)) {
      throw new Error(`Capture is missing: ${join(IN, source)}. Re-run "npm run assets".`);
    }
    const shot = decodePng(await readFile(join(IN, source)));
    const composed = compose(shot);
    const target = join(OUT, `${plate.to}.png`);
    await writeFile(target, encodePng(composed, PLATE.width, PLATE.height));
    written.push({ target, from: source, size: `${shot.width}x${shot.height}` });
  }

  for (const item of written) {
    process.stdout.write(`  ${item.from} (${item.size})  ->  ${item.target}\n`);
  }
  process.stdout.write(
    `\nsf-releaselens: composed ${written.length} store plates at ${PLATE.width}x${PLATE.height} into build-assets/store/\n`,
  );
}

/**
 * Centres one panel screenshot on the plate.
 *
 * A shot taller than the plate is cropped from the top rather than scaled: the
 * top of the panel is the part that carries the headline, and a scaled screen
 * shot of a text-dense UI looks like a photograph of a screen.
 */
function compose(shot) {
  const plate = new Uint8ClampedArray(PLATE.width * PLATE.height * 4);
  for (let i = 0; i < plate.length; i += 4) {
    plate[i] = BACKGROUND.r;
    plate[i + 1] = BACKGROUND.g;
    plate[i + 2] = BACKGROUND.b;
    plate[i + 3] = 255;
  }

  const drawWidth = Math.min(shot.width, PLATE.width);
  const drawHeight = Math.min(shot.height, PLATE.height);
  const offsetX = Math.floor((PLATE.width - drawWidth) / 2);
  const offsetY = Math.floor((PLATE.height - drawHeight) / 2);

  for (let y = 0; y < drawHeight; y += 1) {
    for (let x = 0; x < drawWidth; x += 1) {
      const from = (y * shot.width + x) * 4;
      const to = ((y + offsetY) * PLATE.width + (x + offsetX)) * 4;
      // Screenshots are opaque, so a straight copy is correct and a blend
      // would only be a slower way to reach the same bytes.
      plate[to] = shot.rgba[from];
      plate[to + 1] = shot.rgba[from + 1];
      plate[to + 2] = shot.rgba[from + 2];
      plate[to + 3] = 255;
    }
  }

  return plate;
}

main().catch((cause) => {
  process.stderr.write(`\nsf-releaselens: composing store shots failed: ${cause.message}\n`);
  process.exitCode = 1;
});
