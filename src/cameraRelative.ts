import * as THREE from "three";

import type { SplatAccumulator } from "./SplatAccumulator";

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
 * Builds persistent sort centers relative to each mesh origin. Keeping the
 * Float64 world origin separate lets the worker form a fresh camera-to-mesh
 * offset for every sort without rebuilding the per-splat Float32 data.
 */
export function buildSortCenters(current: SplatAccumulator) {
  const centers = new Float32Array(current.numSplats * 3);
  const rangeBases = new Uint32Array(current.mapping.length);
  const rangeCounts = new Uint32Array(current.mapping.length);
  const rangeOrigins = new Float64Array(current.mapping.length * 3);
  // Mapping rows are texture-aligned. NaN keeps gaps and disabled splats out
  // of the active radix-sort range, matching the old infinity attachment.
  centers.fill(Number.NaN);

  const objectToWorld = new THREE.Matrix4();

  current.mapping.forEach(({ node, base, count }, rangeIndex) => {
    rangeBases[rangeIndex] = base;
    rangeCounts[rangeIndex] = count;

    const source = node.splats;
    if (!source) return;

    // Keep the complete affine basis, but store its Float64 translation once
    // per mesh instead of narrowing it into every Float32 splat center.
    objectToWorld.copy(node.matrixWorld);
    const elements = objectToWorld.elements;
    const originTarget = rangeIndex * 3;
    rangeOrigins[originTarget] = elements[12];
    rangeOrigins[originTarget + 1] = elements[13];
    rangeOrigins[originTarget + 2] = elements[14];

    source.forEachCenter((index, x, y, z) => {
      if (index >= count || Number.isNaN(x)) {
        return;
      }
      const target = (base + index) * 3;
      centers[target] = elements[0] * x + elements[4] * y + elements[8] * z;
      centers[target + 1] = elements[1] * x + elements[5] * y + elements[9] * z;
      centers[target + 2] =
        elements[2] * x + elements[6] * y + elements[10] * z;
    });
  });

  return { centers, rangeBases, rangeCounts, rangeOrigins };
}
