import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH_BITS } from "./defines.js";
import { SH_ARRAY_COUNTS } from "./splatData.js";

const COLUMN_BITS = SPLAT_TEX_WIDTH_BITS - 2;
const COLUMNS = 1 << COLUMN_BITS;
const MAX_LAYERS = 256;

export function getShPaletteLayout(count, degree) {
  const width = 1 << SPLAT_TEX_WIDTH_BITS;
  const stride = SH_ARRAY_COUNTS[degree];
  const rows = Math.max(1, Math.ceil(count / COLUMNS));
  // Whole tiles stay in one layer, including SH4's six-row tiles.
  const maxRows = 2 ** Math.floor(Math.log2(SPLAT_TEX_HEIGHT / stride));
  const rowsPerLayer = Math.min(rows, maxRows);
  const height = rowsPerLayer * stride;
  const depth = Math.ceil(rows / rowsPerLayer);
  if (depth > MAX_LAYERS)
    throw new Error("SH palette exceeds texture array capacity");
  const layerBits = COLUMN_BITS + Math.ceil(Math.log2(rowsPerLayer));
  return {
    width,
    height,
    depth,
    layerBits,
    byteLength: width * height * depth * 4,
  };
}

/** Convert decoder entries to texture tiles before transferring to the main thread. */
export function packShPalette(data, degree) {
  const stride = SH_ARRAY_COUNTS[degree];
  const count = data.length / (stride * 4);
  const { width, byteLength } = getShPaletteLayout(count, degree);
  if (stride === 1 && data.byteLength === byteLength) return data;
  const packed = new Uint32Array(byteLength / 4);
  for (let label = 0; label < count; label++) {
    const base =
      (label >>> COLUMN_BITS) * stride * width + (label & (COLUMNS - 1)) * 4;
    for (let row = 0; row < stride; row++) {
      const from = label * stride * 4 + row * 4;
      const to = base + row * width;
      for (let word = 0; word < 4; word++)
        packed[to + word] = data[from + word];
    }
  }
  return packed;
}

/** Retain the leading coefficient rows of an already tiled palette. */
export function truncateShPalette(data, degree, maxSh) {
  const previous = SH_ARRAY_COUNTS[degree];
  const stride = SH_ARRAY_COUNTS[maxSh];
  const count = data.length / (previous * 4);
  const { width, byteLength } = getShPaletteLayout(count, maxSh);
  const packed = new Uint32Array(byteLength / 4);
  for (let from = 0, to = 0; from < data.length; from += previous * width) {
    packed.set(data.subarray(from, from + stride * width), to);
    to += stride * width;
  }
  return packed;
}
