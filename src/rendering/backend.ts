import * as THREE from "three";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
  isXRRenderTarget,
  usesNativeWebGPU,
} from "./rendererUtils";
import type { SplatNodeMaterial } from "./tsl/SplatMaterial";
import type { Uniforms } from "./uniforms";
import { WebGLFallbackSplatBackend } from "./webgl-fallback/SplatBackend";
import { WebGLSplatBackend } from "./webgl/SplatBackend";
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
) {
  let blendSpace = THREE.ColorManagement.workingColorSpace;
  if (!isWebGPURenderer(renderer)) {
    // WebGL blends canvas output, and compose targets carrying the XR flag,
    // in their encoded output space.
    if (target === null) blendSpace = renderer.outputColorSpace;
    else if (isXRRenderTarget(target)) blendSpace = target.texture.colorSpace;
  }
  uniforms.encodeLinear.value = blendSpace !== THREE.SRGBColorSpace;
}

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
