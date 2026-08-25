import * as THREE from "three";
/**
 * Extracts the positive per-axis scale and approximate rotation used by the
 * PlayCanvas-style splat work-buffer transform.
 *
 * Unlike Matrix4.decompose(), this remains finite when a model scale axis is
 * zero. When possible, the missing basis axis is reconstructed from the other
 * two so a model-level collapse can still produce a correctly oriented 2DGS.
 */
export declare function decomposeSplatTransform(matrix: THREE.Matrix4, scale: THREE.Vector3, rotation: THREE.Quaternion): void;
