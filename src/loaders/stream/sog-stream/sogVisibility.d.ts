import type { StreamView } from "../streamView.js";
import type { SogLodIndex, SogLodOptions } from "./sogLod.js";
export type SogLodRequest = SogLodOptions & { view: StreamView };
/** Worker traversal state keeps leaf identities stable between selections. */
export declare class SogVisibility {
  private readonly manifest;
  private readonly leaves;
  private readonly frusta;
  private readonly bound;
  constructor(
    manifest: Pick<SogLodIndex, "nodes" | "leafOffsets" | "lods" | "lodLevels">,
  );
  private collect;
  /** Transfer only [leaf ID, LOD ordinal] pairs in loading priority order. */
  select(request: SogLodRequest): Uint32Array;
}
