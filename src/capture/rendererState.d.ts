import type { GaussianSplatCompatibleRenderer } from "../rendering/rendererUtils.js";
/** Wrap synchronous drawing only; output state must never survive an await. */
export declare function withCaptureState<T>(
  renderer: GaussianSplatCompatibleRenderer,
  draw: () => T,
): T;
