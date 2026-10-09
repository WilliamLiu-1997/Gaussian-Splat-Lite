import type * as THREE from "three";
import type { GaussianSplatCompatibleRenderer } from "./rendererUtils.js";
import type { SplatNodeMaterial } from "./tsl/SplatMaterial.js";
import type { Uniforms } from "./uniforms.js";
import type { WebGLFallbackSplatBackend } from "./webgl-fallback/SplatBackend.js";
import type { WebGLSplatBackend } from "./webgl/SplatBackend.js";
import type { WebGPUSplatBackend } from "./webgpu/SplatBackend.js";
export type SplatBackend =
  | WebGLSplatBackend
  | WebGPUSplatBackend
  | WebGLFallbackSplatBackend;
export declare function createSplatBackend(
  renderer: GaussianSplatCompatibleRenderer,
  uniforms: Uniforms,
  options: SplatMaterialOptions,
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
