import type * as THREE from "three";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
  usesNativeWebGPU,
} from "./rendererUtils";
import { configureNodeSplatOutput } from "./tsl/SplatBackend";
import type { SplatNodeMaterial } from "./tsl/SplatMaterial";
import type { Uniforms } from "./uniforms";
import { WebGLFallbackSplatBackend } from "./webgl-fallback/SplatBackend";
import {
  WebGLSplatBackend,
  configureWebGLSplatOutput,
} from "./webgl/SplatBackend";
import { WebGPUSplatBackend } from "./webgpu/SplatBackend";

export type SplatBackend =
  | WebGLSplatBackend
  | WebGPUSplatBackend
  | WebGLFallbackSplatBackend;

export function createSplatBackend(
  renderer: GaussianSplatCompatibleRenderer,
  uniforms: Uniforms,
  options: SplatMaterialOptions,
): SplatBackend {
  if (!isWebGPURenderer(renderer)) {
    return new WebGLSplatBackend(renderer, uniforms, options);
  }
  return usesNativeWebGPU(renderer)
    ? new WebGPUSplatBackend(renderer, uniforms, options)
    : new WebGLFallbackSplatBackend(renderer, uniforms, options);
}

export function configureSplatOutput(
  renderer: GaussianSplatCompatibleRenderer,
  target: THREE.RenderTarget | null,
  uniforms: Uniforms,
  markerUsers: number,
) {
  if (isWebGPURenderer(renderer)) {
    configureNodeSplatOutput(renderer, target, uniforms, markerUsers);
  } else {
    configureWebGLSplatOutput(renderer, target, uniforms, markerUsers);
  }
}

export type CPUOrderingUpdate = {
  ordering: Uint32Array;
  activeSplats: number;
  capacity: number;
  requiredCapacity: number;
  shrink: boolean;
};

export type SplatMaterial = THREE.ShaderMaterial | SplatNodeMaterial;

export type SplatMaterialOptions = {
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
  vertexShader?: string;
  fragmentShader?: string;
};
