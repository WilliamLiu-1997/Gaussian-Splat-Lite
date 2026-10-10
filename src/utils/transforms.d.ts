import type * as THREE from "three";
/**
 * Extracts the positive per-axis scale and approximate rotation used by the
 * PlayCanvas-style splat work-buffer transform.
 *
 * Unlike Matrix4.decompose(), this remains finite when a model scale axis is
 * zero. When possible, the missing basis axis is reconstructed from the other
 * two so degenerate transforms retain a stable orientation.
 */
export declare function decomposeSplatTransform(
  matrix: THREE.Matrix4,
  scale: THREE.Vector3,
  rotation: THREE.Quaternion,
): boolean;
/**
 * Re-expresses an affine transform so it consumes positions relative to
 * `origin` instead of absolute world positions.
 *
 * If `matrix` maps p to A * p + t, the rebased matrix maps (p - origin) to
 * A * (p - origin) + (A * origin + t), which is the same result without doing
 * a large-coordinate subtraction in float32 shader code.
 */
export declare function rebaseAffineTransform(
  matrix: THREE.Matrix4,
  origin: THREE.Vector3,
): THREE.Matrix4;
