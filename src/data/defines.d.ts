export declare const SPLAT_TEX_WIDTH_BITS = 11;
export declare const SPLAT_TEX_HEIGHT_BITS = 11;
export declare const SPLAT_TEX_WIDTH: number;
export declare const SPLAT_TEX_HEIGHT: number;
export declare const SPLAT_TEX_MIN_HEIGHT = 1;
/** Fixed records per RAD streaming page slot. */
export declare const RAD_PAGE_SIZE = 65_536;
/** Fixed page slots per RAD pool; keep rad_lod.rs in sync. */
export declare const RAD_POOL_PAGE_COUNT = 8;
/** Valid block shifts include zero (one opacity per Splat). */
export declare const SPLAT_BLOCKS_DISABLED = 32;
export declare enum SplatFileType {
  PLY = "ply",
  SPZ = "spz",
  SOG = "sog",
  RAD = "rad",
}
export type SplatExtra = {
  /** Application-defined JSON from the SOG extras section. */
  extra?: unknown;
  /** Application-defined JSON shared by a streamed SOG scene. */
  sceneExtra?: unknown;
  blind?: SplatBlindTexture[];
  /** Shared SH entries in texture tile order, addressed by one uint32 label per splat. */
  shPalette?: Uint32Array;
  shLabels?: Uint32Array;
  shDegree?: 1 | 2 | 3 | 4;
  shBlock0?: Uint32Array;
  shBlock1?: Uint32Array;
  shBlock2?: Uint32Array;
  shBlock3?: Uint32Array;
  shBlock4?: Uint32Array;
  shBlock5?: Uint32Array;
};
export type SplatBlindField = {
  name: string;
  type: "u8" | "u16" | "u24" | "u32" | "f16" | "f32" | "unorm8" | "unorm16";
  range?: [number, number];
};
export type SplatBlindTexture = {
  fields: SplatBlindField[];
  data: Uint32Array;
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
