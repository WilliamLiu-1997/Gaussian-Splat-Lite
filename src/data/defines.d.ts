export declare const SPLAT_TEX_WIDTH_BITS = 11;
export declare const SPLAT_TEX_HEIGHT_BITS = 11;
export declare const SPLAT_TEX_WIDTH: number;
export declare const SPLAT_TEX_HEIGHT: number;
export declare const SPLAT_TEX_MIN_HEIGHT = 1;
/** Valid block shifts include zero (one opacity per Splat). */
export declare const SPLAT_BLOCKS_DISABLED = 32;
export declare enum SplatFileType {
  PLY = "ply",
  SPZ = "spz",
  SOG = "sog",
  RAD = "rad",
}
export type SplatExtra = {
  sh1?: Uint32Array;
  sh2?: Uint32Array;
  sh3a?: Uint32Array;
  sh3b?: Uint32Array;
};
/** Morton storage records per cached spatial bounds block. */
export declare const SPLAT_BOUNDS_BLOCK_SIZE = 256;
export type SplatResult = {
  numSplats: number;
  splatArrays: [Uint32Array, Uint32Array];
  sortCenters?: Float32Array;
  /** Storage index to original source index; absent for identity order. */
  sourceIds?: Uint32Array;
  /** Local finite center bounds: min XYZ followed by max XYZ. */
  centerOnlyBoundingBox?: Float32Array;
  /** Local scale/rotation bounds at source alpha 0.01, including kernel shape. */
  boundingBox?: Float32Array;
  /** Per 256 records: min/max XYZ at source alpha 0.01, including scale, rotation and shape. */
  spatialBounds?: Float32Array;
  extra: SplatExtra;
};
/** Spatially reordered records with source IDs and cached local bounds. */
export type ReorderedSplatResult = SplatResult & {
  sourceIds: Uint32Array;
  centerOnlyBoundingBox: Float32Array;
  boundingBox: Float32Array;
  spatialBounds: Float32Array;
};
