/**
 * A GIF89a encoder, in the same spirit as `png.mjs` and `zip.mjs`: no
 * dependency, and small enough to read.
 *
 * It exists because the README wants an animated demo and there is no way to
 * produce one without either an image library or a system ffmpeg with a GIF
 * encoder. The ffmpeg that ships inside Playwright is built
 * `--disable-everything` and has neither a GIF muxer nor `palettegen`, so it
 * can extract frames but not assemble them. This assembles them.
 *
 * Three things make a UI recording small enough to commit:
 *
 *  - **Median-cut quantisation** to 255 colours. A panel screenshot has far
 *    more than that once text is antialiased, but they cluster tightly.
 *  - **Frame differencing.** Index 0 is transparent and every pixel identical
 *    to the previous frame uses it, with disposal "do not dispose". A mostly
 *    static panel then costs almost nothing per frame.
 *  - **LZW**, which GIF requires anyway, and which loves the long runs that
 *    differencing produces.
 */

/**
 * @param {{ width: number, height: number, frames: {rgba: Uint8ClampedArray, delayMs: number}[], loop?: number }} input
 * @returns {Buffer}
 */
export function encodeGif(input) {
  const { width, height, frames } = input;
  if (frames.length === 0) throw new Error('A GIF needs at least one frame.');

  // 255 rather than 256: index 0 is reserved for transparency.
  const palette = quantise(frames, 255);
  const indexed = frames.map((frame, index) =>
    toIndices(frame.rgba, palette, index === 0 ? undefined : frames[index - 1].rgba),
  );

  const out = [];
  out.push(Buffer.from('GIF89a', 'ascii'));

  // Logical screen descriptor. The global colour table is 256 entries, so the
  // size field is 7 (2^(7+1)).
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0b1111_0111; // global table present, 8-bit colour, 256 entries
  lsd[5] = 0; // background colour index
  lsd[6] = 0; // pixel aspect ratio: unspecified
  out.push(lsd);

  const table = Buffer.alloc(256 * 3);
  // Entry 0 is the transparent slot; its colour is never drawn.
  for (let index = 0; index < palette.length; index += 1) {
    table[(index + 1) * 3] = palette[index][0];
    table[(index + 1) * 3 + 1] = palette[index][1];
    table[(index + 1) * 3 + 2] = palette[index][2];
  }
  out.push(table);

  // Netscape application extension: loop forever.
  const loops = input.loop ?? 0;
  const netscape = Buffer.alloc(19);
  netscape[0] = 0x21;
  netscape[1] = 0xff;
  netscape[2] = 11;
  netscape.write('NETSCAPE2.0', 3, 'ascii');
  netscape[14] = 3;
  netscape[15] = 1;
  netscape.writeUInt16LE(loops, 16);
  netscape[18] = 0;
  out.push(netscape);

  for (let index = 0; index < frames.length; index += 1) {
    // Graphic control extension: delay, and transparency for the diff.
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 4;
    // Disposal 1 (leave in place) so an unchanged pixel keeps what is under it.
    gce[3] = (1 << 2) | 1;
    gce.writeUInt16LE(Math.max(2, Math.round(frames[index].delayMs / 10)), 4);
    gce[6] = 0; // transparent colour index
    gce[7] = 0;
    out.push(gce);

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0; // no local colour table, not interlaced
    out.push(descriptor);

    out.push(lzwEncode(indexed[index], 8));
  }

  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
}

/**
 * Median cut.
 *
 * Repeatedly splits the colour box with the widest channel at that channel's
 * median, which keeps detail where the image actually varies rather than
 * spending the palette on a uniform background.
 */
