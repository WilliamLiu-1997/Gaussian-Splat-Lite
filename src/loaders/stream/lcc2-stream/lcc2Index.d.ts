import type { SogLodIndex } from "../sog-stream/sogLod.js";
export type Lcc2Index = SogLodIndex & {
  parents: Int32Array;
  /** Whether zero-count nodes can cover this subtree without loaded data. */
  emptyCoverage: Uint8Array;
  roots: Uint32Array;
  childOffsets: Uint32Array;
  children: Uint32Array;
  environment: number;
};
/** LCC2 0.0.x stores one file range per node of an N-ary LOD tree. */
export declare function parseLcc2Index(
  value: unknown,
  baseUrl: string,
): Lcc2Index;
