import type * as THREE from "three";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
} from "./rendererUtils";
import type { Uniforms } from "./uniforms";
import {
  WebGLSplatBackend,
  configureWebGLSplatOutput,
} from "./webgl/SplatBackend";
import {
  WebGPUSplatBackend,
  configureWebGPUSplatOutput,
} from "./webgpu/SplatBackend";
import type { WebGPUSplatMaterial } from "./webgpu/SplatMaterial";

export type SplatBackend = WebGLSplatBackend | WebGPUSplatBackend;

export function createSplatBackend(
  renderer: GaussianSplatCompatibleRenderer,
  uniforms: Uniforms,
  options: SplatMaterialOptions,
): SplatBackend {
  return isWebGPURenderer(renderer)
    ? new WebGPUSplatBackend(renderer, uniforms, options)
    : new WebGLSplatBackend(renderer, uniforms, options);
}

export function configureSplatOutput(
  renderer: GaussianSplatCompatibleRenderer,
  target: THREE.RenderTarget | null,
  uniforms: Uniforms,
  markerUsers: number,
) {
  if (isWebGPURenderer(renderer)) {
    configureWebGPUSplatOutput(renderer, target, uniforms, markerUsers);
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

export type SplatMaterial = THREE.ShaderMaterial | WebGPUSplatMaterial;

export type SplatMaterialOptions = {
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
  vertexShader?: string;
  fragmentShader?: string;
};
