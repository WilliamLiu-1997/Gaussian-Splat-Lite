import type * as THREE from "three";
import type { GaussianSplatCompatibleRenderer } from "./rendererUtils.js";
import type { SplatNodeMaterial } from "./tsl/SplatMaterial.js";
import type { Uniforms } from "./uniforms.js";
import type { WebGLFallbackSplatBackend } from "./webgl-fallback/SplatBackend.js";
import type { WebGLSplatBackend } from "./webgl/SplatBackend.js";
import type { ProjectedSurfaces } from "./webgpu/ProjectedSplats.js";
import type { ProjectionCache } from "./webgpu/ProjectionCache.js";
import type { WebGPUSplatBackend } from "./webgpu/SplatBackend.js";
export type SplatBackend =
  | WebGLSplatBackend
  | WebGPUSplatBackend
  | WebGLFallbackSplatBackend;
/**
 * `createSurfaces` serves the backend that projects in compute kernels: what
 * its shaded kernels cache of each Splat for shaded draws.
 */
export declare function createSplatBackend(
  renderer: GaussianSplatCompatibleRenderer,
  uniforms: Uniforms,
  options: SplatMaterialOptions,
  createSurfaces: (cache: ProjectionCache) => ProjectedSurfaces,
): SplatBackend;
export declare function configureSplatOutput(
  renderer: GaussianSplatCompatibleRenderer,
  target: THREE.RenderTarget | null,
  uniforms: Uniforms,
  encodeLinear?: boolean,
): void;
export type CPUOrderingUpdate = {
  ordering: Uint32Array;
  activeSplats: number;
  requiredCapacity: number;
  shrink: boolean;
};
export type SplatMaterial = THREE.ShaderMaterial | SplatNodeMaterial;
export type SplatMaterialOptions = {
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
};
