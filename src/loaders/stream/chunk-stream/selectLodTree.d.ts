import type { SogVisibility } from "../sog-stream/sogVisibility.js";
import type { LodTreeIndex, LodTreeRequest } from "./lodTree.js";
/** Walk only the refinements reached by the shared distance/budget scale. */
export declare function selectLodTree(
  inputs: {
    index: LodTreeIndex;
    visibility: SogVisibility;
    nodeBase: number;
  }[],
  request: LodTreeRequest,
): Uint32Array;
