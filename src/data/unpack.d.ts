import type * as THREE from "three";
export declare function decodeSplat(
  splatArrays: [Uint32Array, Uint32Array],
  index: number,
  result?: {
    center: THREE.Vector3;
    scales: THREE.Vector3;
    quaternion: THREE.Quaternion;
    color: THREE.Color;
    opacity: number;
  },
): {
  center: THREE.Vector3;
  scales: THREE.Vector3;
  quaternion: THREE.Quaternion;
  color: THREE.Color;
  opacity: number;
};
export declare function decodeQuatOctXy1010R12(
  encoded: number,
  out: THREE.Quaternion,
): THREE.Quaternion;
