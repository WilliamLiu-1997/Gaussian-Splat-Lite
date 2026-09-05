import type { SplatMesh } from "../scene/SplatMesh";
import type { SplatAccumulator } from "./SplatAccumulator";

type SortCenterEntry = {
  meshId: number;
  centerVersion: number;
  sortVersion: number;
};

/** Tracks raw-center and matrix revisions cached by the sort worker. */
export class SortCenterCache {
  private entries = new Map<SplatMesh, SortCenterEntry>();
  private freeMeshIds: number[] = [];
  private nextMeshId = 0;

  private allocateMeshId() {
    const reused = this.freeMeshIds.pop();
    if (reused !== undefined) return reused;

    if (this.nextMeshId > 0xffff_ffff) {
      throw new Error("Sort center mesh ID space exhausted");
    }
    return this.nextMeshId++;
  }

  dispose() {
    this.entries.clear();
    this.freeMeshIds.length = 0;
    this.nextMeshId = 0;
  }

  prepare(current: SplatAccumulator) {
    const rangeMeshIds = new Uint32Array(current.mapping.length);
    const rangeBases = new Uint32Array(current.mapping.length);
    const rangeCounts = new Uint32Array(current.mapping.length);
    const retiredNodes = new Set(this.entries.keys());
    const changedCenters: {
      node: SplatMesh;
      count: number;
      rangeIndex: number;
    }[] = [];
    const changedMatrices: {
      node: SplatMesh;
      rangeIndex: number;
    }[] = [];
    let updateCount = 0;

    current.mapping.forEach(
      ({ node, base, count, centerVersion, sortVersion }, rangeIndex) => {
        retiredNodes.delete(node);
        let entry = this.entries.get(node);
        if (!entry) {
          // Store a provisional entry immediately so a failed worker call can
          // retry with the same ID. Its sentinel version forces a re-upload.
          entry = {
            meshId: this.allocateMeshId(),
            centerVersion: -1,
            sortVersion: -1,
          };
          this.entries.set(node, entry);
        }

        rangeMeshIds[rangeIndex] = entry.meshId;
        rangeBases[rangeIndex] = base;
        rangeCounts[rangeIndex] = count;

        if (entry.centerVersion !== centerVersion) {
          changedCenters.push({
            node,
            count,
            rangeIndex,
          });
          updateCount += count;
        }
        if (entry.sortVersion !== sortVersion) {
          changedMatrices.push({
            node,
            rangeIndex,
          });
        }
      },
    );

    const centerUpdateRangeIndices = new Uint32Array(changedCenters.length);
    const updateCenters = new Float32Array(updateCount * 3);

    let updateBase = 0;
    changedCenters.forEach(({ node, count, rangeIndex }, updateIndex) => {
      centerUpdateRangeIndices[updateIndex] = rangeIndex;

      if (!node.splats) throw new Error("SplatMesh has no source");
      node.splats.copySortCenters(updateCenters, updateBase * 3, count);
      updateBase += count;
    });

    const matrixUpdateRangeIndices = new Uint32Array(changedMatrices.length);
    const updateMatrices = new Float64Array(changedMatrices.length * 16);
    changedMatrices.forEach(({ node, rangeIndex }, updateIndex) => {
      matrixUpdateRangeIndices[updateIndex] = rangeIndex;
      updateMatrices.set(node.matrixWorld.elements, updateIndex * 16);
    });

    return {
      payload: {
        centerUpdateRangeIndices,
        updateCenters,
        matrixUpdateRangeIndices,
        updateMatrices,
        rangeMeshIds,
        rangeBases,
        rangeCounts,
      },
      commit: () => {
        for (const { node, centerVersion, sortVersion } of current.mapping) {
          const entry = this.entries.get(node);
          if (!entry) continue;
          entry.centerVersion = centerVersion;
          entry.sortVersion = sortVersion;
        }
        // Recycle IDs only after the worker accepted the replacement state.
        // A mesh that later becomes active again gets a fresh entry and must
        // upload all of its centers before using its recycled ID.
        for (const node of retiredNodes) {
          const entry = this.entries.get(node);
          if (!entry) continue;
          this.entries.delete(node);
          this.freeMeshIds.push(entry.meshId);
        }
      },
    };
  }
}
