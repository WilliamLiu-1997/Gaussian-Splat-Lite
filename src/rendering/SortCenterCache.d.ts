import type { SplatAccumulator } from "./SplatAccumulator.js";
/** Tracks raw-center and matrix revisions cached by the sort worker. */
export declare class SortCenterCache {
  private entries;
  private freeMeshIds;
  private nextMeshId;
  private allocateMeshId;
  dispose(): void;
  prepare(current: SplatAccumulator): {
    payload: {
      centerUpdateRangeIndices: Uint32Array<ArrayBuffer>;
      updateCenters: Float32Array<ArrayBuffer>;
      matrixUpdateRangeIndices: Uint32Array<ArrayBuffer>;
      updateMatrices: Float64Array<ArrayBuffer>;
      rangeMeshIds: Uint32Array<ArrayBuffer>;
      rangeBases: Uint32Array<ArrayBuffer>;
      rangeCounts: Uint32Array<ArrayBuffer>;
    };
    commit: () => void;
  };
}
