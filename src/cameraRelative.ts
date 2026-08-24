import type * as THREE from "three";

import type { SplatAccumulator } from "./SplatAccumulator";
import type { SplatMesh } from "./SplatMesh";

type SortCenterEntry = {
  meshId: number;
  sortVersion: number;
};

/**
 * Re-expresses an affine transform so it consumes positions relative to
 * `origin` instead of absolute world positions.
 *
 * If `matrix` maps p to A * p + t, the rebased matrix maps (p - origin) to
 * A * (p - origin) + (A * origin + t), which is the same result without doing
 * a large-coordinate subtraction in float32 shader code.
 */
export function rebaseAffineTransform(
  matrix: THREE.Matrix4,
  origin: THREE.Vector3,
) {
  const elements = matrix.elements;
  const x = origin.x;
  const y = origin.y;
  const z = origin.z;

  const tx = elements[0] * x + elements[4] * y + elements[8] * z + elements[12];
  const ty = elements[1] * x + elements[5] * y + elements[9] * z + elements[13];
  const tz =
    elements[2] * x + elements[6] * y + elements[10] * z + elements[14];

  elements[12] = tx;
  elements[13] = ty;
  elements[14] = tz;
  return matrix;
}

/**
 * Tracks the per-mesh sort centers cached by the worker. The main thread only
 * builds changed meshes; unchanged centers remain exclusively in WASM.
 */
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
    const rangeOrigins = new Float64Array(current.mapping.length * 3);
    const retiredNodes = new Set(this.entries.keys());
    const changed: {
      node: SplatMesh;
      entry: SortCenterEntry;
      count: number;
      rangeIndex: number;
      sortVersion: number;
    }[] = [];
    let updateCount = 0;

    current.mapping.forEach(
      ({ node, base, count, sortVersion }, rangeIndex) => {
        retiredNodes.delete(node);
        let entry = this.entries.get(node);
        if (!entry) {
          // Store a provisional entry immediately so a failed worker call can
          // retry with the same ID. Its sentinel version forces a re-upload.
          entry = {
            meshId: this.allocateMeshId(),
            sortVersion: -1,
          };
          this.entries.set(node, entry);
        }

        rangeMeshIds[rangeIndex] = entry.meshId;
        rangeBases[rangeIndex] = base;
        rangeCounts[rangeIndex] = count;

        const elements = node.matrixWorld.elements;
        const originTarget = rangeIndex * 3;
        rangeOrigins[originTarget] = elements[12];
        rangeOrigins[originTarget + 1] = elements[13];
        rangeOrigins[originTarget + 2] = elements[14];

        if (entry.sortVersion !== sortVersion) {
          changed.push({
            node,
            entry,
            count,
            rangeIndex,
            sortVersion,
          });
          updateCount += count;
        }
      },
    );

    const updateRangeIndices = new Uint32Array(changed.length);
    const updateCenters = new Float32Array(updateCount * 3);
    // NaN keeps disabled splats out of the active radix-sort range.
    updateCenters.fill(Number.NaN);

    let updateBase = 0;
    changed.forEach(({ node, count, rangeIndex }, updateIndex) => {
      updateRangeIndices[updateIndex] = rangeIndex;

      const elements = node.matrixWorld.elements;
      node.splats?.forEachCenter((index, x, y, z) => {
        if (index >= count || Number.isNaN(x)) return;
        const target = (updateBase + index) * 3;
        updateCenters[target] =
          elements[0] * x + elements[4] * y + elements[8] * z;
        updateCenters[target + 1] =
          elements[1] * x + elements[5] * y + elements[9] * z;
        updateCenters[target + 2] =
          elements[2] * x + elements[6] * y + elements[10] * z;
      });
      updateBase += count;
    });

    return {
      payload: {
        updateRangeIndices,
        updateCenters,
        rangeMeshIds,
        rangeBases,
        rangeCounts,
        rangeOrigins,
      },
      commit: () => {
        for (const { entry, sortVersion } of changed) {
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
