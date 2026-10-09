import type * as THREE from "three";
import type { GaussianSplatCompatibleRenderer } from "../rendering/rendererUtils.js";
/** Packed RGBA8, with the bottom row first on every backend. */
export declare function readPixels(
  renderer: GaussianSplatCompatibleRenderer,
  target: THREE.RenderTarget,
  pixels: Uint8Array,
  face?: number,
): Promise<void>;
export declare function downsamplePixels(
  source: Uint8Array,
  width: number,
  height: number,
  superXY: number,
  output: Uint8Array,
): void;
