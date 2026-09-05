import { set_sort_center_state, sort32_centers } from "gaussian-splat-rs";
import * as THREE from "three";
import { SplatWorker } from "../runtime/SplatWorker";
import {
  WASM_READY,
  isInitialized as isWasmInitialized,
} from "../runtime/wasm";
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
  getRenderFrame,
  setRendererRenderTarget,
} from "./rendererUtils";
import {
  type StochasticMotionPhase,
  StochasticMotionState,
  stochasticResolveMarker,
  stochasticResolveRequired,
} from "./stochastic";
import { DEFAULT_MIN_ALPHA, makeSplatUniforms } from "./uniforms";

const renderToViewScaleTmp = new THREE.Vector3();
const renderToViewMatrixTmp = new THREE.Matrix4();
const renderTranslationTmp = new THREE.Matrix4();
type UpdateRequest = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  shrinkResources: boolean;
  skipSort: boolean;
  settleRevision: number | null;
};

type StochasticRenderPhase = StochasticMotionPhase | "forced";

// Average (uniform) world scale of a camera.
function getCameraWorldScale(camera: THREE.Camera): number {
  const scale = camera.getWorldScale(renderToViewScaleTmp);
  return (scale.x + scale.y + scale.z) / 3;
}

export interface GaussianSplatRendererOptions {
  /**
   * Pass in a THREE.WebGLRenderer or an initialized THREE.WebGPURenderer so
   * Gaussian Splat Lite can perform work outside the usual render loop. It
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
   * performance.
   * @default Math.sqrt(8)
   */
  maxStdDev?: number;
  /*
   **
   * Minimum pixel radius for splat rendering.
   * @default 0.0
   */
  minPixelRadius?: number;
  /**
   * Maximum pixel radius for splat rendering.
   * @default 512.0
   */
  maxPixelRadius?: number;
  /**
   * Minimum alpha value for splat rendering.
   * @default 0.5 / 255
   */
  minAlpha?: number;
  /**
   * Scalar value to add to 2D splat covariance diagonal, effectively blurring +
   * enlarging splats. In scenes trained without the Gsplat anti-aliasing tweak
   * this value was typically 0.3, but with anti-aliasing it is 0.0
   * @default 0.0
   */
  preBlurAmount?: number;
  /**
   * Scalar value to add to 2D splat covarianve diagonal, with opacity adjustment
   * to correctly account for "blurring" when anti-aliasing. Typically 0.3
   * (equivalent to approx 0.5 pixel radius) in scenes trained with anti-aliasing.
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
   * Minimum interval between sort calls in milliseconds.
   * @default 0
   */
  minSortIntervalMs?: number;
  /**
   * Uses one accumulator and sorts before drawing. WebGPU uses a GPU radix
   * sort; WebGL sorts on the main thread.
   * @default false
   */
  synchronousSort?: boolean;
  /**
   * Automatically uses sorting-free stochastic transparency while the camera
   * is moving, then requests one clean sorted frame after it settles. Sorted
   * frames use the depth-only companion draw when depthWrite is disabled.
   * @default false
   */
  autoStochastic?: boolean;
  /**
   * Forces sorting-free stochastic transparency independently of camera motion.
   * Supported in WebXR; dedicated capture paths still use sorted rendering.
   * @default false
   */
  stochastic?: boolean;
  /**
   * Forces the depth-only companion draw after non-stochastic color frames,
   * even when autoStochastic is disabled. It has no effect when depthWrite is
   * already enabled.
   * @default false
   */
  renderDepth?: boolean;
  /**
   * Configures an offline render target for the GaussianSplatRenderer (as opposed to
   * rendering to the canvas). This is useful for rendering environment maps,
   * additional viewpoints, or video frame rendering.
   * @default undefined
   */
  target?: {
    /**
     * Width of the render target in pixels.
     */
    width: number;
    /**
     * Height of the render target in pixels.
     */
    height: number;
    /**
     * If you want to be able to render a scene that depends on this target's
     * output (for example, a recursive viewport), set this to true to enable
     * double buffering.
     * @default false
     */
    doubleBuffer?: boolean;
    /**
     * Super-sampling factor for the render target. Values 1-4 are supported.
     * Note that re-sampling back down to .width x .height is done on the CPU
     * with simple averaging only when calling readTarget().
     * @default 1
     */
    superXY?: number;
  } & THREE.RenderTargetOptions;
  /**
   * Extra uniform values to pass to the shader.
   * @default undefined = no extra uniforms
   */
  extraUniforms?: Record<string, unknown>;
  /**
   * Replace the default `splatVertex.glsl` splat shader with a custom one.
   * @default undefined = use the default `splatVertex.glsl` shader
   */
  vertexShader?: string;
  /**
   * Replace the default `splatFragment.glsl` splat shader with a custom one.
   * @default undefined = use the default `splatFragment.glsl` shader
   */
  fragmentShader?: string;
  /**
   * Set the splat shader material to be transparent which determines if the
   * splats are rendered during the first opaque THREE.js render pass or the
   * second transparent render pass. Stochastic/depth companion modes keep the
   * material at the end of the opaque list for deterministic draw ordering.
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

export class GaussianSplatRenderer extends THREE.Mesh {
  readonly renderer: GaussianSplatCompatibleRenderer;
  readonly material: SplatMaterial;
  readonly uniforms: ReturnType<typeof GaussianSplatRenderer.makeUniforms>;

  autoUpdate: boolean;
  preUpdate: boolean;
  static gaussianSplatOverride?: GaussianSplatRenderer;

  renderSize = new THREE.Vector2();
  maxStdDev: number;
  minPixelRadius: number;
  maxPixelRadius: number;
  minAlpha: number;
  preBlurAmount: number;
  blurAmount: number;
  clipXY: number;
  focalAdjustment: number;
  sortRadial: boolean;
  minSortIntervalMs: number;
  private _synchronousSort: boolean;
  private _autoStochastic: boolean;
  private _stochastic: boolean;
  private _renderDepth: boolean;
  private _premultipliedAlpha: boolean;
  private _transparent: boolean;
  private readonly supportsStochasticShaders: boolean;
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
  private sortCenterCache = new SortCenterCache();
  private sortStateRevision = 0;
  private uploadedSortStateRevision = -1;
  private updateRunning = false;
  private updatePromise: Promise<void> = Promise.resolve();
  private queuedUpdate: UpdateRequest | null = null;
  private disposed = false;
  private sortModeRevision = 0;
  private readonly stochasticMotion = new StochasticMotionState();
  private stochasticPhase: StochasticRenderPhase | null = null;
  private stochasticWasForced = false;
  private requestMotionFollowup = false;
  private forceSortedRenderDepth = 0;
  private stochasticResolveMarkerUsers = 0;
  private stochasticPreviousRenderOrder: number | null = null;
  private _depthMesh: THREE.Mesh<SplatGeometry, SplatMaterial> | null = null;

  private static synchronousSortOwner: GaussianSplatRenderer | null = null;

  target?: THREE.WebGLRenderTarget;
  backTarget?: THREE.WebGLRenderTarget;
  superPixels?: Uint8Array;
  targetPixels?: Uint8Array;
  superXY = 1;

  constructor(options: GaussianSplatRendererOptions) {
    if (!options) {
      throw new Error("GaussianSplatRenderer options are required");
    }
    if (!options.renderer) {
      throw new Error("renderer is required in GaussianSplatRenderer options");
    }
    assertSupportedRenderer(options.renderer);

    const uniforms = GaussianSplatRenderer.makeUniforms();
    Object.assign(uniforms, options.extraUniforms ?? {});

    const premultipliedAlpha = options.premultipliedAlpha ?? true;
    uniforms.premultipliedAlpha.value = premultipliedAlpha;
    const autoStochastic = options.autoStochastic ?? false;
    const stochastic = options.stochastic ?? false;
    const renderDepth = options.renderDepth ?? false;
    const supportsStochasticShaders =
      options.vertexShader === undefined &&
      options.fragmentShader === undefined;
    if (
      (autoStochastic || stochastic || renderDepth) &&
      !supportsStochasticShaders
    ) {
      throw new Error(
        "Stochastic and renderDepth modes require the built-in Splat shaders",
      );
    }
    const geometry = new SplatGeometry();
    const backend = createSplatBackend(options.renderer, uniforms, {
      premultipliedAlpha,
      transparent: options.transparent ?? true,
      depthTest: options.depthTest ?? true,
      depthWrite: options.depthWrite ?? false,
      vertexShader: options.vertexShader,
      fragmentShader: options.fragmentShader,
    });
    const material = backend.material;

    super(geometry, material);
    this.renderer = options.renderer;
    this.backend = backend;
    this.material = material;
    this.uniforms = uniforms;
    this.supportsStochasticShaders = supportsStochasticShaders;
    this.sortedBlending = material.blending;
    this._depthTest = options.depthTest ?? true;
    this._depthWrite = options.depthWrite ?? false;
    this._premultipliedAlpha = premultipliedAlpha;
    this._transparent = options.transparent ?? true;
    this._autoStochastic = autoStochastic;
    this._stochastic = stochastic;
    this._renderDepth = renderDepth;
    this.stochasticPhase = stochastic ? "forced" : null;
    this.applyStochasticRenderOrder();
    this.applyStochasticMaterialState(this.stochasticFrame);
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
    this.maxPixelRadius = options.maxPixelRadius ?? 512.0;
    this.minAlpha = options.minAlpha ?? DEFAULT_MIN_ALPHA;
    this.preBlurAmount = options.preBlurAmount ?? 0.0;
    this.blurAmount = options.blurAmount ?? 0.3;
    this.clipXY = options.clipXY ?? 1.25;
    this.focalAdjustment = options.focalAdjustment ?? 2.0;
    this.sortRadial = options.sortRadial ?? false;
    this.minSortIntervalMs = options.minSortIntervalMs ?? 0;
    this._synchronousSort = options.synchronousSort ?? false;

    const { timer, ownsTimer } = resolveTimer(options.timer);
    this.timer = timer;
    this.ownsTimer = ownsTimer;

    this.display = this.createAccumulator();
    this.current = this.display;
    if (!this._synchronousSort) {
      this.accumulators.push(this.createAccumulator());
    }

    if (options.target) {
      const {
        width,
        height,
        doubleBuffer,
        superXY: origSuperXY,
        ...origTargetOptions
      } = options.target;
      const superXY = Math.max(1, Math.min(4, origSuperXY ?? 1));
      if (width * superXY > 8192 || height * superXY > 8192) {
        throw new Error("Target size too large");
      }
      this.superXY = superXY;

      const superWidth = width * superXY;
      const superHeight = height * superXY;
      const targetOptions: THREE.RenderTargetOptions = {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        ...origTargetOptions,
      };

      this.target = new THREE.WebGLRenderTarget(
        superWidth,
        superHeight,
        targetOptions,
      );
      if (doubleBuffer) {
        this.backTarget = new THREE.WebGLRenderTarget(
          superWidth,
          superHeight,
          targetOptions,
        );
      }
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

    // @ts-ignore Object base class has a dispose method in Three.js >= r186
    super.dispose?.();

    if (this.target) {
      this.target.dispose();
      this.target = undefined;
    }
    if (this.backTarget) {
      this.backTarget.dispose();
      this.backTarget = undefined;
    }
    this.backend.dispose();
    this._depthMesh?.removeFromParent();
    this._depthMesh?.material.dispose();
    this._depthMesh = null;
    this.stochasticMotion.reset();

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
    if (GaussianSplatRenderer.synchronousSortOwner === this) {
      GaussianSplatRenderer.synchronousSortOwner = null;
    }
    this.releaseReadbackBuffers();
    this.orderingBuffer = new Uint32Array(0);
    this.maxSplats = 0;
    this.activeSplats = 0;

    this.geometry.dispose();
    this.material.dispose();
  }

  get synchronousSort() {
    return this._synchronousSort;
  }

  set synchronousSort(value: boolean) {
    const nextValue = Boolean(value);
    if (nextValue === this._synchronousSort) return;

    this._synchronousSort = nextValue;
    this.sortModeRevision += 1;
    this.sortDirty = true;
    this.sortedCenter.setScalar(Number.NEGATIVE_INFINITY);
    this.sortedDir.setScalar(0);
    this.sortedRadial = undefined;
    this.sortCenterCache.dispose();
    this.uploadedSortStateRevision = -1;
    if (GaussianSplatRenderer.synchronousSortOwner === this) {
      GaussianSplatRenderer.synchronousSortOwner = null;
    }

    if (nextValue) {
      // A candidate accumulator can be waiting for an asynchronous ordering.
      // Drop it and keep displaying the last internally consistent state.
      if (this.current !== this.display) {
        this.current.dispose();
        this.current = this.display;
      }
      for (const accumulator of this.accumulators) accumulator.dispose();
      this.accumulators.length = 0;
      if (this.backend.kind === "webgpu") {
        this.orderingBuffer = new Uint32Array(0);
      }
    } else if (this.accumulators.length === 0) {
      this.accumulators.push(this.createAccumulator());
    }

    if (!this.sorting) this.resetSortWorker();
    this.setDirty();
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

  private releaseReadbackBuffers() {
    this.superPixels = undefined;
    this.targetPixels = undefined;
  }

  private createAccumulator() {
    return new SplatAccumulator();
  }

  private takeAccumulator() {
    return this.accumulators.pop() ?? this.createAccumulator();
  }

  private releaseAccumulator(accumulator: SplatAccumulator) {
    this.accumulators.push(accumulator);
  }

  private disposeOversizedAccumulators(maxSplats: number) {
    for (const accumulator of this.accumulators) {
      if (accumulator.maxSplats > maxSplats) accumulator.dispose();
    }
  }

  private prepareStochasticFrame(
    camera: THREE.Camera,
    renderer: GaussianSplatCompatibleRenderer,
  ) {
    if (!this.canRenderStochastic(renderer)) {
      const wasActive = this.stochasticFrame;
      this.stochasticPhase = null;
      this.stochasticWasForced = false;
      this.requestMotionFollowup = false;
      if (wasActive && !this.stochasticModeEnabled) {
        this.applyStochasticRenderOrder();
        this.applyStochasticMaterialState(false);
      }
      return;
    }

    if (this._stochastic) {
      this.stochasticWasForced = true;
      this.stochasticMotion.observe(camera);
      this.stochasticPhase = "forced";
    } else if (
      this._autoStochastic &&
      this.autoUpdate &&
      !renderer.xr.isPresenting
    ) {
      this.stochasticPhase = this.stochasticMotion.observe(camera);
      if (this.stochasticPhase !== "settling") this.stochasticWasForced = false;
    }
    this.requestMotionFollowup = this.stochasticPhase === "moving";
  }

  private get stochasticModeEnabled() {
    return this._autoStochastic || this._stochastic;
  }

  private get renderDepthEnabled() {
    return this._autoStochastic || this._renderDepth;
  }

  private get managedRenderPipeline() {
    return (
      this.stochasticModeEnabled ||
      (this.renderDepthEnabled && !this._depthWrite) ||
      this.stochasticFrame
    );
  }

  private get stochasticFrame() {
    return this.stochasticPhase !== null && this.stochasticPhase !== "sorted";
  }

  private get frameSkipSort() {
    return (
      this.stochasticPhase === "moving" || this.stochasticPhase === "forced"
    );
  }

  private get frameSettleRevision() {
    return this.stochasticPhase === "settling"
      ? this.stochasticMotion.revision
      : null;
  }

  private canRenderStochastic(renderer: GaussianSplatCompatibleRenderer) {
    if (this.forceSortedRenderDepth > 0) return false;
    if (this._stochastic) return true;
    if (!this.autoUpdate) return false;
    const settling = this.stochasticPhase === "settling";
    // XR permits only a manual mode's pending sorted replacement.
    return renderer.xr.isPresenting
      ? settling && this.stochasticWasForced
      : settling || this._autoStochastic;
  }

  private ensureDepthMesh() {
    if (this.disposed) throw new Error("GaussianSplatRenderer is disposed");
    if (this._depthMesh) return this._depthMesh;

    const depthUniforms = {
      ...this.uniforms,
      stochastic: { value: false },
      stochasticResolve: { value: false },
    };
    const material = this.backend.createDepthMaterial(depthUniforms);
    material.blending = THREE.NoBlending;
    material.colorWrite = false;

    const mesh = new THREE.Mesh(this.geometry as SplatGeometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.layers = this.layers;
    mesh.renderOrder = Number.POSITIVE_INFINITY;
    mesh.visible = this.renderDepthEnabled && !this._depthWrite;
    mesh.onBeforeRender = () => {
      const owner = GaussianSplatRenderer.gaussianSplatOverride ?? this;
      mesh.geometry.instanceCount = owner.stochasticFrame
        ? 0
        : owner.activeSplats;
      owner.backend.bindOrdering(material, depthUniforms);
    };
    this._depthMesh = mesh;
    this.add(mesh);
    return mesh;
  }

  private applyStochasticRenderOrder() {
    if (this.managedRenderPipeline) {
      if (this.stochasticPreviousRenderOrder === null) {
        this.stochasticPreviousRenderOrder = this.renderOrder;
      }
      // Managed modes keep the Splat in the opaque list so blend/depth state
      // can change in onBeforeRender without rebuilding the render list.
      // Draw after conventional opaque geometry, immediately followed by the
      // optional depth-only bridge.
      this.renderOrder = Number.MAX_SAFE_INTEGER;
      return;
    }

    if (this.stochasticPreviousRenderOrder !== null) {
      if (this.renderOrder === Number.MAX_SAFE_INTEGER) {
        this.renderOrder = this.stochasticPreviousRenderOrder;
      }
      this.stochasticPreviousRenderOrder = null;
    }
  }

  private applyStochasticMaterialState(active: boolean) {
    // Keep stochastic-enabled Splats in a stable render list. onBeforeRender is
    // early enough to change GPU blend/depth state, but too late to move an
    // object between Three.js's opaque and transparent lists.
    const managedAsOpaque = this.managedRenderPipeline;
    const transparent = managedAsOpaque ? false : this._transparent;
    const blending = active
      ? THREE.NoBlending
      : managedAsOpaque && this._transparent
        ? THREE.CustomBlending
        : this.sortedBlending;
    const wasOpaque = isOpaqueMaterial(this.material);
    this.material.transparent = transparent;
    this.material.blending = blending;
    if (managedAsOpaque && this._transparent) {
      this.material.blendEquation = THREE.AddEquation;
      this.material.blendSrc = this._premultipliedAlpha
        ? THREE.OneFactor
        : THREE.SrcAlphaFactor;
      this.material.blendDst = THREE.OneMinusSrcAlphaFactor;
      this.material.blendEquationAlpha = THREE.AddEquation;
      this.material.blendSrcAlpha = THREE.OneFactor;
      this.material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    this.material.depthTest = active ? true : this._depthTest;
    this.material.depthWrite = active ? true : this._depthWrite;
    if (this.renderDepthEnabled && !this._depthWrite) {
      this.ensureDepthMesh().visible = true;
    } else if (this._depthMesh) {
      this._depthMesh.visible = false;
    }
    if (wasOpaque !== isOpaqueMaterial(this.material)) {
      this.material.needsUpdate = true;
    }
  }

  onBeforeRender(
    renderer: GaussianSplatCompatibleRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    const gaussianSplatRenderer =
      GaussianSplatRenderer.gaussianSplatOverride ?? this;

    const frame = getRenderFrame(renderer);
    const isNewFrame = frame !== gaussianSplatRenderer.lastFrame;
    gaussianSplatRenderer.lastFrame = frame;

    const currentRenderTarget = renderer.getRenderTarget();
    if (currentRenderTarget) {
      gaussianSplatRenderer.renderSize.set(
        currentRenderTarget.width,
        currentRenderTarget.height,
      );
    } else {
      renderer.getDrawingBufferSize(gaussianSplatRenderer.renderSize);
    }

    let useCamera = camera;
    this.uniforms.viewportOrigin.value.set(0, 0);
    if (renderer.xr.isPresenting) {
      const xrCamera = renderer.xr.getCamera();
      // Keep the per-eye camera parented to the XR rig so its world transform
      // includes any scale applied to that rig.
      useCamera = xrCamera.cameras[0] ?? xrCamera;
      const viewport =
        (camera as THREE.PerspectiveCamera).viewport ??
        (useCamera as THREE.PerspectiveCamera).viewport;
      if (viewport) {
        // WebGPU selects each eye's size in the shader; updates use the first.
        gaussianSplatRenderer.renderSize.set(viewport.z, viewport.w);
        this.uniforms.viewportOrigin.value.set(viewport.x, viewport.y);
      }
    }
    this.uniforms.renderSize.value.copy(gaussianSplatRenderer.renderSize);

    if (isNewFrame) {
      gaussianSplatRenderer.prepareStochasticFrame(useCamera, renderer);
    }

    // Trigger update after refreshing renderSize but before any uniforms that
    // depend on the active accumulator, avoiding both size and display latency.
    if (gaussianSplatRenderer.autoUpdate && isNewFrame) {
      // Update before drawing when requested so the current frame can use the
      // latest accumulator. WebXR updates after the active render pass.
      const preUpdate =
        gaussianSplatRenderer.preUpdate && !renderer.xr.isPresenting;
      const updateRequest = {
        scene,
        camera: useCamera,
        shrinkResources: false,
        skipSort: gaussianSplatRenderer.frameSkipSort,
        settleRevision: gaussianSplatRenderer.frameSettleRevision,
      };
      if (preUpdate) {
        gaussianSplatRenderer.updateInternal(updateRequest);
      } else if (gaussianSplatRenderer.updateTimeoutId === -1) {
        gaussianSplatRenderer.updateTimeoutId = setTimeout(() => {
          gaussianSplatRenderer.updateTimeoutId = -1;
          gaussianSplatRenderer.updateInternal(updateRequest);
        }, 1);
      }
    }

    const typedCamera = camera as
      | THREE.PerspectiveCamera
      | THREE.OrthographicCamera;

    this.uniforms.near.value = typedCamera.near;
    this.uniforms.far.value = typedCamera.far;

    const display = gaussianSplatRenderer.display;
    this.uniforms.renderOrigin.value.copy(display.viewOrigin);
    const geometry = this.geometry as SplatGeometry;
    geometry.instanceCount = gaussianSplatRenderer.stochasticFrame
      ? display.numSplats
      : gaussianSplatRenderer.activeSplats;
    this.uniforms.numSplats.value = gaussianSplatRenderer.activeSplats;

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
    this.uniforms.maxStdDev.value = gaussianSplatRenderer.maxStdDev;
    this.uniforms.minPixelRadius.value = gaussianSplatRenderer.minPixelRadius;
    this.uniforms.maxPixelRadius.value = gaussianSplatRenderer.maxPixelRadius;
    this.uniforms.minAlpha.value = gaussianSplatRenderer.minAlpha;
    this.uniforms.preBlurAmount.value = gaussianSplatRenderer.preBlurAmount;
    this.uniforms.blurAmount.value = gaussianSplatRenderer.blurAmount;
    this.uniforms.clipXY.value = gaussianSplatRenderer.clipXY;
    this.uniforms.focalAdjustment.value = gaussianSplatRenderer.focalAdjustment;
    this.uniforms.stochastic.value = gaussianSplatRenderer.stochasticFrame;
    configureSplatOutput(
      renderer,
      currentRenderTarget,
      this.uniforms,
      this.stochasticResolveMarkerUsers,
    );
    if (this.stochasticModeEnabled) {
      this.applyStochasticMaterialState(gaussianSplatRenderer.stochasticFrame);
    }

    gaussianSplatRenderer.backend.bindOrdering(this.material, this.uniforms);
    const splatTextures = display.getTextures();
    this.uniforms.splats.value = splatTextures[0];
    this.uniforms.splats2.value = splatTextures[1];

    this.uniforms.time.value = display.time;
    this.uniforms.deltaTime.value = display.deltaTime;
    // Alternating debug flag that can aid in visual debugging
    this.uniforms.debugFlag.value = (performance.now() / 1000.0) % 2.0 < 1.0;

    gaussianSplatRenderer.dirty = false;
  }

  onAfterRender() {
    const gaussianSplatRenderer =
      GaussianSplatRenderer.gaussianSplatOverride ?? this;
    if (gaussianSplatRenderer.requestMotionFollowup) {
      gaussianSplatRenderer.requestMotionFollowup = false;
      gaussianSplatRenderer.setDirty();
    }
  }

  clearSplats() {
    this.activeSplats = 0;
    this.display.numSplats = 0;
    this.setDirty();
  }

  async update({
    scene,
    camera,
  }: {
    scene: THREE.Scene;
    camera: THREE.Camera;
  }) {
    await this.updateInternal({
      scene,
      camera,
      shrinkResources: false,
      skipSort: false,
      settleRevision: null,
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
    await this.updateInternal({
      scene,
      camera,
      shrinkResources: true,
      skipSort: false,
      settleRevision: null,
    });
  }

  private updateInternal(request: UpdateRequest): Promise<void> {
    if (this.disposed) return Promise.resolve();

    const pending = this.queuedUpdate;
    const shrinkResources =
      request.shrinkResources || (pending?.shrinkResources ?? false);
    this.queuedUpdate = {
      scene: request.scene,
      camera: request.camera,
      shrinkResources,
      skipSort: shrinkResources ? false : request.skipSort,
      settleRevision: shrinkResources ? null : request.settleRevision,
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
    } catch (error) {
      this.queuedUpdate = null;
      throw error;
    } finally {
      this.updateRunning = false;
    }
  }

  private async performUpdate({
    scene,
    camera,
    shrinkResources,
    skipSort,
    settleRevision,
  }: UpdateRequest) {
    if (this._synchronousSort && !skipSort) {
      const initialization =
        this.backend.kind === "webgpu"
          ? this.backend.precompile
          : isWasmInitialized()
            ? null
            : WASM_READY;
      if (initialization) {
        const sortModeRevision = this.sortModeRevision;
        await initialization;
        if (
          this.disposed ||
          sortModeRevision !== this.sortModeRevision ||
          !this._synchronousSort
        ) {
          return;
        }
      }
      if (this.backend.kind === "webgpu" && this.backend.sortError)
        throw this.backend.sortError;
    }

    const renderer = this.renderer;
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (shrinkResources) {
      this.releaseReadbackBuffers();
    }
    if (this.ownsTimer) {
      this.timer.update();
    }

    const center = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());

    const viewChanged =
      center.distanceTo(this.sortedCenter) >
        0.001 * getCameraWorldScale(camera) ||
      dir.dot(this.sortedDir) < 0.999 ||
      this.sortRadial !== this.sortedRadial;

    const inPlace = this._synchronousSort;
    const previousVersion = this.current.version;
    const next = inPlace ? this.current : this.takeAccumulator();
    // prepareGenerate() temporarily replaces the origin even if generation is
    // later skipped. Preserve the origin paired with the in-place GPU data.
    const previousViewOrigin = inPlace ? next.viewOrigin.clone() : null;
    if (!inPlace && next === this.current) {
      // Should never happen
      throw new Error(
        "Next accumulator is the same as the current accumulator",
      );
    }
    let preparation: ReturnType<SplatAccumulator["prepareGenerate"]>;
    try {
      preparation = next.prepareGenerate({
        renderer,
        scene,
        timer: this.timer,
        camera,
        previous: this.current,
      });
    } catch (error) {
      if (previousViewOrigin) next.viewOrigin.copy(previousViewOrigin);
      else this.releaseAccumulator(next);
      throw error;
    }
    const { version, sortUpdated, requiredMaxSplats, generate } = preparation;
    const orderingNeedsShrink =
      shrinkResources &&
      this.backend.getOrderingCapacity(requiredMaxSplats) < this.maxSplats;
    const doUpdate =
      shrinkResources || viewChanged || version !== previousVersion;
    const needsSort = orderingNeedsShrink || viewChanged || sortUpdated;

    if (!doUpdate) {
      if (previousViewOrigin) {
        next.viewOrigin.copy(previousViewOrigin);
      } else {
        // Restore unused accumulator to the free list.
        this.releaseAccumulator(next);
      }
    } else {
      try {
        generate(shrinkResources);
      } catch (error) {
        if (!inPlace) this.releaseAccumulator(next);
        throw error;
      }

      if (sortUpdated) {
        this.sortStateRevision += 1;
      }

      if (skipSort) {
        if (!inPlace) {
          if (this.display !== next) this.releaseAccumulator(this.display);
          if (this.current !== next && this.current !== this.display) {
            this.releaseAccumulator(this.current);
          }
        }
        // The stochastic shader reads identity indices, so the latest generated
        // accumulator is immediately displayable without a matching ordering.
        this.display = next;
        this.current = next;
      } else if (inPlace) {
        // Generation and sorting both complete on this accumulator before the
        // caller resumes, so no pending display/current pair is required.
        this.display = next;
        this.current = next;
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
      // Even sub-threshold camera movement owes a fresh exact ordering once it
      // stops. Padding in a WebGL accumulator is zero-alpha and safe to visit.
      this.sortDirty = true;
      this.activeSplats = this.display.numSplats;
      this.setDirty();
      return;
    }

    if (shrinkResources && this.backend.kind === "webgpu") {
      if (
        await this.backend.shrinkSort(
          this.backend.getOrderingCapacity(requiredMaxSplats),
        )
      ) {
        this.sortDirty = true;
      }
    }

    await this.driveSort(
      orderingNeedsShrink,
      shrinkResources || settleRevision !== null,
    );

    if (
      settleRevision !== null &&
      !this.sortDirty &&
      this.current === this.display &&
      this.stochasticMotion.complete(settleRevision)
    ) {
      // An async sort may finish after the camera starts moving again. The
      // revision check above keeps that stale result from ending motion mode.
      this.stochasticPhase = null;
      this.stochasticWasForced = false;
      this.applyStochasticRenderOrder();
      this.applyStochasticMaterialState(false);
      this.setDirty();
    }
    if (shrinkResources) {
      this.disposeOversizedAccumulators(this.current.maxSplats);
    }
  }

  private async driveSort(shrinkOrdering = false, forceSort = false) {
    if (this.disposed || this.sorting || !this.sortDirty) {
      return;
    }

    const synchronousSort = this._synchronousSort;
    const sortModeRevision = this.sortModeRevision;
    const now = performance.now();
    const nextSortTime = this.lastSortTime
      ? this.lastSortTime + this.minSortIntervalMs
      : now;
    // Synchronous mode must keep the in-place accumulator and its ordering in
    // lockstep, so it intentionally ignores asynchronous sort throttling.
    if (!synchronousSort && !forceSort && now < nextSortTime) {
      await new Promise((resolve) => setTimeout(resolve, nextSortTime - now));
      if (
        this.disposed ||
        sortModeRevision !== this.sortModeRevision ||
        synchronousSort !== this._synchronousSort
      ) {
        return;
      }
    }

    this.sorting = true;
    this.sortDirty = false;
    this.lastSortTime = performance.now();
    const current = this.current;
    const previousActiveSplats = this.activeSplats;

    try {
      const sortRadial = this.sortRadial;
      const gpuBackend =
        synchronousSort && this.backend.kind === "webgpu" ? this.backend : null;
      let sortWorker: SplatWorker | null = null;
      if (synchronousSort && !gpuBackend) {
        if (!isWasmInitialized()) {
          await WASM_READY;
          if (
            this.disposed ||
            sortModeRevision !== this.sortModeRevision ||
            !this._synchronousSort
          ) {
            return;
          }
        }
        // The main-thread WASM instance owns one global sort state. Force a
        // complete state upload whenever another renderer used it last.
        if (GaussianSplatRenderer.synchronousSortOwner !== this) {
          this.sortCenterCache.dispose();
          this.uploadedSortStateRevision = -1;
          GaussianSplatRenderer.synchronousSortOwner = this;
        }
        if (this.sortWorker) this.resetSortWorker();
      } else if (!synchronousSort) {
        if (shrinkOrdering) this.resetSortWorker();
        if (this.sortWorker && this.sortedRadial !== sortRadial) {
          this.resetSortWorker();
        }
        this.sortWorker ??= new SplatWorker();
        sortWorker = this.sortWorker;
      }

      const { numSplats, maxSplats } = current;
      const orderingMaxSplats = this.backend.getOrderingCapacity(maxSplats);
      this.maxSplats = shrinkOrdering
        ? orderingMaxSplats
        : Math.max(this.maxSplats, orderingMaxSplats);

      if (gpuBackend) {
        gpuBackend.sortAccumulator(
          current,
          this.maxSplats,
          shrinkOrdering,
          sortRadial,
        );
        this.activeSplats = numSplats;
        this.sortedCenter.copy(current.viewOrigin);
        this.sortedDir.copy(current.viewDirection);
        this.sortedRadial = sortRadial;
        if (this.current === current && this.display !== current) {
          this.releaseAccumulator(this.display);
          this.display = current;
        }
        this.setDirty();
        return;
      }

      if (this.orderingBuffer.length !== this.maxSplats) {
        this.orderingBuffer = new Uint32Array(this.maxSplats);
      }

      const stateRevision = this.sortStateRevision;
      if (this.uploadedSortStateRevision !== stateRevision) {
        const { payload, commit } = this.sortCenterCache.prepare(current);
        if (synchronousSort) {
          set_sort_center_state(
            payload.centerUpdateRangeIndices,
            payload.updateCenters,
            payload.matrixUpdateRangeIndices,
            payload.updateMatrices,
            payload.rangeMeshIds,
            payload.rangeBases,
            payload.rangeCounts,
          );
        } else {
          if (!sortWorker) throw new Error("Sort worker is not initialized");
          await sortWorker.call("setSortCenterState", payload);
          if (
            this.disposed ||
            sortModeRevision !== this.sortModeRevision ||
            this._synchronousSort
          ) {
            return;
          }
        }
        commit();
        this.uploadedSortStateRevision = stateRevision;
      }

      let result: { activeSplats: number; ordering: Uint32Array };
      if (synchronousSort) {
        result = {
          activeSplats: sort32_centers(
            numSplats,
            current.viewOrigin.x,
            current.viewOrigin.y,
            current.viewOrigin.z,
            current.viewDirection.x,
            current.viewDirection.y,
            current.viewDirection.z,
            sortRadial,
            this.orderingBuffer,
          ),
          ordering: this.orderingBuffer,
        };
      } else {
        if (!sortWorker) throw new Error("Sort worker is not initialized");
        result = await sortWorker.call("sortCenters32", {
          numSplats,
          cameraPosition: [
            current.viewOrigin.x,
            current.viewOrigin.y,
            current.viewOrigin.z,
          ],
          direction: [
            current.viewDirection.x,
            current.viewDirection.y,
            current.viewDirection.z,
          ],
          radial: sortRadial,
          ordering: this.orderingBuffer,
        });
        if (
          this.disposed ||
          sortModeRevision !== this.sortModeRevision ||
          this._synchronousSort
        ) {
          // Recover the transferred buffer even though this result belongs to
          // the previous mode; the replacement sort will overwrite it.
          this.orderingBuffer = result.ordering;
          return;
        }
      }

      this.activeSplats = result.activeSplats;
      const previousOrdering = synchronousSort
        ? null
        : this.backend.cpuOrdering;
      this.backend.setCPUOrdering({
        ordering: result.ordering,
        activeSplats: result.activeSplats,
        capacity: this.maxSplats,
        requiredCapacity: orderingMaxSplats,
        shrink: shrinkOrdering,
      });

      if (synchronousSort) {
        // WASM and the GPU resource retain the same CPU-side array. It is
        // overwritten in place by the next blocking sort.
        this.orderingBuffer = result.ordering;
      } else {
        // Alternate two buffers so the texture's CPU-side source stays attached
        // while the other buffer is transferred to the worker for the next sort.
        this.orderingBuffer =
          previousOrdering instanceof Uint32Array &&
          previousOrdering.length === this.maxSplats
            ? previousOrdering
            : new Uint32Array(this.maxSplats);
      }

      // console.log(`Sorted (${this.minSortIntervalMs}) ${numSplats} splats in ${(performance.now() - now).toFixed(0)} ms`);

      this.sortedCenter.copy(current.viewOrigin);
      this.sortedDir.copy(current.viewDirection);
      this.sortedRadial = sortRadial;
      if (this.current === current && this.display !== current) {
        this.releaseAccumulator(this.display);
        this.display = current;
      }
      this.setDirty();
    } catch (error) {
      if (this.disposed) return;
      if (
        sortModeRevision !== this.sortModeRevision ||
        synchronousSort !== this._synchronousSort
      ) {
        return;
      }

      this.sortDirty = true;
      if (
        this.current === current &&
        current !== this.display &&
        this.accumulators.length === 0
      ) {
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
      if (!this.disposed && this.sortDirty) this.setDirty();
    }
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const previousOverride = GaussianSplatRenderer.gaussianSplatOverride;
    try {
      GaussianSplatRenderer.gaussianSplatOverride = this;
      this.renderer.render(scene, camera);
    } finally {
      GaussianSplatRenderer.gaussianSplatOverride = previousOverride;
    }
  }

  renderTarget({
    scene,
    camera,
  }: { scene: THREE.Scene; camera: THREE.Camera }): THREE.WebGLRenderTarget {
    const target = this.backTarget ?? this.target;
    if (!target) {
      throw new Error("No target");
    }

    const previousTarget = this.renderer.getRenderTarget();
    const previousOverride = GaussianSplatRenderer.gaussianSplatOverride;
    try {
      this.forceSortedRenderDepth += 1;
      this.renderer.setRenderTarget(target);
      GaussianSplatRenderer.gaussianSplatOverride = this;
      this.renderer.render(scene, camera);
    } finally {
      this.forceSortedRenderDepth -= 1;
      GaussianSplatRenderer.gaussianSplatOverride = previousOverride;
      setRendererRenderTarget(this.renderer, previousTarget);
    }

    if (target !== this.target) {
      // Swap back buffer and target
      [this.target, this.backTarget] = [this.backTarget, this.target];
    }
    return target;
  }

  // Read back the previously rendered target image as a Uint8Array of packed
  // RGBA values (in that order). Subsequent calls to this.readTarget()
  // will reuse the same buffers to minimize memory allocations.
  async readTarget(): Promise<Uint8Array> {
    if (!this.target) {
      throw new Error("Must initialize with target");
    }
    const { width, height } = this.target;
    const byteSize = width * height * 4;
    if (!this.superPixels || this.superPixels.length < byteSize) {
      this.superPixels = new Uint8Array(byteSize);
      // console.log(`Allocated superPixels: ${width}x${height} = ${pixelCount} bytes`);
    }
    const superPixels = this.superPixels;

    await this.backend.readPixels(this.target, superPixels);

    const { superXY } = this;
    if (superXY === 1) {
      return superPixels;
    }

    const subWidth = width / superXY;
    const subHeight = height / superXY;
    const subSize = subWidth * subHeight * 4;
    if (!this.targetPixels || this.targetPixels.length < subSize) {
      this.targetPixels = new Uint8Array(subSize);
      // console.log(`Allocated targetPixels: ${subWidth}x${subHeight} = ${subSize} bytes`);
    }
    const targetPixels = this.targetPixels;

    const super2 = superXY * superXY;
    for (let y = 0; y < subHeight; y++) {
      const row = y * subWidth;
      for (let x = 0; x < subWidth; x++) {
        const superCol = x * superXY;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < superXY; sy++) {
          const superRow = (y * superXY + sy) * width;
          for (let sx = 0; sx < superXY; sx++) {
            const superIndex = (superRow + superCol + sx) * 4;
            r += superPixels[superIndex];
            g += superPixels[superIndex + 1];
            b += superPixels[superIndex + 2];
            a += superPixels[superIndex + 3];
          }
        }
        const pixelIndex = (row + x) * 4;
        targetPixels[pixelIndex] = r / super2;
        targetPixels[pixelIndex + 1] = g / super2;
        targetPixels[pixelIndex + 2] = b / super2;
        targetPixels[pixelIndex + 3] = a / super2;
      }
    }
    return targetPixels;
  }

  async renderReadTarget({
    scene,
    camera,
  }: {
    scene: THREE.Scene;
    camera: THREE.Camera;
  }): Promise<Uint8Array> {
    this.renderTarget({ scene, camera });
    return this.readTarget();
  }

  // Data and buffers used for environment map rendering
  private static cubeRender: {
    target: THREE.WebGLCubeRenderTarget;
    cubeCamera: THREE.CubeCamera;
    near: number;
    far: number;
  } | null = null;
  private static pmrem: {
    fromCubemap(texture: THREE.Texture): { texture: THREE.Texture };
    dispose(): void;
  } | null = null;
  private static pmremRenderer: GaussianSplatCompatibleRenderer | null = null;

  // Renders out the scene to a cube map that can be used for
  // Image-based lighting or similar applications. First optionally updates Gsplats,
  // sorts them with respect to the provided worldCenter, renders 6 cube faces.
  async renderCubeMap({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1000,
    hideObjects = [],
    update = true,
    filter = false,
  }: {
    scene: THREE.Scene;
    worldCenter: THREE.Vector3;
    size?: number;
    near?: number;
    far?: number;
    hideObjects: THREE.Object3D[];
    update: boolean;
    filter: boolean;
  }): Promise<THREE.CubeTexture> {
    if (
      !GaussianSplatRenderer.cubeRender ||
      GaussianSplatRenderer.cubeRender.target.width !== size ||
      GaussianSplatRenderer.cubeRender.near !== near ||
      GaussianSplatRenderer.cubeRender.far !== far
    ) {
      if (GaussianSplatRenderer.cubeRender) {
        GaussianSplatRenderer.cubeRender.target.dispose();
      }
      const target = new THREE.WebGLCubeRenderTarget(size, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        generateMipmaps: filter,
        minFilter: filter ? THREE.LinearMipMapLinearFilter : THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        colorSpace: filter ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace,
      });
      const cubeCamera = new THREE.CubeCamera(near, far, target);
      GaussianSplatRenderer.cubeRender = { target, cubeCamera, near, far };
    }

    const { target, cubeCamera } = GaussianSplatRenderer.cubeRender;
    cubeCamera.position.copy(worldCenter);

    // Save the visibility state of objects we want to hide before render
    const objectVisibility = new Map<THREE.Object3D, boolean>();
    for (const object of hideObjects) {
      if (!objectVisibility.has(object)) {
        objectVisibility.set(object, object.visible);
      }
      object.visible = false;
    }

    const previousOverride = GaussianSplatRenderer.gaussianSplatOverride;
    try {
      this.forceSortedRenderDepth += 1;
      if (update) {
        const tempCamera = new THREE.Camera();
        tempCamera.position.copy(worldCenter);
        await this.update({ scene, camera: tempCamera });
      }

      GaussianSplatRenderer.gaussianSplatOverride = this;
      // Update the CubeCamera, which performs 6 cube face renders
      cubeCamera.update(this.renderer as THREE.WebGLRenderer, scene);
      return target.texture;
    } finally {
      this.forceSortedRenderDepth -= 1;
      GaussianSplatRenderer.gaussianSplatOverride = previousOverride;
      for (const [object, visible] of objectVisibility.entries()) {
        object.visible = visible;
      }
    }
  }

  async readCubeTargets(): Promise<Uint8Array[]> {
    if (!GaussianSplatRenderer.cubeRender) {
      throw new Error("No cube render");
    }

    const { target } = GaussianSplatRenderer.cubeRender;
    const { width, height } = target;
    const promises = [];
    const buffers = [];

    for (let i = 0; i < target.texture.images.length; ++i) {
      const byteSize = width * height * 4;
      const readback = new Uint8Array(byteSize);
      buffers.push(readback);
      const promise = this.backend.readPixels(target, readback, i);
      promises.push(promise);
    }

    await Promise.all(promises);
    return buffers;
  }

  // Renders out the scene to an environment map that can be used for
  // Image-based lighting or similar applications. First optionally updates Gsplats,
  // sorts them with respect to the provided worldCenter, renders 6 cube faces,
  // then pre-filters them using THREE.PMREMGenerator and returns a THREE.Texture
  // that can assigned directly to a THREE.MeshStandardMaterial.envMap property.
  async renderEnvMap({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1000,
    hideObjects = [],
    update = true,
  }: {
    scene: THREE.Scene;
    worldCenter: THREE.Vector3;
    size?: number;
    near?: number;
    far?: number;
    hideObjects: THREE.Object3D[];
    update: boolean;
  }): Promise<THREE.Texture> {
    const cubeTexture = await this.renderCubeMap({
      scene,
      worldCenter,
      size,
      near,
      far,
      hideObjects,
      update,
      filter: true,
    });
    // Pre-filter the cube map using THREE.PMREMGenerator if requested
    if (GaussianSplatRenderer.pmremRenderer !== this.renderer) {
      GaussianSplatRenderer.pmrem?.dispose();
      GaussianSplatRenderer.pmrem = this.backend.createPMREMGenerator();
      GaussianSplatRenderer.pmremRenderer = this.renderer;
    }

    const pmrem = GaussianSplatRenderer.pmrem;
    if (!pmrem) throw new Error("PMREM generator is not initialized");
    return pmrem.fromCubemap(cubeTexture).texture;
  }

  // Utility function to recursively set the envMap property for any
  // THREE.MeshStandardMaterial within the subtree of root.
  recurseSetEnvMap(root: THREE.Object3D, envMap: THREE.Texture) {
    root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        if (Array.isArray(node.material)) {
          for (const material of node.material) {
            if (material instanceof THREE.MeshStandardMaterial) {
              material.envMap = envMap;
            }
          }
        } else {
          if (node.material instanceof THREE.MeshStandardMaterial) {
            node.material.envMap = envMap;
          }
        }
      }
    });
  }

  /** Depth-only companion mesh, created lazily and owned by this renderer. */
  get depthMesh(): THREE.Mesh {
    return this.ensureDepthMesh();
  }

