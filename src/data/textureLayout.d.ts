import type * as THREE from "three";
/** Permanently release an owned data texture, including CPU data retained by cached bindings. */
export declare function disposeDataTexture(
  texture: THREE.DataTexture | THREE.DataArrayTexture,
): void;
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
