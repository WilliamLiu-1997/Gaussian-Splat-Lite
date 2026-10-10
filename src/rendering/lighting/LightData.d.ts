import type * as THREE from "three";
import type {
  StorageBufferNode,
  UniformNode,
  WebGPURenderer,
} from "three/webgpu";
import type { SceneLights } from "./SceneLights.js";

/**
 * Records per row of the light texture. Every WebGL2 device supports this
 * width, so shaders address a record without reading the texture's size.
 */
export declare const LIGHT_TEXTURE_WIDTH = 2048;
/** Shared light storage; resizing never changes the draw's shader interface. */
export declare class LightData {
  private readonly lights;
  private views;
  private records;
  private readonly limit;
  readonly stride: UniformNode<"uint", number>;
  readonly buffer: StorageBufferNode<"vec4"> | null;
  readonly texture: THREE.DataTexture | null;
  constructor(
    lights: SceneLights,
    renderer: THREE.WebGLRenderer | WebGPURenderer,
  );
  /** Fill active views, retaining storage until explicit shrinking. */
  update(views: readonly THREE.Camera[], shrink?: boolean): void;
  dispose(): void;
}
