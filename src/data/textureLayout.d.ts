import type * as THREE from "three";
export declare function getTextureSize(
  numSplats: number,
  maxLayers?: number,
): {
  width: number;
  height: number;
  depth: number;
  maxSplats: number;
};
export declare const emptyUintTexture: THREE.DataTexture;
export declare const emptySplatTexture: THREE.DataArrayTexture;
