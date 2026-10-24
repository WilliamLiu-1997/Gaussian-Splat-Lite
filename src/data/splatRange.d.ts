import type { SplatResult } from "./defines.js";
/** Copy a contiguous range of file-order records before spatial reordering. */
export declare function extractSplatRange(
  source: SplatResult,
  start: number,
  count: number,
): SplatResult;
