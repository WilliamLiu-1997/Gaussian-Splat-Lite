import * as THREE from "three";
import type { SplatWorker } from "../runtime/SplatWorker.js";
import type { SplatAccumulator } from "./SplatAccumulator.js";
import type { SplatGeometry } from "./SplatGeometry.js";
import type { SplatMaterial } from "./backend.js";
import type { GaussianSplatCompatibleRenderer } from "./rendererUtils.js";
export interface GaussianSplatRendererOptions {
  /**
   * Pass in a THREE.WebGLRenderer or an initialized THREE.WebGPURenderer so
   * Gaussian Splat Lite can perform work outside the usual render loop. Both
   * native WebGPU and the WebGL2 fallback are supported. The renderer
   * should be created with antialias: false (the default) because MSAA does not
   * improve Gaussian Splatting and significantly reduces performance.
   */
  renderer: GaussianSplatCompatibleRenderer;
  /**
   * Callback function to be called when GaussianSplatRenderer needs to re-render,
   * for example when a splat sort completes.
   */
  onDirty?: () => void;
  /**
   * Whether to use premultiplied alpha when accumulating splat RGB
   * @default true
   */
  premultipliedAlpha?: boolean;
  /**
   * Decode stored sRGB Splat colors to linear before blending. When omitted,
   * conversion follows the active blend space automatically.
   * @default undefined
   */
  encodeLinear?: boolean;
  /**
   * Pass in a THREE.Timer to synchronize time-based effects across different
   * systems. A supplied timer remains owned and updated by the caller.
   * @default new THREE.Timer()
   */
  timer?: THREE.Timer;
  /**
   * Controls whether to check and automatically update Gsplat collection
   * each frame render.
   * @default true
   */
  autoUpdate?: boolean;
  /**
   * Controls whether to update the Gsplats before or after rendering. For WebXR
   * this is set to false in order to complete rendering as soon as possible.
   * @default true (if not WebXR)
   */
  preUpdate?: boolean;
  /**
   * Maximum standard deviations from the center to render Gaussians. Values
   * Math.sqrt(4)..Math.sqrt(9) produce acceptable results and can be tweaked for
   * performance. A Gaussian still above minAlpha at this distance fades to
   * minAlpha there instead of ending in a step.
   * @default Math.sqrt(8)
   */
  maxStdDev?: number;
  /**
   * Minimum screen-pixel radius for splat rendering, independent of the
   * internal projection scale used by focalAdjustment.
   * @default 1.0
   */
  minPixelRadius?: number;
  /**
   * Minimum alpha value for splat rendering.
   * @default 0.5 / 255
   */
  minAlpha?: number;
  /**
   * Scalar value to add to 2D splat covariance diagonal, effectively blurring +
   * enlarging splats. In scenes trained without the Gsplat anti-aliasing tweak
   * this value was typically 0.3, but with anti-aliasing it is 0.0
   * @default 0.3
   */
  preBlurAmount?: number;
  /**
   * Scalar value to add to the projected 2D splat covariance diagonal, with
   * opacity adjustment for anti-aliasing. Set to 0.3 with preBlurAmount = 0
   * to enable compensated blur. Its screen-space scale depends on focalAdjustment.
   * @default 0.0
   */
  blurAmount?: number;
  /**
   * X/Y clipping boundary factor for Gsplat centers against view frustum.
   * 1.0 clips any centers that are exactly out of bounds, while 1.25 clips
   * centers that are 25% beyond the bounds.
   * @default 1.25
   */
  clipXY?: number;
  /**
   * Parameter to adjust projected splat scale calculation to match other renderers,
   * similar to the same parameter in the MKellogg 3DGS renderer. Higher values will
   * tend to sharpen the splats. A value 2.0 can be used to match the behavior of
   * the PlayCanvas renderer.
   * @default 2.0
   */
  focalAdjustment?: number;
  /**
   * Whether to sort splats radially (geometric distance) from the viewpoint (true)
   * or by Z-depth (false). Most scenes are trained with the Z-depth sort metric
   * and will render more accurately at certain viewpoints. However, radial sorting
   * is more stable under viewpoint rotations.
   * @default false
   */
  sortRadial?: boolean;
  /**
   * Lower-precision sorting for faster sorted rendering.
   * Has no effect on stochastic rendering.
   * @default true
   */
  fastSort?: boolean;
  /**
   * Minimum interval between WebGL sort calls in milliseconds. Native WebGPU
   * projects and sorts each draw without CPU throttling.
   * @default 0
   */
  minSortIntervalMs?: number;
  /**
   * Enables stochastic transparency. Also applies to WebXR.
   * @default false
   */
  stochastic?: boolean;
  /**
   * Increment stochasticSample once per scene render while stochastic
   * coverage is active, including WebXR. All views in that render share the
   * same sample.
   * @default true
   */
  autoAdvanceStochasticSample?: boolean;
  /**
   * 16-bit front-to-back ordering for stochastic frames.
   * WebXR eyes share one order based on their mean position and direction.
   * WebGL and WebGL fallback sort asynchronously; native WebGPU sorts on the GPU.
   * Disable to draw in source/compacted order.
   * @default true
   */
  stochasticSort?: boolean;
  /**
   * Set the splat shader material to be transparent which determines if the
   * splats are rendered during the first opaque THREE.js render pass or the
   * second transparent render pass. Stochastic rendering keeps the
   * material in the opaque list, with depth testing and writing enabled.
   * @default undefined = true
   */
  transparent?: boolean;
  /**
   * Set the splat shader material to enable depth testing which determines if the
   * splats respect the Z depth buffer and blend with other opaque objects in the scene.
   * @default undefined = true
   */
  depthTest?: boolean;
  /**
   * Set the splat shader material to enable depth writing which determines if the
   * splats write to the Z depth buffer. Note that enabling this may produce
   * undesirable results because most of the Gsplat is transparent.
   * @default undefined = false
   */
  depthWrite?: boolean;
}
export declare class GaussianSplatRenderer extends THREE.Mesh<
  SplatGeometry,
  SplatMaterial
