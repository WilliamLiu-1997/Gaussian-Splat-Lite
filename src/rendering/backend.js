import * as THREE from "three";
import {
  isWebGPURenderer,
  isXRRenderTarget,
  usesNativeWebGPU,
} from "./rendererUtils.js";
import { WebGLFallbackSplatBackend } from "./webgl-fallback/SplatBackend.js";
import { WebGLSplatBackend } from "./webgl/SplatBackend.js";
import { WebGPUSplatBackend } from "./webgpu/SplatBackend.js";
export function createSplatBackend(
  renderer,
  uniforms,
  options,
  createSurfaces,
) {
  if (!isWebGPURenderer(renderer)) {
    return new WebGLSplatBackend(renderer, uniforms, options);
  }
  return usesNativeWebGPU(renderer)
    ? new WebGPUSplatBackend(renderer, uniforms, options, createSurfaces)
    : new WebGLFallbackSplatBackend(renderer, uniforms, options);
}
export function configureSplatOutput(renderer, target, uniforms, encodeLinear) {
  let blendSpace = THREE.ColorManagement.workingColorSpace;
  if (!isWebGPURenderer(renderer)) {
    if (target === null) blendSpace = renderer.outputColorSpace;
    else if (isXRRenderTarget(target)) blendSpace = target.texture.colorSpace;
  }
  uniforms.encodeLinear.value =
    encodeLinear ?? blendSpace !== THREE.SRGBColorSpace;
}
