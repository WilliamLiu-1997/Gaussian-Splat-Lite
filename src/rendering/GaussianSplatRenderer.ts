import * as THREE from "three";
import { SplatWorker } from "../runtime/SplatWorker";
import { resolveTimer } from "../utils/three";
import { SortCenterCache } from "./SortCenterCache";
import { SplatAccumulator } from "./SplatAccumulator";
import { SplatGeometry } from "./SplatGeometry";
import {
  type SplatBackend,
  type SplatMaterial,
  configureSplatOutput,
  createSplatBackend,
} from "./backend";
import {
  type GaussianSplatCompatibleRenderer,
  assertSupportedRenderer,
  getMeanViewPose,
  getRenderFrame,
  getViews,
} from "./rendererUtils";
import { DEFAULT_MIN_ALPHA, makeSplatUniforms } from "./uniforms";

const renderToViewScaleTmp = new THREE.Vector3();
const renderToViewMatrixTmp = new THREE.Matrix4();
const renderTranslationTmp = new THREE.Matrix4();
const headPositionTmp = new THREE.Vector3();
const headTargetTmp = new THREE.Vector3();
type UpdateRequest = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  shrinkResources: boolean;
};

// Back-to-front for blending, front-to-back for stochastic overdraw, or
// source order for unsorted stochastic draws.
type SortMode = "back" | "front" | "identity";

const UNSUPPORTED_CAMERA =
  "GaussianSplatRenderer draws ArrayCamera only for WebXR; render other views with separate cameras";

/**
 * Whether the camera is the WebXR camera or one of its eyes. Presenting alone
 * is not enough: Three draws render targets with the caller's camera when
 * xr.enabled is off, and WebGPURenderer whenever the target is not its output.
 */
function isXRCamera(
  camera: THREE.Camera,
  renderer: GaussianSplatCompatibleRenderer,
) {
  if (!renderer.xr.isPresenting) return false;
  const xrCamera = renderer.xr.getCamera();
  return (
    camera === xrCamera || (xrCamera.cameras as THREE.Camera[]).includes(camera)
  );
}

/**
 * Multiple views are drawn only as WebXR eyes. Classic WebGL draws each view
 * of an ArrayCamera separately, as a camera with a viewport.
 */
function isSupportedCamera(
  camera: THREE.Camera,
  renderer: GaussianSplatCompatibleRenderer,
) {
  return (
    isXRCamera(camera, renderer) ||
    (!(camera as THREE.ArrayCamera).isArrayCamera &&
      (camera as THREE.PerspectiveCamera).viewport === undefined)
  );
}

function assertSupportedCamera(
  camera: THREE.Camera,
  renderer: GaussianSplatCompatibleRenderer,
) {
  if (!isSupportedCamera(camera, renderer)) throw new Error(UNSUPPORTED_CAMERA);
}

// Average (uniform) world scale of a camera, read without updating it.
function getCameraWorldScale(camera: THREE.Camera): number {
  const scale = renderToViewScaleTmp.setFromMatrixScale(camera.matrixWorld);
  return (scale.x + scale.y + scale.z) / 3;
}

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

export class GaussianSplatRenderer extends THREE.Mesh<
  SplatGeometry,
  SplatMaterial
