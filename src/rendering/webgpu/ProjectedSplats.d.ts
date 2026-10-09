import type * as THREE from "three";
import type {
  IndirectStorageBufferAttribute,
  WebGPURenderer,
} from "three/webgpu";
import type { SplatAccumulator } from "../SplatAccumulator.js";
import type { SplatGeometry } from "../SplatGeometry.js";
import type { ProjectedVertexData } from "../tsl/SplatMaterial.js";
import type { Uniforms } from "../uniforms.js";
/** Fixed compute graph. Source mappings and storage may change without rebuilding shaders. */
export declare class ProjectedSplats {
  private readonly renderer;
  private readonly uniforms;
  readonly indirect: IndirectStorageBufferAttribute;
  /** Common kernels, the full sorter and the first slot are ready; remaining slots warm automatically. */
  readonly ready: Promise<void>;
  error: unknown;
  /**
   * Called when kernels for a new WebXR eye count can draw, or when a slot
   * fails to compile. Draws hide Splats until then, so on-demand hosts must
   * redraw.
   */
  onKernelsReady?: () => void;
  private readonly limits;
  private readonly cache;
  private readonly visibleCount;
  private readonly keys;
  private readonly seeds;
  private readonly sorter;
  private readonly slotSets;
  private readonly compilations;
  private readonly onSessionStart;
  private shrinkViews;
  private readonly onSessionEnd;
  private readonly resetCount;
  private readonly finish;
  private readonly state;
  private readonly matrix;
  private readonly translation;
  private readonly scale;
  private readonly viewPosition;
  private capacity;
  private viewCapacity;
  private disposed;
  private projectedInputs;
  constructor(renderer: WebGPURenderer, uniforms: Uniforms);
  private createSlot;
  /** Projection uniforms of each eye after the first, created on demand. */
  private ensureEyeUniforms;
  private createSlotSet;
  /**
   * Compiled slots that project this many eyes. One eye uses the startup
   * slots; WebXR eye counts build theirs on first request.
   */
  private getSlots;
  private compileSlots;
  vertexData(camera: THREE.Camera, stochastic: boolean): ProjectedVertexData;
  private resizeBuffer;
  private resize;
  render(
    accumulator: SplatAccumulator,
    camera: THREE.Camera,
    geometry: SplatGeometry,
    radial: boolean,
    fastSort: boolean,
    shrink?: boolean,
  ): boolean;
  /** Projection uniforms for one eye; eye 0 also serves mono draws. */
  private setEye;
  /** Sort from the views' mean pose: the camera, or the WebXR head. */
  private setSortPose;
  /**
   * Generates, projects, compacts and sorts the meshes any view draws. Sorted
   * modes also visit hidden meshes, which only mark their keys absent.
   */
  private dispatch;
  dispose(): void;
  private disposeResources;
}
