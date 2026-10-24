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
  shBlock0?: Uint32Array;
  shBlock1?: Uint32Array;
  shBlock2?: Uint32Array;
  shBlock3?: Uint32Array;
  shBlock4?: Uint32Array;
  shBlock5?: Uint32Array;
};
/** Morton storage records per cached spatial bounds block. */
export declare const SPLAT_BOUNDS_BLOCK_SIZE = 256;
export type SplatResult = {
  numSplats: number;
  splatArrays: [Uint32Array, Uint32Array];
  sortCenters?: Float32Array;
  /** Internal permutation for restoring custom SOG chunks to decoded record order. */
  storageOrder?: Uint32Array;
  /** Local finite center bounds: min XYZ followed by max XYZ. */
  centerOnlyBoundingBox?: Float32Array;
  /** Local scale/rotation bounds at source alpha 0.01, including kernel shape. */
  boundingBox?: Float32Array;
  /** Per 256 records: min/max XYZ at source alpha 0.01, including scale, rotation and shape. */
  spatialBounds?: Float32Array;
  extra: SplatExtra;
};
/** Spatially reordered records with cached local bounds. */
export type ReorderedSplatResult = SplatResult & {
  centerOnlyBoundingBox: Float32Array;
  boundingBox: Float32Array;
  spatialBounds: Float32Array;
};
