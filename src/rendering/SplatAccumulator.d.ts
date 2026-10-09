import type * as THREE from "three";
import type { SplatMesh } from "../scene/SplatMesh.js";
import type { GaussianSplatCompatibleRenderer } from "./rendererUtils.js";
export type SplatMapping = {
  node: SplatMesh;
  matrixWorld: THREE.Matrix4;
  source: SplatMesh["splats"];
  version: number;
  sortVersion: number;
  centerVersion: number;
  mappingVersion: number;
  base: number;
  count: number;
};
type GenerateUniforms = Record<string, THREE.IUniform>;
type SplatDataTextures = readonly [THREE.Texture, THREE.Texture];
export declare class SplatAccumulator {
  time: number;
  deltaTime: number;
  viewOrigin: THREE.Vector3;
  private readonly previousOrigin;
  viewDirection: THREE.Vector3;
  maxSplats: number;
  numSplats: number;
  target: THREE.WebGLArrayRenderTarget | null;
  mapping: SplatMapping[];
  version: number;
  mappingVersion: number;
  private transformScale;
  private transformQuaternion;
  private fallbackGenerator;
  private readonly sceneNodes;
  private readonly frameContext;
  constructor();
  dispose(): void;
  private disposeStorage;
  getTextures(): SplatDataTextures;
  getStochasticSeeds(): THREE.Texture;
  /** Whether this accumulator was generated for stochastic rendering. */
  get hasStochasticSeeds(): boolean;
  /**
   * Regenerate moved meshes in place, without changing the source ranges used
   * by an in-flight sort. WebGL backends only.
   */
  refreshTransforms(renderer: GaussianSplatCompatibleRenderer): void;
  ensureGenerate({
    maxSplats,
    renderer,
    shrinkResources,
    stochasticSeeds,
  }: {
    maxSplats: number;
    renderer?: GaussianSplatCompatibleRenderer;
    shrinkResources?: boolean;
    stochasticSeeds?: boolean;
  }): boolean;
  prepareUniforms(
    mesh: SplatMesh,
    uniforms: GenerateUniforms,
    matrixWorld?: THREE.Matrix4,
  ): void;
  generate({
    mesh,
    base,
    count,
    renderer,
  }: {
    mesh: SplatMesh;
    base: number;
    count: number;
    renderer: GaussianSplatCompatibleRenderer;
  }): void;
  prepareGenerate({
    renderer,
    scene,
    timer,
    camera,
    layerCamera,
    previous,
    frameCallbacks,
    shrinkResources,
    excludedObjects,
  }: {
    renderer: GaussianSplatCompatibleRenderer;
    scene: THREE.Scene;
    timer: THREE.Timer;
    camera: THREE.Camera;
    layerCamera?: THREE.Camera;
    previous: SplatAccumulator;
    frameCallbacks?: boolean;
    shrinkResources?: boolean;
    excludedObjects?: ReadonlySet<THREE.Object3D>;
  }): {
    version: number;
    sortUpdated: boolean;
    requiredMaxSplats: number;
    generate: (shrinkResources?: boolean, stochasticSeeds?: boolean) => void;
  };
  static emptyTexture: THREE.DataArrayTexture;
  static emptyTextures: SplatDataTextures;
}
export {};