  private assertBuiltInSplatShaders(enabled: boolean) {
    if (enabled && !this.supportsStochasticShaders) {
      throw new Error(
        "Stochastic and renderDepth modes require the built-in Splat shaders",
      );
    }
  }

  private refreshStochasticConfiguration() {
    this.requestMotionFollowup = false;
    if (this._stochastic) {
      this.stochasticMotion.reset();
      this.stochasticPhase = "forced";
    } else if (this.stochasticFrame) {
      this.stochasticMotion.requestSettle();
      this.stochasticPhase = "settling";
    } else {
      this.stochasticMotion.reset();
      this.stochasticPhase = null;
      this.stochasticWasForced = false;
    }
    this.applyStochasticRenderOrder();
    this.applyStochasticMaterialState(this.stochasticFrame);
    this.setDirty();
  }

  get premultipliedAlpha(): boolean {
    return this._premultipliedAlpha;
  }

  set premultipliedAlpha(value: boolean) {
    const nextValue = Boolean(value);
    if (this._premultipliedAlpha !== nextValue) {
      this._premultipliedAlpha = nextValue;
      this.uniforms.premultipliedAlpha.value = nextValue;
      this.material.premultipliedAlpha = nextValue;
      this.applyStochasticMaterialState(this.stochasticFrame);
      this.material.needsUpdate = true;
    }
  }

