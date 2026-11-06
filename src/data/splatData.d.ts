import type { SplatExtra } from "./defines.js";
export declare const SH_KEYS: readonly [
  "shBlock0",
  "shBlock1",
  "shBlock2",
  "shBlock3",
  "shBlock4",
  "shBlock5",
];
export declare const SH_ARRAY_COUNTS: readonly [0, 1, 2, 4, 6];
/** Merge cached min XYZ / max XYZ values without decoding records. */
export declare function unionSplatBounds(
  target: Float32Array,
  source: Float32Array,
  offset?: number,
): void;
export declare function resetSplatBounds(bounds: Float32Array): void;
export declare function getSplatShDegree(extra: SplatExtra): 0 | 1 | 2 | 3 | 4;
/** Two base textures plus per-splat SH blocks or one shared-palette label texture. */
export declare function getSplatTextureCount(
  numSh: number,
  indexedSh?: boolean,
): number;
/** Zeroed packed arrays for capacity records, one per texture. */
export declare function createSplatTextureArrays(
  capacity: number,
  numSh: number,
  indexedSh?: boolean,
): Uint32Array<ArrayBuffer>[];
/** Packed texture storage; capacity includes padding, but excludes sort centers. */
export declare function getSplatTextureBytes(
  capacity: number,
  numSh: number,
  indexedSh?: boolean,
): number;
/** Retained CPU arrays, including sort centers and extra attribute buffers. */
export declare function getSplatByteLength(data: {
  splatArrays: readonly Uint32Array[];
  sortCenters?: Float32Array;
  storageOrder?: Uint32Array;
  centerOnlyBoundingBox?: Float32Array;
  boundingBox?: Float32Array;
  spatialBounds?: Float32Array;
  extra: SplatExtra;
}): number;
