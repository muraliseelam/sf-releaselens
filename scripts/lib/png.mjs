/**
 * A minimal PNG encoder and decoder, Node standard library only.
 *
 * Rasterising an SVG normally means pulling in `sharp`, `resvg` or `canvas` —
 * a native binary, a postinstall step, and a supply-chain surface — to produce
 * four small images. The icon this project needs is a handful of circles and
 * rectangles, so drawing it directly and writing the PNG ourselves is both
 * smaller and more auditable than the dependency would be.
 *
 * Scope is deliberately narrow: 8-bit RGBA, non-interlaced, filter type 0. That
 * is what we write, so it is all we need to read back.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, per the PNG specification. Table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encodes RGBA pixels as a PNG.
 *
 * Every scanline uses filter type 0 (None). A real encoder would choose a
 * filter per line for compression; fixing it makes the output a pure function
 * of the pixels, which is what lets `--check` compare two runs meaningfully.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba  width * height * 4 bytes
 */
export function encodePng(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} bytes of RGBA, received ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decodes a PNG this module wrote, back to pixels.
 *
 * Exists so `--check` can compare **pixels** rather than bytes. Comparing bytes
 * would make the check fail whenever zlib's output changes between Node
 * versions, which says nothing about whether the icon changed.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data[9];
      if (data[8] !== 8 || data[12] !== 0) {
        throw new Error('Only 8-bit, non-interlaced PNGs are supported');
      }
      // 6 is RGBA, which is what this file writes. 2 is RGB, which is what
      // Chromium's screenshot pipeline writes for an opaque page — and those
      // are the images `compose-store-shots.mjs` reads.
      if (colourType !== 2 && colourType !== 6) {
        throw new Error(`Unsupported PNG colour type ${colourType}; expected 2 (RGB) or 6 (RGBA)`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  // Unfiltered in the source layout, then widened to RGBA below. Filters are
  // defined over the encoded bytes, so this cannot be done in one pass.
  const flat = new Uint8ClampedArray(width * height * channels);

  /*
   * All five scanline filters, not just the one this file writes.
   *
   * `encodePng` emits filter 0 because a deterministic byte stream is worth
   * more here than a smaller file. Reading is a different job: this decoder is
   * pointed at PNGs from Chromium's screenshot pipeline, which picks a filter
   * per row, so refusing anything but 0 would refuse almost every real PNG.
   * Filters are defined in RFC 2083 §6; `left`, `up` and `upLeft` are the
   * already-reconstructed bytes, treated as zero off the edge of the image.
   */
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + x];
      const left = x >= channels ? flat[y * stride + x - channels] : 0;
      const up = y > 0 ? flat[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? flat[(y - 1) * stride + x - channels] : 0;

      let reconstructed;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + ((left + up) >> 1);
          break;
        case 4:
          reconstructed = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG scanline filter ${filter} on row ${y}`);
      }
      // Reconstruction is modulo 256, which is what the byte view gives us.
      flat[y * stride + x] = reconstructed & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: flat };

  // Widen RGB to RGBA. Everything downstream works in one layout, and an image
  // with no alpha channel is fully opaque by definition.
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = flat[pixel * 3];
    rgba[pixel * 4 + 1] = flat[pixel * 3 + 1];
    rgba[pixel * 4 + 2] = flat[pixel * 3 + 2];
    rgba[pixel * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** The Paeth predictor from RFC 2083 §6.6: whichever neighbour is closest. */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  if (dUp <= dUpLeft) return up;
  return upLeft;
}
