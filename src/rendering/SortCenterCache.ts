import type { SplatMesh } from "../scene/SplatMesh";
import type { SplatAccumulator, SplatMapping } from "./SplatAccumulator";

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
    return this.freeMeshIds.pop() ?? this.nextMeshId++;
  }

  dispose() {
    this.entries.clear();
    this.freeMeshIds.length = 0;
    this.nextMeshId = 0;
  }

  prepare(current: SplatAccumulator) {
    const { mapping } = current;
    // Commit the versions captured now, even if the mapping changes before
    // the worker accepts this state.
    const committed: {
      entry: SortCenterEntry;
      centerVersion: number;
      sortVersion: number;
    }[] = [];
    const rangeMeshIds = new Uint32Array(mapping.length);
    const rangeBases = new Uint32Array(mapping.length);
    const rangeCounts = new Uint32Array(mapping.length);
    const retiredEntries = new Map(this.entries);
    const changedCenters: {
      source: SplatMapping["source"];
      count: number;
      rangeIndex: number;
    }[] = [];
    const changedMatrices: {
      matrixWorld: SplatMapping["matrixWorld"];
      rangeIndex: number;
    }[] = [];
    let updateCount = 0;

    mapping.forEach(
      (
        { node, source, matrixWorld, base, count, centerVersion, sortVersion },
        rangeIndex,
      ) => {
        retiredEntries.delete(node);
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

        committed.push({ entry, centerVersion, sortVersion });
        rangeMeshIds[rangeIndex] = entry.meshId;
        rangeBases[rangeIndex] = base;
        rangeCounts[rangeIndex] = count;

        if (entry.centerVersion !== centerVersion) {
          changedCenters.push({
            source,
            count,
            rangeIndex,
          });
          updateCount += count;
        }
        if (entry.sortVersion !== sortVersion) {
          changedMatrices.push({
            matrixWorld,
            rangeIndex,
          });
        }
      },
    );

    const centerUpdateRangeIndices = new Uint32Array(changedCenters.length);
    const updateCenters = new Float32Array(updateCount * 3);

    let updateBase = 0;
    changedCenters.forEach(({ source, count, rangeIndex }, updateIndex) => {
      centerUpdateRangeIndices[updateIndex] = rangeIndex;

      if (!source) throw new Error("Splat mapping has no source");
      source.copySortCenters(updateCenters, updateBase * 3, count);
      updateBase += count;
    });

    const matrixUpdateRangeIndices = new Uint32Array(changedMatrices.length);
    const updateMatrices = new Float64Array(changedMatrices.length * 16);
    changedMatrices.forEach(({ matrixWorld, rangeIndex }, updateIndex) => {
      matrixUpdateRangeIndices[updateIndex] = rangeIndex;
      updateMatrices.set(matrixWorld.elements, updateIndex * 16);
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
        // The renderer serializes updates and skips commit after disposal.
        for (const { entry, centerVersion, sortVersion } of committed) {
          entry.centerVersion = centerVersion;
          entry.sortVersion = sortVersion;
        }
        // Recycle IDs only after the worker accepted the replacement state.
        // A mesh that later becomes active again gets a fresh entry and must
        // upload all of its centers before using its recycled ID.
        for (const [node, entry] of retiredEntries) {
          this.entries.delete(node);
          this.freeMeshIds.push(entry.meshId);
        }
      },
    };
  }
}
