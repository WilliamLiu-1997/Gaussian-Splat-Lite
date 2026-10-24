import type { ReorderedSplatResult, SplatResult } from "../data/defines.js";
/** Reorder packed attributes and bounds, optionally writing the storage permutation. */
export declare function reorderSplats(
  data: SplatResult,
  options?: {
    boundsBlocks?: Float32Array;
    storageOrder?: Uint32Array;
    onProgress?: (loaded: number, total: number) => void;
  },
): asserts data is ReorderedSplatResult;
/** Restore packed chunk file order bit for bit; discard unused sort centers. */
export declare function restoreSplatOrder(data: SplatResult): void;
/** Original index to storage index; chunk ranges require a complete permutation. */
export declare function invertSplatOrder(
  order: Uint32Array,
): Uint32Array<ArrayBuffer>;
