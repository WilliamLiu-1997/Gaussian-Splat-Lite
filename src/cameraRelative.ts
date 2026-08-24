import type * as THREE from "three";

import type { SplatAccumulator } from "./SplatAccumulator";
import type { SplatMesh } from "./SplatMesh";

type SortCenterEntry = {
  meshId: number;
  sortVersion: number;
  generation: number;
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
  private entries = new WeakMap<SplatMesh, SortCenterEntry>();
  private nextMeshId = 0;
  private generation = 0;

  prepare(current: SplatAccumulator) {
    const rangeMeshIds = new Uint32Array(current.mapping.length);
    const rangeBases = new Uint32Array(current.mapping.length);
    const rangeCounts = new Uint32Array(current.mapping.length);
    const rangeOrigins = new Float64Array(current.mapping.length * 3);
    const activeEntries: SortCenterEntry[] = [];
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
        let previous = this.entries.get(node);
        if (!previous) {
          if (this.nextMeshId > 0xffff_ffff) {
            throw new Error("Sort center mesh ID space exhausted");
          }
          // Store a provisional entry immediately so a failed worker call can
          // retry with the same ID. Its sentinel version forces a re-upload.
          previous = {
            meshId: this.nextMeshId++,
            sortVersion: -1,
            generation: -1,
          };
          this.entries.set(node, previous);
        }

        activeEntries.push(previous);

        rangeMeshIds[rangeIndex] = previous.meshId;
        rangeBases[rangeIndex] = base;
        rangeCounts[rangeIndex] = count;

        const elements = node.matrixWorld.elements;
        const originTarget = rangeIndex * 3;
        rangeOrigins[originTarget] = elements[12];
        rangeOrigins[originTarget + 1] = elements[13];
        rangeOrigins[originTarget + 2] = elements[14];

        if (
          previous.sortVersion !== sortVersion ||
          previous.generation !== this.generation
        ) {
          changed.push({
            node,
            entry: previous,
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

    const generation = this.generation + 1;

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
        for (const entry of activeEntries) entry.generation = generation;
        this.generation = generation;
      },
    };
  }
}
