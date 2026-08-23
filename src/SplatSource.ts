import type * as THREE from "three";

export type SplatShTextures = {
  sh1?: THREE.DataArrayTexture;
  sh2?: THREE.DataArrayTexture;
  sh3a?: THREE.DataArrayTexture;
  sh3b?: THREE.DataArrayTexture;
};

/**
 * GPU and CPU access required by the fixed splat generation pipeline.
 *
 * Sources provide encoded texture data; shader construction and arbitrary
 * per-splat modifiers are deliberately not part of this interface.
 */
export interface SplatSource {
  needsUpdate: boolean;

  dispose(): void;
  getNumSplats(): number;
  getNumSh(): number;
  getSplatTextures(): readonly [THREE.DataArrayTexture, THREE.DataArrayTexture];
  getShTextures(): SplatShTextures;

  forEachCenter(
    callback: (index: number, x: number, y: number, z: number) => void,
  ): void;

  forEachSplat(
    callback: (
      index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color,
    ) => void,
  ): void;
}
