import type { SplatExtra } from "./defines.js";
export declare const SH_KEYS: readonly ["sh1", "sh2", "sh3a", "sh3b"];
export declare const SH_ARRAY_COUNTS: readonly [0, 1, 2, 4];
/** Merge cached min XYZ / max XYZ values without decoding records. */
export declare function unionSplatBounds(
  target: Float32Array,
  source: Float32Array,
  offset?: number,
): void;
export declare function resetSplatBounds(bounds: Float32Array): void;
export declare function getSplatShDegree(extra: SplatExtra): 1 | 2 | 0 | 3;
/** Packed texture storage; capacity includes padding, but excludes sort centers. */
export declare function getSplatTextureBytes(
  capacity: number,
  numSh: number,
): number;
/** Retained CPU arrays, including sort centers and extra attribute buffers. */
export declare function getSplatByteLength(data: {
  splatArrays: readonly Uint32Array[];
  sortCenters?: Float32Array;
  sourceIds?: Uint32Array;
  centerOnlyBoundingBox?: Float32Array;
  boundingBox?: Float32Array;
  spatialBounds?: Float32Array;
  extra: SplatExtra;
}): number;