> {
  readonly renderer: GaussianSplatCompatibleRenderer;
  readonly uniforms: ReturnType<typeof GaussianSplatRenderer.makeUniforms>;

  autoUpdate: boolean;
  preUpdate: boolean;
  /** @internal False for a second renderer on the same scene, so each `onFrame` runs once per frame. */
  frameCallbacks = true;

  renderSize = new THREE.Vector2();
  maxStdDev: number;
  minPixelRadius: number;
  minAlpha: number;
  preBlurAmount: number;
  blurAmount: number;
  clipXY: number;
  focalAdjustment: number;
  sortRadial: boolean;
  private _fastSort: boolean;
  minSortIntervalMs: number;
  /**
   * Noise pattern index, wrapped to uint32. Each value selects an independent
   * pattern. Disable autoAdvanceStochasticSample for manual control.
   */
  stochasticSample = 0;
  autoAdvanceStochasticSample: boolean;
  private _stochastic: boolean;
  private stochasticFrame: boolean;
  private _stochasticSort: boolean;
  private _premultipliedAlpha: boolean;
  private _encodeLinear: boolean | undefined;
  private _transparent: boolean;
  private readonly sortedBlending: THREE.Blending;
  private _depthTest: boolean;
  private _depthWrite: boolean;

  readonly timer: THREE.Timer;
  private readonly ownsTimer: boolean;
  lastFrame = -1;
  updateTimeoutId = -1;
  onDirty?: () => void;
  dirty: boolean;

  private readonly backend: SplatBackend;
  private orderingBuffer: Uint32Array = new Uint32Array(0);
  // A CPU ordering matching the displayed accumulator; unsorted stochastic
  // updates display without one.
  private orderingReady = false;
  // Mean pose of the WebXR eyes; see getGenerationCamera().
  private readonly headCamera = new THREE.PerspectiveCamera();
  maxSplats = 0;
  activeSplats = 0;

  display: SplatAccumulator;
  current: SplatAccumulator;
  accumulators: SplatAccumulator[] = [];

  sorting = false;
  sortDirty = false;
  lastSortTime = 0;
  sortWorker: SplatWorker | null = null;
  sortedCenter = new THREE.Vector3().setScalar(Number.NEGATIVE_INFINITY);
  sortedDir = new THREE.Vector3().setScalar(0);
  private sortedRadial: boolean | undefined;
  private sortedFastSort: boolean | undefined;
  private sortedMode: SortMode | undefined;
  private sortCenterCache = new SortCenterCache();
  private sortStateRevision = 0;
  private uploadedSortStateRevision = -1;
  private updateRunning = false;
  private updatePromise: Promise<void> = Promise.resolve();
  private queuedUpdate: UpdateRequest | null = null;
  private disposed = false;
  private pendingProjectionShrink = false;
  private unsupportedCameraReported = false;

  constructor(options: GaussianSplatRendererOptions) {
    if (!options?.renderer) {
      throw new Error("renderer is required in GaussianSplatRenderer options");
    }
    assertSupportedRenderer(options.renderer);

    const uniforms = GaussianSplatRenderer.makeUniforms();

    const premultipliedAlpha = options.premultipliedAlpha ?? true;
    const stochastic = options.stochastic ?? false;
    const backend = createSplatBackend(options.renderer, uniforms, {
      premultipliedAlpha,
      transparent: options.transparent ?? true,
      depthTest: options.depthTest ?? true,
      depthWrite: options.depthWrite ?? false,
    });
    const geometry = new SplatGeometry();
    const material = backend.selectMaterial(stochastic);

    super(geometry, material);
    this.renderer = options.renderer;
    this.backend = backend;
    this.uniforms = uniforms;
    this.sortedBlending = material.blending;
    this._depthTest = options.depthTest ?? true;
    this._depthWrite = options.depthWrite ?? false;
    this._premultipliedAlpha = premultipliedAlpha;
    this._encodeLinear = options.encodeLinear;
    this._transparent = options.transparent ?? true;
    this._stochastic = stochastic;
    this.autoAdvanceStochasticSample =
      options.autoAdvanceStochasticSample ?? true;
    this._stochasticSort = options.stochasticSort ?? true;
    this.stochasticFrame = stochastic;
    this.applyMaterialState(this.stochasticFrame);
    // Disable frustum culling because we want to always draw them all
    // and cull Gsplats individually in the shader
    this.frustumCulled = false;

    // By default GaussianSplatRenderer will only render for layer 0
    // this.layers.enableAll();

    // gaussianSplatRendererInstance = this;
    this.onDirty = options.onDirty;
    this.dirty = true;
    this.autoUpdate = options.autoUpdate ?? true;
    this.preUpdate = options.preUpdate ?? true;

    this.maxStdDev = options.maxStdDev ?? Math.sqrt(8.0);
    this.minPixelRadius = options.minPixelRadius ?? 1.0;
    this.minAlpha = options.minAlpha ?? DEFAULT_MIN_ALPHA;
    this.preBlurAmount = options.preBlurAmount ?? 0.3;
    this.blurAmount = options.blurAmount ?? 0.0;
    this.clipXY = options.clipXY ?? 1.25;
    this.focalAdjustment = options.focalAdjustment ?? 2.0;
    this.sortRadial = options.sortRadial ?? false;
    this._fastSort = options.fastSort ?? true;
    this.minSortIntervalMs = options.minSortIntervalMs ?? 0;

    const { timer, ownsTimer } = resolveTimer(options.timer);
    this.timer = timer;
    this.ownsTimer = ownsTimer;

    this.display = new SplatAccumulator();
    this.current = this.display;
    if (backend.kind !== "webgpu") {
      this.accumulators.push(new SplatAccumulator());
    }

    if (backend.kind === "webgpu") {
      backend.precompile?.then(() => {
        if (!this.disposed) this.setDirty();
      });
      // WebXR eye kernels compile on first use or session start; draws hide
      // Splats until they are ready, so request a redraw.
      backend.projection.onKernelsReady = () => {
        if (!this.disposed) this.setDirty();
      };
    }
  }

  raycast(_raycaster: THREE.Raycaster, _intersects: THREE.Intersection[]) {}

  static makeUniforms() {
    return makeSplatUniforms();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queuedUpdate = null;
    clearTimeout(this.updateTimeoutId);
    this.updateTimeoutId = -1;

    super.dispose();

    this.backend.dispose();
    this.uniforms.stochasticNoise.value.dispose();

    const accumulators = new Set<SplatAccumulator>();
    accumulators.add(this.display);
    accumulators.add(this.current);
    for (const accumulator of this.accumulators) {
      accumulators.add(accumulator);
    }
    for (const accumulator of accumulators) {
      accumulator.dispose();
    }
    this.accumulators.length = 0;

    this.resetSortWorker();
    this.orderingBuffer = new Uint32Array(0);
    this.orderingReady = false;
    this.maxSplats = 0;
    this.activeSplats = 0;

    this.geometry.dispose();
  }

  /** Native WebGPU sorts on the GPU before drawing; WebGL sorts in a worker. */
  get synchronousSort() {
    return this.backend.kind === "webgpu";
  }

  setDirty() {
    if (!this.dirty) {
      this.dirty = true;
      this.onDirty?.();
    }
  }

  private resetSortWorker() {
    this.sortWorker?.dispose();
    this.sortWorker = null;
    this.sortCenterCache.dispose();
    this.uploadedSortStateRevision = -1;
  }

  /**
   * Frees the worker, its sort state and the ordering, which unsorted draws
   * never read. Re-enabling sorting reallocates them and uploads centers.
   */
  private releaseOrdering() {
    this.resetSortWorker();
    if (this.backend.kind !== "webgpu") this.backend.releaseOrdering();
    this.orderingBuffer = new Uint32Array(0);
    this.maxSplats = 0;
  }

  private takeAccumulator() {
    return this.accumulators.pop() ?? new SplatAccumulator();
  }

  private releaseAccumulator(accumulator: SplatAccumulator) {
    this.accumulators.push(accumulator);
  }

  private disposeOversizedAccumulators(maxSplats: number) {
    for (const accumulator of this.accumulators) {
      if (accumulator.maxSplats > maxSplats) accumulator.dispose();
    }
  }

  /**
   * Draw stochastically exactly while the displayed accumulator was generated
   * for it: only stochastic accumulators carry sampling seeds, and only
   * sorted ones a back-to-front order. WebGL backends therefore switch modes
   * once an update for the new mode is displayed. Native WebGPU switches at
   * the update boundary too, keeping mode changes outside an active draw.
   */
  private syncStochasticFrame() {
    const active =
      this.backend.kind === "webgpu" || this.display.numSplats === 0
        ? this._stochastic
        : this.display.hasStochasticSeeds;
    if (active === this.stochasticFrame) return;
    this.stochasticFrame = active;
    this.material = this.backend.selectMaterial(active);
    this.applyMaterialState(active);
    this.setDirty();
  }

  private applyMaterialState(stochasticActive: boolean) {
    const { material } = this;
    const wasOpaque = isOpaqueMaterial(material);
    material.transparent = stochasticActive ? false : this._transparent;
    material.blending = stochasticActive
      ? THREE.NoBlending
      : this.sortedBlending;
    material.depthTest = stochasticActive ? true : this._depthTest;
    material.depthWrite = stochasticActive ? true : this._depthWrite;
    if (
      material.premultipliedAlpha !== this._premultipliedAlpha ||
      wasOpaque !== isOpaqueMaterial(material)
    ) {
      material.premultipliedAlpha = this._premultipliedAlpha;
      material.needsUpdate = true;
    }
  }

  private reportedRenderError = "";
  private runAutomaticUpdate(request: UpdateRequest) {
    try {
      void this.updateInternal(request).catch((error) =>
        this.reportRenderError(error),
      );
    } catch (error) {
      this.reportRenderError(error);
    }
  }
  private readonly viewportSize = new THREE.Vector4();

  private reportRenderError(error: unknown) {
    const message = String(error);
    if (message !== this.reportedRenderError) {
      this.reportedRenderError = message;
      console.error("Gaussian Splat render failed", error);
    }
  }

  onBeforeRender(
    renderer: GaussianSplatCompatibleRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    try {
      this.prepareDraw(renderer, scene, camera);
    } catch (error) {
      this.reportRenderError(error);
      this.geometry.setIndirect(null);
      this.geometry.instanceCount = 0;
    } finally {
      // Generation can render nested quads, advancing Three's render counter.
      this.lastFrame = getRenderFrame(renderer);
    }
  }

  private prepareDraw(
    renderer: GaussianSplatCompatibleRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    if (!isSupportedCamera(camera, renderer)) {
      // Throwing here would leave Three.js mid-render; skip this draw instead.
      if (!this.unsupportedCameraReported) {
        this.unsupportedCameraReported = true;
        console.error(UNSUPPORTED_CAMERA);
      }
      this.geometry.setIndirect(null);
      this.geometry.instanceCount = 0;
      return;
    }
    const frame = getRenderFrame(renderer);
    const isNewFrame = frame !== this.lastFrame;
    this.lastFrame = frame;
    if (isNewFrame) {
      if (this.autoAdvanceStochasticSample && this.stochasticFrame) {
        this.stochasticSample = (this.stochasticSample + 1) >>> 0;
      }
    }

    const currentRenderTarget = renderer.getRenderTarget();
    if (currentRenderTarget) {
      this.renderSize.set(
        currentRenderTarget.viewport.z,
        currentRenderTarget.viewport.w,
      );
    } else {
      renderer.getViewport(this.viewportSize);
      this.renderSize
        .set(this.viewportSize.z, this.viewportSize.w)
        .multiplyScalar(renderer.getPixelRatio());
    }

    const xrView = isXRCamera(camera, renderer);
    const updateCamera = xrView ? renderer.xr.getCamera() : camera;
    // Classic WebGL draws each eye separately; node backends select viewport
    // uniforms per eye in the shader. XR preparation uses the first eye's size.
    const viewport =
      (camera as THREE.PerspectiveCamera).viewport ??
      (xrView
        ? (getViews(updateCamera)[0] as THREE.PerspectiveCamera).viewport
        : undefined);
    this.uniforms.viewportOrigin.value.set(viewport?.x ?? 0, viewport?.y ?? 0);
    if (viewport) this.renderSize.set(viewport.z, viewport.w);
    this.uniforms.renderSize.value.copy(this.renderSize);
    // Accumulator generation inside this draw would reset a classic WebGL
    // eye viewport and must not delay XR frames.
    const renderNested =
      this.backend.kind !== "webgpu" && this.preUpdate && !xrView && !viewport;

    // Trigger update after refreshing renderSize but before any uniforms that
    // depend on the active accumulator, avoiding both size and display latency.
    if (this.autoUpdate && isNewFrame) {
      // Native preparation only updates mappings and edit metadata. Its GPU
      // projection runs below, so it can prepare before XR draws as well.
      // Three has already selected this draw's material and render list.
      // Mode changes must finish outside the draw; onDirty then requests
      // a frame with the matching material, ordering and accumulator.
      const preUpdate =
        this.stochasticFrame === this._stochastic &&
        (this.backend.kind === "webgpu" || renderNested);
      const updateRequest = {
        scene,
        camera: updateCamera,
        shrinkResources: false,
      };
      if (preUpdate) {
        this.runAutomaticUpdate(updateRequest);
      } else if (this.updateTimeoutId === -1) {
        this.updateTimeoutId = setTimeout(() => {
          this.updateTimeoutId = -1;
          this.runAutomaticUpdate(updateRequest);
        }, 0);
      }
    }

    const typedCamera = camera as
      | THREE.PerspectiveCamera
      | THREE.OrthographicCamera;

    this.uniforms.near.value = typedCamera.near;
    this.uniforms.far.value = typedCamera.far;

    const display = this.display;
    // Native WebGPU prepares current poses before every draw.
    if (this.autoUpdate && renderNested) {
      display.refreshTransforms(renderer);
    }
    this.uniforms.renderOrigin.value.copy(display.viewOrigin);
    const geometry = this.geometry;
    // CPU orderings exist only while they match the displayed accumulator.
    this.uniforms.stochasticOrdering.value =
      this.stochasticSort &&
      (this.backend.kind === "webgpu" || this.orderingReady);
    const splatCount =
      this.stochasticFrame && !this.uniforms.stochasticOrdering.value
        ? display.numSplats
        : this.activeSplats;
    geometry.setSplatCount(splatCount);
    this.uniforms.splatCount.value = splatCount;

    // Keep rig scale: Camera.matrixWorldInverse can strip it in Three.js.
    renderToViewMatrixTmp
      .copy(camera.matrixWorld)
      .invert()
      .multiply(renderTranslationTmp.makeTranslation(display.viewOrigin))
      .decompose(
        this.uniforms.renderToViewPos.value,
        this.uniforms.renderToViewQuat.value,
        renderToViewScaleTmp,
      );
    this.uniforms.renderToViewScale.value =
      (renderToViewScaleTmp.x +
        renderToViewScaleTmp.y +
        renderToViewScaleTmp.z) /
      3;
    this.uniforms.maxStdDev.value = this.maxStdDev;
    this.uniforms.minPixelRadius.value = this.minPixelRadius;
    // Negative thresholds hide nothing, like zero.
    const minAlpha = Math.max(0, this.minAlpha);
    this.uniforms.minAlpha.value = minAlpha;
    // A Gaussian's kernel where maxStdDev ends it. One still flat there cannot
    // fade; bound the slope instead.
    const edgeKernel = Math.exp(-0.5 * Math.fround(this.maxStdDev) ** 2);
    const edgeScale = 1 / Math.max(1 - edgeKernel, 0.001);
    this.uniforms.edgeFade.value.set(
      edgeKernel * edgeScale,
      minAlpha * edgeScale,
    );
    this.uniforms.preBlurAmount.value = this.preBlurAmount;
    this.uniforms.blurAmount.value = this.blurAmount;
    this.uniforms.clipXY.value = this.clipXY;
    this.uniforms.focalAdjustment.value = this.focalAdjustment;
    this.uniforms.stochastic.value = this.stochasticFrame;
    this.uniforms.stochasticSample.value = this.stochasticSample >>> 0;
    configureSplatOutput(
      renderer,
      currentRenderTarget,
      this.uniforms,
      this._encodeLinear,
    );

    if (this.backend.kind === "webgpu") {
      if (this.backend.sortError) throw this.backend.sortError;
      if (this.backend.precompile) {
        geometry.instanceCount = 0;
      } else {
        const projected = this.backend.projection.render(
          display,
          camera,
          geometry,
          this.sortRadial,
          this.fastSort,
          this.pendingProjectionShrink,
        );
        if (projected) this.pendingProjectionShrink = false;
      }
    } else {
      const splatTextures = display.getTextures();
      this.uniforms.splats.value = splatTextures[0];
      this.uniforms.splats2.value = splatTextures[1];
      this.uniforms.stochasticSeeds.value = display.getStochasticSeeds();
    }

    this.dirty = false;
  }

  clearSplats() {
    this.activeSplats = 0;
    this.display.numSplats = 0;
    this.display.mapping = [];
    this.syncStochasticFrame();
    this.setDirty();
  }

  async update({
    scene,
    camera,
  }: {
    scene: THREE.Scene;
    camera: THREE.Camera;
  }) {
    assertSupportedCamera(camera, this.renderer);
    this.reportedRenderError = "";
    if (this.backend.kind === "webgpu") {
      await this.backend.precompile;
      if (this.backend.sortError) throw this.backend.sortError;
    }
    await this.updateInternal({
      scene,
      camera,
      shrinkResources: false,
    });
  }

  /** Updates the current scene and shrinks renderer work resources to their current allocation tiers. */
  async shrinkResources({
    scene,
    camera,
  }: {
    scene: THREE.Scene;
    camera: THREE.Camera;
  }) {
    assertSupportedCamera(camera, this.renderer);
    this.reportedRenderError = "";
    await this.updateInternal({
      scene,
      camera,
      shrinkResources: true,
    });
  }

  private updateInternal(request: UpdateRequest): Promise<void> {
    if (this.disposed) return Promise.resolve();

    if (this.backend.kind === "webgpu") {
      const { scene, shrinkResources } = request;
      if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
      if (!(request.camera as THREE.ArrayCamera).isArrayCamera)
        request.camera.updateWorldMatrix(true, false);
      const camera = this.getGenerationCamera(request.camera);
      if (this.ownsTimer) this.timer.update();
      if (shrinkResources) this.pendingProjectionShrink = true;
      const previousVersion = this.current.version;
      const viewChanged =
        !this.current.viewOrigin.equals(
          renderToViewScaleTmp.setFromMatrixPosition(camera.matrixWorld),
        ) ||
        !this.current.viewDirection.equals(
          renderToViewScaleTmp
            .setFromMatrixColumn(camera.matrixWorld, 2)
            .normalize()
            .negate(),
        );
      const { requiredMaxSplats } = this.current.prepareGenerate({
        renderer: this.renderer,
        scene,
        timer: this.timer,
        camera,
        layerCamera: request.camera,
        previous: this.current,
        frameCallbacks: this.frameCallbacks,
      });
      // The accumulator only carries source mappings and the camera-relative
      // origin here. Projection, compaction and ordering happen on the GPU
      // immediately before each draw.
      this.display = this.current;
      this.activeSplats = this.current.numSplats;
      this.maxSplats = requiredMaxSplats;
      this.sortDirty = false;
      this.syncStochasticFrame();
      if (
        shrinkResources ||
        viewChanged ||
        previousVersion !== this.current.version
      ) {
        this.setDirty();
      }
      return Promise.resolve();
    }

    const pending = this.queuedUpdate;
    const shrinkResources =
      request.shrinkResources || (pending?.shrinkResources ?? false);
    this.queuedUpdate = {
      scene: request.scene,
      camera: request.camera,
      shrinkResources,
    };

    if (!this.updateRunning) {
      this.updateRunning = true;
      this.updatePromise = this.drainUpdates();
    }
    return this.updatePromise;
  }

  private async drainUpdates() {
    try {
      while (this.queuedUpdate) {
        const request = this.queuedUpdate;
        this.queuedUpdate = null;
        await this.performUpdate(request);
      }
    } finally {
      this.queuedUpdate = null;
      this.updateRunning = false;
    }
  }

  private async performUpdate({
    scene,
    camera: updateCamera,
    shrinkResources,
  }: UpdateRequest) {
    const next = this.takeAccumulator();

    const renderer = this.renderer;
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (!(updateCamera as THREE.ArrayCamera).isArrayCamera)
      updateCamera.updateWorldMatrix(true, false);
    if (this.ownsTimer) {
      this.timer.update();
    }

    // Read the mode when the update runs; queued requests may predate a switch.
    const mode: SortMode = !this._stochastic
      ? "back"
      : this.stochasticSort
        ? "front"
        : "identity";
    // One viewpoint generates and sorts: the camera, or the WebXR head.
    const camera = this.getGenerationCamera(updateCamera);
    const center = new THREE.Vector3().setFromMatrixPosition(
      camera.matrixWorld,
    );
    const direction = new THREE.Vector3()
      .setFromMatrixColumn(camera.matrixWorld, 2)
      .normalize()
      .negate();
    const moveTolerance =
      0.001 * getCameraWorldScale(getViews(updateCamera)[0]);
    const viewChanged =
      mode !== this.sortedMode ||
      (mode === "back" &&
        (this.sortRadial !== this.sortedRadial ||
          this.fastSort !== this.sortedFastSort)) ||
      center.distanceTo(this.sortedCenter) > moveTolerance ||
      (mode !== "identity" &&
        (mode === "front" || !this.sortRadial) &&
        direction.dot(this.sortedDir) < 0.999);

    const previousVersion = this.current.version;
    let preparation: ReturnType<SplatAccumulator["prepareGenerate"]>;
    try {
      preparation = next.prepareGenerate({
        renderer,
        scene,
        timer: this.timer,
        camera,
        layerCamera: updateCamera,
        previous: this.current,
        frameCallbacks: this.frameCallbacks,
      });
    } catch (error) {
      this.releaseAccumulator(next);
      throw error;
    }
    const { version, sortUpdated, requiredMaxSplats, generate } = preparation;
    const orderingNeedsShrink =
      shrinkResources &&
      this.backend.getOrderingCapacity(requiredMaxSplats) < this.maxSplats;
    const doUpdate =
      shrinkResources ||
      mode !== this.sortedMode ||
      center.distanceTo(this.current.viewOrigin) > moveTolerance ||
      version !== previousVersion;
    const needsSort = orderingNeedsShrink || viewChanged || sortUpdated;
    // Unsorted stochastic draws read source indices directly.
    const skipSort = mode === "identity";

    if (!doUpdate) {
      this.current.viewDirection.copy(direction);
      this.sortDirty ||= needsSort;
      this.releaseAccumulator(next);
    } else {
      try {
        generate(shrinkResources, mode !== "back");
      } catch (error) {
        this.releaseAccumulator(next);
        throw error;
      }

      if (sortUpdated) {
        this.sortStateRevision += 1;
      }

      if (skipSort) {
        this.releaseAccumulator(this.display);
        if (this.current !== this.display) {
          this.releaseAccumulator(this.current);
        }
        // The stochastic shader reads identity indices, so the latest generated
        // accumulator is immediately displayable without a matching ordering.
        this.display = next;
      } else if (
        this.display.mappingVersion === next.mappingVersion &&
        !needsSort
      ) {
        // Appearance-only update: the mapping and existing sort order are
        // still valid, so display the new accumulator immediately.
        this.releaseAccumulator(this.display);
        this.display = next;
      } else {
        if (this.display !== this.current) {
          // The previous current is not being displayed, so replace it
          this.releaseAccumulator(this.current);
        }
      }

      this.current = next;
      // Appearance-only updates can reuse the current ordering. Preserve an
      // already pending sort, but do not enqueue a new one unless depth or the
      // mapping may have changed.
      this.sortDirty ||= needsSort;
      this.setDirty();
    }

    if (skipSort) {
      // No ordering matches the displayed accumulator. Record the view it
      // was generated for, so later frames compare against it as they do
      // against a sort and only real view or mode changes regenerate it.
      this.sortDirty = false;
      this.activeSplats = this.display.numSplats;
      this.orderingReady = false;
      if (doUpdate) {
        this.sortedMode = mode;
        this.sortedCenter.copy(center);
        this.sortedDir.copy(direction);
      }
      if (shrinkResources) {
        this.releaseOrdering();
        this.disposeOversizedAccumulators(this.current.maxSplats);
      }
      this.syncStochasticFrame();
      return;
    }

    await this.driveSort(
      orderingNeedsShrink,
      // Switch modes without waiting for the sort interval.
      shrinkResources || this.stochasticFrame !== this._stochastic,
      mode,
    );

    this.syncStochasticFrame();
    if (shrinkResources) {
      this.disposeOversizedAccumulators(this.current.maxSplats);
    }
  }

  /**
   * Viewpoint for generation, spherical harmonics, the render origin and
   * sorting: the camera, or for WebXR eyes their mean pose, the shared head.
   */
  private getGenerationCamera(camera: THREE.Camera) {
    const views = getViews(camera);
    if (views.length < 2 || !isXRCamera(camera, this.renderer)) return views[0];
    const position = headPositionTmp;
    const target = headTargetTmp;
    getMeanViewPose(views, position, target);
    target.add(position);
    const head = this.headCamera;
    head.matrixAutoUpdate = false;
    head.matrix
      .lookAt(
        position,
        target,
        renderToViewScaleTmp.setFromMatrixColumn(views[0].matrixWorld, 1),
      )
      .setPosition(position);
    head.updateMatrixWorld(true);
    return head;
  }

  private async driveSort(
    shrinkOrdering: boolean,
    forceSort: boolean,
    mode: SortMode,
  ) {
    // WebGL updates await each sort before draining the next queued update.
    if (this.disposed || this.backend.kind === "webgpu" || !this.sortDirty)
      return;

    const now = performance.now();
    const nextSortTime = this.lastSortTime
      ? this.lastSortTime + this.minSortIntervalMs
      : now;

    this.sorting = true;
    this.sortDirty = false;
    this.lastSortTime = performance.now();
    const current = this.current;
    const previousActiveSplats = this.activeSplats;

    try {
      const sortRadial = this.sortRadial;
      const fastSort = this.fastSort;
      if (shrinkOrdering || this.sortWorker?.disposed) this.resetSortWorker();
      this.sortWorker ??= new SplatWorker();
      const sortWorker = this.sortWorker;

      const { numSplats, maxSplats } = current;
      const orderingMaxSplats = this.backend.getOrderingCapacity(maxSplats);
      this.maxSplats = shrinkOrdering
        ? orderingMaxSplats
        : Math.max(this.maxSplats, orderingMaxSplats);

      if (this.orderingBuffer.length !== this.maxSplats) {
        this.orderingBuffer = new Uint32Array(this.maxSplats);
      }

      const stateRevision = this.sortStateRevision;
      const stateUpdate =
        this.uploadedSortStateRevision !== stateRevision
          ? this.sortCenterCache.prepare(current)
          : undefined;
      const cameraPosition = current.viewOrigin.toArray() as [
        number,
        number,
        number,
      ];
      const direction = current.viewDirection.toArray() as [
        number,
        number,
        number,
      ];
      if (!forceSort && now < nextSortTime) {
        await new Promise((resolve) => setTimeout(resolve, nextSortTime - now));
        if (this.disposed) return;
      }
      this.lastSortTime = performance.now();
      if (stateUpdate) {
        const { payload, commit } = stateUpdate;
        await sortWorker.call("setSortCenterState", payload);
        if (this.disposed) return;
        commit();
        this.uploadedSortStateRevision = stateRevision;
      }

      // Every view, including both WebXR eyes, draws this one order.
      const { ordering, activeSplats } = await sortWorker.call(
        "sortCenters32",
        {
          numSplats,
          cameraPosition,
          direction,
          radial: sortRadial,
          fastSort,
          frontSort: mode !== "back",
          ordering: this.orderingBuffer,
        },
      );
      if (this.disposed) return;

      this.activeSplats = activeSplats;
      const previousOrdering = this.backend.cpuOrdering;
      this.backend.setCPUOrdering({
        ordering,
        activeSplats,
        requiredCapacity: this.maxSplats,
        shrink: shrinkOrdering,
      });

      // Keep the displayed texture's CPU source attached while transferring
      // the other buffer to the worker for the next sort.
      this.orderingBuffer =
        previousOrdering?.length === this.maxSplats
          ? previousOrdering
          : new Uint32Array(this.maxSplats);

      this.sortedCenter.fromArray(cameraPosition);
      this.sortedDir.fromArray(direction);
      this.sortedRadial = sortRadial;
      this.sortedFastSort = fastSort;
      this.sortedMode = mode;
      this.orderingReady = true;
      if (this.display !== current) {
        this.releaseAccumulator(this.display);
        this.display = current;
      }
      this.setDirty();
    } catch (error) {
      if (this.disposed) return;
      this.sortDirty = true;
      if (current !== this.display && this.accumulators.length === 0) {
        // A candidate waiting on a new ordering cannot be displayed. Roll back
        // to the still-valid display accumulator and free the failed one.
        this.current = this.display;
        this.releaseAccumulator(current);
        this.activeSplats = previousActiveSplats;
        this.sortDirty = false;
        this.uploadedSortStateRevision = -1;
      }
      throw error;
    } finally {
      this.sorting = false;
    }
  }

  /** Decode sRGB before blending; undefined follows the active blend space. */
  get encodeLinear(): boolean | undefined {
    return this._encodeLinear;
  }

  set encodeLinear(value: boolean | undefined) {
    if (value === this._encodeLinear) return;
    this._encodeLinear = value;
    this.setDirty();
  }

  get premultipliedAlpha(): boolean {
    return this._premultipliedAlpha;
  }

  set premultipliedAlpha(value: boolean) {
    const nextValue = Boolean(value);
    if (this._premultipliedAlpha !== nextValue) {
      this._premultipliedAlpha = nextValue;
      this.applyMaterialState(this.stochasticFrame);
    }
  }

  get transparent(): boolean {
    return this._transparent;
  }

  set transparent(value: boolean) {
    const nextValue = Boolean(value);
    if (this._transparent !== nextValue) {
      this._transparent = nextValue;
      this.applyMaterialState(this.stochasticFrame);
    }
  }

  get fastSort(): boolean {
    return this._fastSort;
  }

  set fastSort(value: boolean) {
    const nextValue = Boolean(value);
    if (nextValue === this._fastSort) return;
    this._fastSort = nextValue;
    // Stochastic orderings sort front to back and ignore it.
    if (!this._stochastic && this.backend.kind !== "webgpu") {
      this.sortDirty = true;
    }
    this.setDirty();
  }

  get stochasticSort(): boolean {
    return this._stochasticSort;
  }

  set stochasticSort(value: boolean) {
    const nextValue = Boolean(value);
    if (nextValue === this._stochasticSort) return;
    this._stochasticSort = nextValue;
    if (this._stochastic && this.backend.kind !== "webgpu") {
      this.sortDirty = true;
    }
    this.setDirty();
  }

  get stochastic(): boolean {
    return this._stochastic;
  }

  /**
   * Whether Splats currently draw stochastically. It follows `stochastic`
   * once an update for the new mode is displayed.
   */
  get stochasticActive(): boolean {
    return this.stochasticFrame;
  }

  set stochastic(value: boolean) {
    const nextValue = Boolean(value);
    if (nextValue === this._stochastic) return;
    this._stochastic = nextValue;
    if (this.display.numSplats === 0) this.syncStochasticFrame();
    this.sortDirty = true;
    this.setDirty();
  }

  get depthTest(): boolean {
    return this._depthTest;
  }

  set depthTest(value: boolean) {
    this._depthTest = Boolean(value);
    this.applyMaterialState(this.stochasticFrame);
  }

  get depthWrite(): boolean {
    return this._depthWrite;
  }

  set depthWrite(value: boolean) {
    this._depthWrite = Boolean(value);
    this.applyMaterialState(this.stochasticFrame);
  }
}

function isOpaqueMaterial(material: THREE.Material) {
  return (
    material.transparent === false &&
    material.blending === THREE.NormalBlending &&
    material.alphaToCoverage === false
  );
}
