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
  /** Common and sorting kernels plus the first mono and stereo slots are ready to draw. */
  readonly ready: Promise<void>;
  error: unknown;
  /**
   * Compact storage and refresh existing bindings without compiling or
   * stopping draws. Reads the Splat count once startup slots have compiled.
   */
  shrinkResources(getCount: () => number): Promise<void>;
  /** Requests a redraw when an XR session ends and eye storage can shrink. */
  onViewsReleased?: () => void;
  private readonly limits;
  private readonly cache;
  private readonly visibleCount;
  private readonly keys;
  private readonly seeds;
  private readonly sorter;
  private readonly slotSets;
  private readonly nodes;
  private kernelWork;
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
  private pendingInputs;
  constructor(renderer: WebGPURenderer, uniforms: Uniforms);
  private createSlot;
  /** Projection uniforms of the precompiled eyes after the first. */
  private ensureEyeUniforms;
  private createSlotSet;
  /** Warm the remaining slots at startup, yielding between each compilation. */
  private compileSlots;
  /** The selected, precompiled mode for mono or WebXR stereo. */
  private getSlots;
  private compact;
  vertexData(camera: THREE.Camera, stochastic: boolean): ProjectedVertexData;
  private resizeBuffer;
  private resize;
  render(
    accumulator: SplatAccumulator,
    camera: THREE.Camera,
    geometry: SplatGeometry,
    radial: boolean,
    fastSort: boolean,
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
