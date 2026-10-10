import type { SplatResult } from "./defines.js";
/** Copy file-order records; the caller assigns source IDs after reordering. */
export declare function extractSplatRange(
  source: SplatResult,
  start: number,
  count: number,
): SplatResult;