  get transparent(): boolean {
    return this._transparent;
  }

  set transparent(value: boolean) {
    const nextValue = Boolean(value);
    if (this._transparent !== nextValue) {
      this._transparent = nextValue;
      this.applyStochasticMaterialState(this.stochasticFrame);
    }
  }

  get autoStochastic(): boolean {
    return this._autoStochastic;
  }

  set autoStochastic(value: boolean) {
    const nextValue = Boolean(value);
    if (nextValue === this._autoStochastic) return;
    this.assertBuiltInSplatShaders(nextValue);
    this._autoStochastic = nextValue;
    this.refreshStochasticConfiguration();
  }

  get stochastic(): boolean {
    return this._stochastic;
  }

  /** Whether the current frame uses sorting-free stochastic transparency. */
  get stochasticActive(): boolean {
    return this.stochasticFrame;
  }

  [stochasticResolveMarker](enabled: boolean) {
    this.stochasticResolveMarkerUsers = Math.max(
      0,
      this.stochasticResolveMarkerUsers + (enabled ? 1 : -1),
    );
    this.uniforms.stochasticResolve.value =
      this.stochasticResolveMarkerUsers > 0;
  }

  [stochasticResolveRequired](
    camera: THREE.Camera,
    renderer: GaussianSplatCompatibleRenderer,
  ) {
    return (
      this.canRenderStochastic(renderer) &&
      (this._stochastic ||
        this.stochasticFrame ||
        this.stochasticMotion.wouldUseStochastic(camera))
    );
  }

