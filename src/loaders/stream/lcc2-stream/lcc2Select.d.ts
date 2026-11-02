import type {
  SogLodRequest,
  SogVisibility,
} from "../sog-stream/sogVisibility.js";
import type { Lcc2Index } from "./lcc2Index.js";
/** Walk only the refinements reached by the shared distance/budget scale. */
export declare function selectLcc2Lods(
  inputs: {
    index: Lcc2Index;
    visibility: SogVisibility;
    leafBase: number;
  }[],
  request: SogLodRequest,
): Uint32Array;
