import type * as THREE from "three";

type WebGPURenderer = import("three/webgpu").WebGPURenderer;

export type GaussianSplatCompatibleRenderer =
  | THREE.WebGLRenderer
  | WebGPURenderer;

export function isWebGPURenderer(
  renderer: GaussianSplatCompatibleRenderer,
): renderer is WebGPURenderer {
  return "isWebGPURenderer" in renderer && renderer.isWebGPURenderer === true;
}

export function assertSupportedRenderer(
  renderer: GaussianSplatCompatibleRenderer,
) {
  const backend = isWebGPURenderer(renderer)
    ? (renderer.backend as { isWebGPUBackend?: boolean } | undefined)
    : undefined;
  if (
    isWebGPURenderer(renderer) &&
    (renderer.initialized !== true || backend?.isWebGPUBackend !== true)
  ) {
    throw new Error(
      "Gaussian Splat Lite requires an initialized WebGPURenderer using the native WebGPU backend",
    );
  }
}

export function setRendererRenderTarget(
  renderer: GaussianSplatCompatibleRenderer,
  target: THREE.RenderTarget | null,
  activeCubeFace?: number,
  activeMipmapLevel?: number,
) {
  if (isWebGPURenderer(renderer)) {
    renderer.setRenderTarget(target, activeCubeFace, activeMipmapLevel);
  } else {
    renderer.setRenderTarget(
      target as THREE.WebGLRenderTarget | null,
      activeCubeFace,
      activeMipmapLevel,
    );
  }
}
