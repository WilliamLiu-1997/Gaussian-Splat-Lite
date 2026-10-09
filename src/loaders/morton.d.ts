import type { ReorderedSplatResult, SplatResult } from "../data/defines.js";
/** Reorder packed attributes together and retain their original source indices. */
export declare function reorderSplats(
  data: SplatResult,
  boundsBlocks?: Float32Array,
  onProgress?: (loaded: number, total: number) => void,
): asserts data is ReorderedSplatResult;
/** Restore packed chunk file order bit for bit; discard unused sort centers. */
export declare function restoreSplatOrder(data: SplatResult): void;
/** Original index to storage index; chunk ranges require a complete permutation. */
export declare function invertSplatOrder(
  order: Uint32Array,
): Uint32Array<ArrayBuffer>;