> {
  readonly renderer: GaussianSplatCompatibleRenderer;
  readonly uniforms: ReturnType<typeof GaussianSplatRenderer.makeUniforms>;
  autoUpdate: boolean;
  preUpdate: boolean;
  /** @internal False for a second renderer on the same scene, so each `onFrame` runs once per frame. */
  frameCallbacks: boolean;
  renderSize: THREE.Vector2;
  maxStdDev: number;
  minPixelRadius: number;
  minAlpha: number;
  preBlurAmount: number;
  blurAmount: number;
  clipXY: number;
  focalAdjustment: number;
  sortRadial: boolean;
  private _fastSort;
  minSortIntervalMs: number;
  /**
   * Noise pattern index, wrapped to uint32. Each value selects an independent
   * pattern. Disable autoAdvanceStochasticSample for manual control.
   */
  stochasticSample: number;
  autoAdvanceStochasticSample: boolean;
  private _stochastic;
  private stochasticFrame;
  private _stochasticSort;
  private _premultipliedAlpha;
  private _encodeLinear;
  private _transparent;
  private readonly sortedBlending;
  private _depthTest;
  private _depthWrite;
  readonly timer: THREE.Timer;
  private readonly ownsTimer;
  lastFrame: number;
  updateTimeoutId: number;
  onDirty?: () => void;
  dirty: boolean;
  private readonly backend;
  private readonly materialState;
  private orderingBuffer;
  private orderingReady;
  private readonly headCamera;
  maxSplats: number;
  activeSplats: number;
  display: SplatAccumulator;
  current: SplatAccumulator;
  accumulators: SplatAccumulator[];
  sorting: boolean;
  sortDirty: boolean;
  lastSortTime: number;
  sortWorker: SplatWorker | null;
  sortedCenter: THREE.Vector3;
  sortedDir: THREE.Vector3;
  private sortedRadial;
  private sortedFastSort;
  private sortedMode;
  private sortCenterCache;
  private sortStateRevision;
  private uploadedSortStateRevision;
  private updateRunning;
  private updatePromise;
  private queuedUpdate;
  private disposed;
  private unsupportedCameraReported;
  constructor(options: GaussianSplatRendererOptions);
  raycast(_raycaster: THREE.Raycaster, _intersects: THREE.Intersection[]): void;
  static makeUniforms(): {
    renderSize: {
      value: THREE.Vector2;
    };
    viewportOrigin: {
      value: THREE.Vector2;
    };
    renderOrigin: {
      value: THREE.Vector3;
    };
    near: {
      value: number;
    };
    far: {
      value: number;
    };
    renderToViewQuat: {
      value: THREE.Quaternion;
    };
    renderToViewPos: {
      value: THREE.Vector3;
    };
    renderToViewScale: {
      value: number;
    };
    maxStdDev: {
      value: number;
    };
    minPixelRadius: {
      value: number;
    };
    minAlpha: {
      value: number;
    };
    edgeFade: {
      value: THREE.Vector2;
    };
    preBlurAmount: {
      value: number;
    };
    blurAmount: {
      value: number;
    };
    clipXY: {
      value: number;
    };
    focalAdjustment: {
      value: number;
    };
    encodeLinear: {
      value: boolean;
    };
    splatCount: {
      value: number;
    };
    ordering: {
      type: string;
      value: THREE.DataTexture;
    };
    splats: {
      type: string;
      value: THREE.Texture<unknown, THREE.TextureEventMap>;
    };
    splats2: {
      type: string;
      value: THREE.Texture<unknown, THREE.TextureEventMap>;
    };
    stochasticSeeds: {
      type: string;
      value: THREE.Texture<unknown, THREE.TextureEventMap>;
    };
    stochasticNoise: {
      value: THREE.DataTexture;
    };
    stochasticSample: {
      value: number;
    };
    stochastic: {
      value: boolean;
    };
    stochasticOrdering: {
      value: boolean;
    };
  };
  dispose(): void;
  /** Native WebGPU sorts on the GPU before drawing; WebGL sorts in a worker. */
  get synchronousSort(): boolean;
  setDirty(): void;
  private resetSortWorker;
  /**
   * Frees the worker, its sort state and the ordering, which unsorted draws
   * never read. Re-enabling sorting reallocates them and uploads centers.
   */
  private releaseOrdering;
  private takeAccumulator;
  private releaseAccumulator;
  private disposeOversizedAccumulators;
  /**
   * Draw stochastically exactly while the displayed accumulator was generated
   * for it: only stochastic accumulators carry sampling seeds, and only
   * sorted ones a back-to-front order. WebGL backends therefore switch modes
   * once an update for the new mode is displayed. Native WebGPU switches at
   * the update boundary too, keeping mode changes outside an active draw.
   */
  private syncStochasticFrame;
  private selectMaterial;
  private applyMaterialState;
  private reportedRenderError;
  private runAutomaticUpdate;
  private readonly viewportSize;
  private reportRenderError;
  onBeforeRender(
    renderer: GaussianSplatCompatibleRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ): void;
  private prepareDraw;
  clearSplats(): void;
  update({
    scene,
    camera,
    excludedObjects,
  }: {
    scene: THREE.Scene;
    camera: THREE.Camera;
    /** @internal Models excluded during capture preparation, including descendants. */
    excludedObjects?: ReadonlySet<THREE.Object3D>;
  }): Promise<void>;
  /** Updates the scene and compacts work and edit storage while retaining compiled kernels. */
  shrinkResources({
    scene,
    camera,
  }: {
    scene: THREE.Scene;
    camera: THREE.Camera;
  }): Promise<void>;
  private updateInternal;
  private drainUpdates;
  private performUpdate;
  /**
   * Viewpoint for generation, spherical harmonics, the render origin and
   * sorting: the camera, or for WebXR eyes their mean pose, the shared head.
   */
  private getGenerationCamera;
  private driveSort;
  /** Decode sRGB before blending; undefined follows the active blend space. */
  get encodeLinear(): boolean | undefined;
  set encodeLinear(value: boolean | undefined);
  get premultipliedAlpha(): boolean;
  set premultipliedAlpha(value: boolean);
  get transparent(): boolean;
  set transparent(value: boolean);
  get fastSort(): boolean;
  set fastSort(value: boolean);
  get stochasticSort(): boolean;
  set stochasticSort(value: boolean);
  get stochastic(): boolean;
  /**
   * Whether Splats currently draw stochastically. It follows `stochastic`
   * once an update for the new mode is displayed.
   */
  get stochasticActive(): boolean;
  set stochastic(value: boolean);
  get depthTest(): boolean;
  set depthTest(value: boolean);
  get depthWrite(): boolean;
  set depthWrite(value: boolean);
}
