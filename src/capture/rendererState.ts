import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
  setRendererRenderTarget,
} from "../rendering/rendererUtils";

/** Wrap synchronous drawing only; output state must never survive an await. */
export function withCaptureState<T>(
  renderer: GaussianSplatCompatibleRenderer,
  draw: () => T,
): T {
  const target = renderer.getRenderTarget();
  const cubeFace = renderer.getActiveCubeFace();
  const mipmapLevel = renderer.getActiveMipmapLevel();
  const xrEnabled = renderer.xr.enabled;
  const autoClear = renderer.autoClear;
  const nodeRenderer = isWebGPURenderer(renderer) ? renderer : null;
  const mrt = nodeRenderer?.getMRT() ?? null;

  renderer.xr.enabled = false;
  renderer.autoClear = true;
  nodeRenderer?.setMRT(null);
  try {
    return draw();
  } finally {
    renderer.xr.enabled = xrEnabled;
    renderer.autoClear = autoClear;
    nodeRenderer?.setMRT(mrt);
    setRendererRenderTarget(renderer, target, cubeFace, mipmapLevel);
  }
}
