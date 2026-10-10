import type * as THREE from "three";
import type { ReorderedSplatResult } from "../../../data/defines.js";
import { SplatMesh } from "../../../scene/SplatMesh.js";
/** Regions share one source, one scene node and one accumulator generation call. */
export declare class SogStreamBatch extends SplatMesh {
  readonly numSh: number;
  private readonly group;
  private readonly onEmpty;
  private readonly source;
  private readonly slots;
  constructor(
    capacity: number,
    numSh: number,
    group: THREE.Group,
    onEmpty: () => void,
  );
  get residentBytes(): number;
  writeRegion(start: number, data: ReorderedSplatResult): void;
  setRegionOpacity(start: number, opacity: number): void;
  releaseRegion(start: number): void;
}
