import * as THREE from "three";

const rotationMatrix = new THREE.Matrix4();
const axisX = new THREE.Vector3();
const axisY = new THREE.Vector3();
const axisZ = new THREE.Vector3();
const sourceAxis = new THREE.Vector3();

/**
 * Extracts the positive per-axis scale and approximate rotation used by the
 * PlayCanvas-style splat work-buffer transform.
 *
 * Unlike Matrix4.decompose(), this remains finite when a model scale axis is
 * zero. When possible, the missing basis axis is reconstructed from the other
 * two so degenerate transforms retain a stable orientation.
 */
export function decomposeSplatTransform(
  matrix: THREE.Matrix4,
  scale: THREE.Vector3,
  rotation: THREE.Quaternion,
) {
  const source = matrix.elements;
  const sx = Math.hypot(source[0], source[1], source[2]);
  const sy = Math.hypot(source[4], source[5], source[6]);
  const sz = Math.hypot(source[8], source[9], source[10]);
  scale.set(sx, sy, sz);

  axisX.set(source[0], source[1], source[2]);
  axisY.set(source[4], source[5], source[6]);
  axisZ.set(source[8], source[9], source[10]);
  if (sx > 0) axisX.multiplyScalar(1 / sx);
  if (sy > 0) axisY.multiplyScalar(1 / sy);
  if (sz > 0) axisZ.multiplyScalar(1 / sz);

  const nonZeroAxes = Number(sx > 0) + Number(sy > 0) + Number(sz > 0);
  if (nonZeroAxes === 0) {
    rotation.identity();
    return;
  }

  if (nonZeroAxes === 1) {
    const localAxis = sx > 0 ? 0 : sy > 0 ? 1 : 2;
    sourceAxis.set(
      localAxis === 0 ? 1 : 0,
      localAxis === 1 ? 1 : 0,
      localAxis === 2 ? 1 : 0,
    );
    rotation
      .setFromUnitVectors(
        sourceAxis,
        localAxis === 0 ? axisX : localAxis === 1 ? axisY : axisZ,
      )
      .normalize();
    return;
  }

  if (sx === 0) axisX.copy(axisY).cross(axisZ).normalize();
  if (sy === 0) axisY.copy(axisZ).cross(axisX).normalize();
  if (sz === 0) axisZ.copy(axisX).cross(axisY).normalize();
  if (matrix.determinant() < 0) axisX.negate();

  rotationMatrix.makeBasis(axisX, axisY, axisZ);
  rotation.setFromRotationMatrix(rotationMatrix).normalize();
}

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
