import { isWebGPURenderer } from "../rendering/rendererUtils.js";
/** Wrap synchronous drawing only; output state must never survive an await. */
export function withCaptureState(renderer, draw) {
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
    renderer.setRenderTarget(target, cubeFace, mipmapLevel);
  }
}
