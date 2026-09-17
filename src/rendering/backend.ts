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
  if (options.vertexShader || options.fragmentShader) {
    throw new Error("Custom GLSL shaders are only supported by WebGLRenderer");
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
  let xrOutput: boolean;
  let blendSpace = THREE.ColorManagement.workingColorSpace;
  if (isWebGPURenderer(renderer)) {
    xrOutput =
      target === renderer.getOutputRenderTarget() ||
      (
        target as
          | (THREE.RenderTarget & { isPostProcessingRenderTarget?: boolean })
          | null
      )?.isPostProcessingRenderTarget === true;
  } else {
    const xrTarget = isXRRenderTarget(target);
    // A compose target may carry the XR flag for output-space blending only.
    xrOutput = xrTarget && renderer.xr.enabled;
    if (target === null) blendSpace = renderer.outputColorSpace;
    else if (xrTarget) blendSpace = target.texture.colorSpace;
  }
  // Alpha-2 markers must not escape through Three's XR output intermediate.
  uniforms.stochasticResolve.value =
    markerUsers > 0 &&
    (!renderer.xr.isPresenting ||
      (!xrOutput &&
        (target?.texture.type === THREE.HalfFloatType ||
          target?.texture.type === THREE.FloatType)));
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
  vertexShader?: string;
  fragmentShader?: string;
};
