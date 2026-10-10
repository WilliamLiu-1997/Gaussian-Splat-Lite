import type * as THREE from "three";
import type { GaussianSplatRenderer } from "../GaussianSplatRenderer.js";
import type { SplatBackend } from "../backend.js";
import type { SplatShading as NodeShading } from "../tsl/SplatMaterial.js";
import type { SplatShading as WebGLShading } from "../webgl/SplatMaterial.js";
import type { ProjectedSurfaces } from "../webgpu/ProjectedSplats.js";
import type { ProjectionCache } from "../webgpu/ProjectionCache.js";
/**
 * Lighting of one GaussianSplatRenderer, and the renderer's one entry into
 * this folder. The backend selects materials and kernels by `shading`.
 */
export declare class SplatLighting {
  /** For a backend with compute kernels: what shaded ones cache of a Splat. */
  static createSurfaces(cache: ProjectionCache): ProjectedSurfaces;
  private readonly owner;
  private readonly renderer;
  private readonly classic;
  private readonly lights;
  private readonly data;
  private readonly lit;
  private root;
  private frame;
  enabled: boolean;
  constructor(owner: GaussianSplatRenderer, backend: SplatBackend);
  /** What the backend selects shaded materials by; null draws unlit. */
  get shading(): NodeShading | WebGLShading | null;
  /** Collects the lights before the draw's uniforms update. */
  prepareDraw(scene: THREE.Object3D, camera: THREE.Camera): void;
  /** Reduces light storage to the lights the camera sees, lit or not. */
  shrinkResources(scene: THREE.Object3D, camera: THREE.Camera): void;
  private update;
  dispose(): void;
}
