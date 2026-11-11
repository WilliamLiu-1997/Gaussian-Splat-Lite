import type * as THREE from "three";
import type { SogRegionSplatsOptions } from "../../../data/SogRegionSplats.js";
import type { ReorderedSplatResult } from "../../../data/defines.js";
import { SplatMesh } from "../../../scene/SplatMesh.js";

/** Regions share one source, one scene node and one accumulator generation call. */
export declare class ChunkStreamBatch extends SplatMesh {
  private readonly group;
  private readonly onEmpty;
  private readonly source;
  private readonly slots;
  constructor(
    options: SogRegionSplatsOptions & {
      group: THREE.Group;
      onEmpty: () => void;
    },
  );
  writeRegion(start: number, data: ReorderedSplatResult): void;
  setRegionOpacity(start: number, opacity: number): void;
  releaseRegion(start: number): void;
}
