import type { WebGLRenderer } from "three";
import type { WebGPURenderer } from "three/webgpu";
/** Apply r186 compatibility fixes to an initialized renderer once. */
export declare function applyThreeR186Patch(
  renderer: WebGLRenderer | WebGPURenderer,
): void;
