/**
 * Turns the walkthrough recording into the README's demo GIF.
 *
 *   npm run assets            capture the walkthrough (writes the .webm)
 *   npm run demo-gif          convert it to docs/media/demo.gif
 *
 * The GIF is the one generated asset that **is** committed, because GitHub
 * renders it inline and a `.webm` it does not.
 *
 * ## No system dependency
 *
 * Frames come out of the recording using the ffmpeg that Playwright already
 * installs for its own video capture — no ffmpeg on PATH is required, and
 * nothing is installed. That build is `--disable-everything`, so it can decode
 * VP8 and write PNGs but has no GIF muxer and no `palettegen`; the assembly is
 * done by `scripts/lib/gif.mjs`, in the same spirit as the project's own PNG
 * codec and ZIP writer.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeGif } from './lib/gif.mjs';
import { decodePng } from './lib/png.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VIDEO = join(projectRoot, 'build-assets', 'video', 'walkthrough.webm');
const FRAMES = join(projectRoot, 'build-assets', 'frames');
const TARGET = join(projectRoot, 'docs', 'media', 'demo.gif');

/**
 * 360px wide. The panel is 480; a README GIF is read at a glance rather than
 * studied, and every pixel is paid for three hundred times over in the file.
 */
const WIDTH = 360;
/** Frames per second. Below 8 the typing reads as stuttering. */
const FPS = 8;
/** Above this, a README takes too long to paint. See docs/ASSETS.md. */
const SIZE_BUDGET_BYTES = 5 * 1024 * 1024;

/** Playwright installs its own ffmpeg for video capture; this borrows it. */
function findFfmpeg() {
  const roots = [
    process.env['PLAYWRIGHT_BROWSERS_PATH'],
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter((root) => typeof root === 'string' && existsSync(root));

  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('ffmpeg')) continue;
      for (const name of ['ffmpeg-win64.exe', 'ffmpeg-mac', 'ffmpeg-linux']) {
        const candidate = join(root, entry, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function main() {
  if (!existsSync(VIDEO)) {
    throw new Error(
      `No recording at ${VIDEO}. Run \`npm run assets\` first — it drives the extension and records the walkthrough.`,
    );
  }
  const ffmpeg = findFfmpeg();
  if (ffmpeg === null) {
    throw new Error(
      'Could not find the ffmpeg that Playwright installs. Run `npx playwright install chromium`.',
    );
  }

  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });

  // `-r` rather than the `fps` filter: this ffmpeg build has neither `fps` nor
  // `format`, only `scale`, `crop` and `pad`.
  execFileSync(
    ffmpeg,
    ['-y', '-i', VIDEO, '-vf', `scale=${WIDTH}:-1`, '-r', String(FPS), '-f', 'image2', join(FRAMES, 'f%04d.png')],
    { stdio: 'pipe' },
  );

  const files = readdirSync(FRAMES)
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (files.length === 0) throw new Error('ffmpeg produced no frames.');

  const decoded = [];
  for (const name of files) {
    decoded.push(decodePng(await readFile(join(FRAMES, name))));
  }

  /*
   * Drop the blank frames at each end.
   *
   * The recording starts before the panel's first paint, so the opening second
   * is an empty white page — and the first frame of a GIF is its poster, the
   * still anybody who never presses play will see. A README whose demo appears
   * to be a blank rectangle is worse than one with no demo.
   */
  const busyness = decoded.map((frame) => distinctColours(frame.rgba));
  const threshold = Math.max(64, Math.max(...busyness) / 20);
  const first = busyness.findIndex((count) => count >= threshold);
  const last = busyness.length - 1 - [...busyness].reverse().findIndex((count) => count >= threshold);
  const kept = first === -1 ? decoded : decoded.slice(first, last + 1);
  if (kept.length === 0) throw new Error('Every frame looks blank; is the recording empty?');

  const width = kept[0].width;
  const height = kept[0].height;
  const frames = kept.map((frame, index) => ({
    rgba: frame.rgba,
    // A longer beat on the last frame, so the loop reads as deliberate rather
    // than as a video that snapped back.
    delayMs: index === kept.length - 1 ? 1200 : Math.round(1000 / FPS),
  }));

  const gif = encodeGif({ width, height, frames, loop: 0 });

  await mkdir(join(projectRoot, 'docs', 'media'), { recursive: true });
  await writeFile(TARGET, gif);

  const { size } = await stat(TARGET);
  process.stdout.write(
    `Wrote ${TARGET}\n` +
      `  ${frames.length} frames, ${width}x${height}, ${FPS}fps, ${(size / 1024 / 1024).toFixed(2)} MB\n`,
  );

  if (size > SIZE_BUDGET_BYTES) {
    process.stderr.write(
      `\nThat is over the ${SIZE_BUDGET_BYTES / 1024 / 1024} MB budget in docs/ASSETS.md.\n` +
        'Shorten the walkthrough, drop FPS, or reduce WIDTH in this script.\n',
    );
    process.exitCode = 1;
  }
}

await main();

/** A rough busyness measure: a blank page has a handful of colours, a panel thousands. */
function distinctColours(rgba) {
  const seen = new Set();
  for (let index = 0; index < rgba.length; index += 16) {
    seen.add((rgba[index] << 16) | (rgba[index + 1] << 8) | rgba[index + 2]);
  }
  return seen.size;
}
