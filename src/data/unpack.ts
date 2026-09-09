import * as THREE from "three";
import { fromHalf, uintBitsToFloat } from "../utils/numeric";
import {
  decodeQuatOctXy1010R12ToArray,
  decodeSplatOpacity,
} from "./splatCodec";

export function decodeSplat(
  splatArrays: [Uint32Array, Uint32Array],
  index: number,
): {
  center: THREE.Vector3;
  scales: THREE.Vector3;
  quaternion: THREE.Quaternion;
  color: THREE.Color;
  opacity: number;
} {
  // Returns a static object which is reused each time
  const result = splatFields;
  const i4 = index * 4;
  const [splatA, splatB] = splatArrays;
  result.center.x = uintBitsToFloat(splatA[i4]);
  result.center.y = uintBitsToFloat(splatA[i4 + 1]);
  result.center.z = uintBitsToFloat(splatA[i4 + 2]);
  result.opacity = decodeSplatOpacity(splatA[i4 + 3]);
  result.color.r = fromHalf(splatB[i4] & 0xffff);
  result.color.g = fromHalf(splatB[i4] >>> 16);
  result.color.b = fromHalf(splatB[i4 + 1] & 0xffff);
  result.scales.x = Math.exp(fromHalf(splatB[i4 + 1] >>> 16));
  result.scales.y = Math.exp(fromHalf(splatB[i4 + 2] & 0xffff));
  result.scales.z = Math.exp(fromHalf(splatB[i4 + 2] >>> 16));
  decodeQuatOctXy1010R12(splatB[i4 + 3], result.quaternion);
  return result;
}

const splatCenter = new THREE.Vector3();
const splatScales = new THREE.Vector3();
const splatQuaternion = new THREE.Quaternion();
const splatColor = new THREE.Color();
const splatFields = {
  center: splatCenter,
  scales: splatScales,
  quaternion: splatQuaternion,
  color: splatColor,
  opacity: 0.0,
};

const decodedQuaternion = [0, 0, 0, 1];

export function decodeQuatOctXy1010R12(
  encoded: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  decodeQuatOctXy1010R12ToArray(encoded, decodedQuaternion);
  out.set(
    decodedQuaternion[0],
    decodedQuaternion[1],
    decodedQuaternion[2],
    decodedQuaternion[3],
  );
  return out;
}
