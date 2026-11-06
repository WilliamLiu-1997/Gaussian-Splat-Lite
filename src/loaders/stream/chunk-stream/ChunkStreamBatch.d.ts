import type * as THREE from "three";
import type { ReorderedSplatResult } from "../../../data/defines.js";
import type { ShPalette } from "../../../data/shPalette.js";
import { SplatMesh } from "../../../scene/SplatMesh.js";

/** Regions share one source, one scene node and one accumulator generation call. */
export declare class ChunkStreamBatch extends SplatMesh {
  private readonly group;
  private readonly onEmpty;
  private readonly source;
  private readonly slots;
  constructor(
    capacity: number,
    numSh: number,
    group: THREE.Group,
    onEmpty: () => void,
    palette?: ShPalette,
  );
  writeRegion(start: number, data: ReorderedSplatResult): void;
  setRegionOpacity(start: number, opacity: number): void;
  releaseRegion(start: number): void;
}
