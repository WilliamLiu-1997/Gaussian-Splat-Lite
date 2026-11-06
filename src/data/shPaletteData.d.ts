export declare function getShPaletteLayout(
  count: number,
  degree: number,
): {
  width: number;
  height: number;
  depth: number;
  layerBits: number;
  byteLength: number;
};

/** Convert decoder entries to texture tiles before transferring to the main thread. */
export declare function packShPalette(
  data: Uint32Array,
  degree: number,
): Uint32Array;

/** Retain the leading coefficient rows of an already tiled palette. */
export declare function truncateShPalette(
  data: Uint32Array,
  degree: number,
  maxSh: number,
): Uint32Array<ArrayBuffer>;
