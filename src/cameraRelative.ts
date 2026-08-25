import type * as THREE from "three";

import type { SplatAccumulator } from "./SplatAccumulator";
import type { SplatMesh } from "./SplatMesh";

type SortCenterEntry = {
  meshId: number;
  centerVersion: number;
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
 * Tracks raw-center and matrix revisions cached by the sort worker. Built-in
 * sources bulk-copy decoder-produced centers; callback extraction remains only
 * as a compatibility path for custom sources.
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
    // NaN keeps disabled splats out of the active radix-sort range.
    updateCenters.fill(Number.NaN);

    let updateBase = 0;
    changedCenters.forEach(({ node, count, rangeIndex }, updateIndex) => {
      centerUpdateRangeIndices[updateIndex] = rangeIndex;

      const source = node.splats;
      const centers = source?.getSortCenters?.();
      const valueCount = count * 3;
      if (centers) {
        if (centers.length < valueCount) {
          throw new Error("Sort center source is smaller than its Splat count");
        }
        updateCenters.set(centers.subarray(0, valueCount), updateBase * 3);
      } else {
        source?.forEachCenter((index, x, y, z) => {
          if (index >= count || Number.isNaN(x)) return;
          const target = (updateBase + index) * 3;
          updateCenters[target] = x;
          updateCenters[target + 1] = y;
          updateCenters[target + 2] = z;
        });
      }
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
