import type { LodTreeIndex } from "../chunk-stream/lodTree.js";
export type Lcc2Index = LodTreeIndex & { environment: number };
/** LCC2 0.0.x stores one file range per node of an N-ary LOD tree. */
export declare function parseLcc2Index(
  value: unknown,
  baseUrl: string,
): Lcc2Index;