function quantise(frames, size) {
  const counts = new Map();
  for (const frame of frames) {
    // Every fourth pixel. The palette is about which colours exist, and a
    // 400x670 frame has plenty of evidence at that rate.
    for (let index = 0; index < frame.rgba.length; index += 16) {
      const key =
        (frame.rgba[index] << 16) | (frame.rgba[index + 1] << 8) | frame.rgba[index + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const colours = [...counts.entries()].map(([key, weight]) => ({
    r: (key >> 16) & 0xff,
    g: (key >> 8) & 0xff,
    b: key & 0xff,
    weight,
  }));

  if (colours.length <= size) {
    return colours.map((colour) => [colour.r, colour.g, colour.b]);
  }

  let boxes = [colours];
  while (boxes.length < size) {
    // Split the box with the widest spread; a box of one colour cannot split.
    let target = -1;
    let widest = -1;
    for (let index = 0; index < boxes.length; index += 1) {
      if (boxes[index].length < 2) continue;
      const range = spread(boxes[index]);
      if (range.width > widest) {
        widest = range.width;
        target = index;
      }
    }
    if (target === -1) break;

    const box = boxes[target];
    const channel = spread(box).channel;
    box.sort((a, b) => a[channel] - b[channel]);
    const middle = Math.floor(box.length / 2);
    boxes = [...boxes.slice(0, target), box.slice(0, middle), box.slice(middle), ...boxes.slice(target + 1)];
  }

  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (const colour of box) {
      r += colour.r * colour.weight;
      g += colour.g * colour.weight;
      b += colour.b * colour.weight;
      total += colour.weight;
    }
    return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
  });
}

function spread(box) {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  for (const colour of box) {
    if (colour.r < minR) minR = colour.r;
    if (colour.r > maxR) maxR = colour.r;
    if (colour.g < minG) minG = colour.g;
    if (colour.g > maxG) maxG = colour.g;
    if (colour.b < minB) minB = colour.b;
    if (colour.b > maxB) maxB = colour.b;
  }
  const ranges = [
    { channel: 'r', width: maxR - minR },
    { channel: 'g', width: maxG - minG },
    { channel: 'b', width: maxB - minB },
  ];
  return ranges.reduce((a, b) => (a.width >= b.width ? a : b));
}

/**
 * Maps a frame to palette indices, using index 0 for any pixel the previous
 * frame already drew.
 */
function toIndices(rgba, palette, previous) {
  const pixels = rgba.length / 4;
  const indices = new Uint8Array(pixels);
  const cache = new Map();

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = pixel * 4;
    if (
      previous !== undefined &&
      previous[at] === rgba[at] &&
      previous[at + 1] === rgba[at + 1] &&
      previous[at + 2] === rgba[at + 2]
    ) {
      indices[pixel] = 0;
      continue;
    }

    const key = (rgba[at] << 16) | (rgba[at + 1] << 8) | rgba[at + 2];
    let index = cache.get(key);
    if (index === undefined) {
      index = nearest(rgba[at], rgba[at + 1], rgba[at + 2], palette) + 1;
      cache.set(key, index);
    }
    indices[pixel] = index;
  }
  return indices;
}

function nearest(r, g, b, palette) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < palette.length; index += 1) {
    const dr = r - palette[index][0];
    const dg = g - palette[index][1];
    const db = b - palette[index][2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/** GIF's variable-code-width LZW, packed into sub-blocks of at most 255 bytes. */
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let dictionary = new Map();
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;

  const bits = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bits.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const reset = () => {
    dictionary = new Map();
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  emit(clearCode);
  reset();

  let current = indices[0];
  for (let index = 1; index < indices.length; index += 1) {
    const next = indices[index];
    const key = current * 4096 + next;
    const existing = dictionary.get(key);
    if (existing !== undefined) {
      current = existing;
      continue;
    }

    emit(current);
    dictionary.set(key, nextCode);
    nextCode += 1;

    if (nextCode > 4095) {
      emit(clearCode);
      reset();
    } else if (nextCode > 1 << codeSize) {
      codeSize += 1;
    }
    current = next;
  }
  emit(current);
  emit(endCode);
  if (bitCount > 0) bits.push(bitBuffer & 0xff);

  const out = [Buffer.from([minCodeSize])];
  for (let at = 0; at < bits.length; at += 255) {
    const chunk = bits.slice(at, at + 255);
    out.push(Buffer.from([chunk.length]), Buffer.from(chunk));
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}