  set stochastic(value: boolean) {
    const nextValue = Boolean(value);
    if (nextValue === this._stochastic) return;
    this.assertBuiltInSplatShaders(nextValue);
    this._stochastic = nextValue;
    this.refreshStochasticConfiguration();
  }

  get renderDepth(): boolean {
    return this._renderDepth;
  }

  set renderDepth(value: boolean) {
    const nextValue = Boolean(value);
    if (nextValue === this._renderDepth) return;
    this.assertBuiltInSplatShaders(nextValue);
    this._renderDepth = nextValue;
    this.applyStochasticRenderOrder();
    this.applyStochasticMaterialState(this.stochasticFrame);
    this.setDirty();
  }

  get depthTest(): boolean {
    return this._depthTest;
  }

  set depthTest(value: boolean) {
    this._depthTest = Boolean(value);
    this.applyStochasticMaterialState(this.stochasticFrame);
  }

  get depthWrite(): boolean {
    return this._depthWrite;
  }

  set depthWrite(value: boolean) {
    this._depthWrite = Boolean(value);
    this.applyStochasticRenderOrder();
    this.applyStochasticMaterialState(this.stochasticFrame);
  }
}

function isOpaqueMaterial(material: THREE.Material) {
  return (
    material.transparent === false &&
    material.blending === THREE.NormalBlending &&
    material.alphaToCoverage === false
  );
}
