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

export function usesNativeWebGPU(
  renderer: GaussianSplatCompatibleRenderer,
): renderer is WebGPURenderer & { backend: { isWebGPUBackend: true } } {
  return (
    isWebGPURenderer(renderer) &&
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
  );
}

export function getRenderFrame(renderer: GaussianSplatCompatibleRenderer) {
  return isWebGPURenderer(renderer)
    ? renderer.info.render.calls
    : renderer.info.render.frame;
}

type XRRenderTarget = THREE.RenderTarget & { isXRRenderTarget?: boolean };

export function isXRRenderTarget(
  renderTarget: THREE.RenderTarget | null,
): boolean {
  return (renderTarget as XRRenderTarget | null)?.isXRRenderTarget === true;
}

export function setXRRenderTargetFlag(
  renderTarget: THREE.RenderTarget,
  value: boolean,
) {
  (renderTarget as XRRenderTarget).isXRRenderTarget = value;
}

export function assertSupportedRenderer(
  renderer: GaussianSplatCompatibleRenderer,
) {
  if (!isWebGPURenderer(renderer)) return;
  if (renderer.initialized !== true) {
    throw new Error(
      "Initialize WebGPURenderer with await renderer.init() before using Gaussian Splat Lite",
    );
  }
  const backend = renderer.backend as {
    isWebGPUBackend?: boolean;
    isWebGLBackend?: boolean;
  };
  if (backend.isWebGPUBackend !== true && backend.isWebGLBackend !== true) {
    throw new Error("Gaussian Splat Lite requires a WebGPU or WebGL backend");
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
