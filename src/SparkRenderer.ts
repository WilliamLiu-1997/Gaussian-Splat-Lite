import * as THREE from "three";
import { Readback } from "./Readback";
import { SplatAccumulator } from "./SplatAccumulator";
import { SplatGeometry } from "./SplatGeometry";
import { SplatWorker } from "./SplatWorker";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "./defines";
import { getShaders } from "./shaders";
import { resolveTimer, uploadU32DataTextureRows } from "./utils";

const renderToViewScaleTmp = new THREE.Vector3();

// Average (uniform) world scale of a camera.
function getCameraWorldScale(camera: THREE.Camera): number {
  const scale = camera.getWorldScale(renderToViewScaleTmp);
  return (scale.x + scale.y + scale.z) / 3;
}

export interface SparkRendererOptions {
  /**
   * Pass in your THREE.WebGLRenderer instance so Spark can perform work
   * outside the usual render loop. Should be created with antialias: false
   * (default setting) as WebGL anti-aliasing doesn't improve Gaussian Splatting
   * rendering and significantly reduces performance.
   */
  renderer: THREE.WebGLRenderer;
  /**
   * Callback function to be called when SparkRenderer needs to re-render,
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
   * Whether to use extended Gsplat encoding for intermediary accumulator splats.
   * @default false
   */
  accumExtSplats?: boolean;
  /**
   * Whether to use covariance Gsplat encoding for intermediary splats.
   * @default false
   */
  covSplats?: boolean;
  /**
   * Minimum alpha value for splat rendering.
   * @default 0.5 * (1.0 / 255.0)
   */
  minAlpha?: number;
  /**
   * Enable 2D Gaussian splatting rendering ability. When this mode is enabled,
   * any scale x/y/z component that is exactly 0 (minimum quantized value) results
   * in the other two non-0 axis being interpreted as an oriented 2D Gaussian Splat,
   * rather instead of the usual projected 3DGS Z-slice. When reading PLY files,
   * scale values less than e^-30 will be interpreted as 0.
   * @default false
   */
  enable2DGS?: boolean;
  /**
   * Enable alternative ray-splat max response evaluation, used by 3DGUT (unscented transform),
   * 3DGRT, and HTGS.
   * @default false
   */
  // enableRayEval?: boolean;
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
   * Depth-of-field distance to focal plane
   */
  focalDistance?: number;
  /**
   * Full-width angle of aperture opening (in radians), 0.0 to disable
   * @default 0.0
   */
  apertureAngle?: number;
  /**
   * Modulate Gaussian kernel falloff. 0 means "no falloff, flat shading",
   * while 1 is the normal Gaussian kernel.
   * @default 1.0
   */
  falloff?: number;
  /**
   * X/Y clipping boundary factor for Gsplat centers against view frustum.
   * 1.0 clips any centers that are exactly out of bounds, while 1.4 clips
   * centers that are 40% beyond the bounds.
   * @default 1.4
   */
  clipXY?: number;
  /**
   * Parameter to adjust projected splat scale calculation to match other renderers,
   * similar to the same parameter in the MKellogg 3DGS renderer. Higher values will
   * tend to sharpen the splats. A value 2.0 can be used to match the behavior of
   * the PlayCanvas renderer.
   * @default 1.0
   */
  focalAdjustment?: number;
  /**
   * Whether to sort splats radially (geometric distance) from the viewpoint (true)
   * or by Z-depth (false). Most scenes are trained with the Z-depth `sort `metric
   * and will render more accurately at certain viewpoints. However, radial sorting
   * is more stable under viewpoint rotations.
   * @default true
   */
  sortRadial?: boolean;
  /**
   * Minimum interval between sort calls in milliseconds.
   * @default 0
   */
  minSortIntervalMs?: number;
  /**
   * Configures an offline render target for the SparkRenderer (as opposed to
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
   * second transparent render pass.
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

export class SparkRenderer extends THREE.Mesh {
  readonly renderer: THREE.WebGLRenderer;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: ReturnType<typeof SparkRenderer.makeUniforms>;

  autoUpdate: boolean;
  preUpdate: boolean;
  static sparkOverride?: SparkRenderer;

  renderSize = new THREE.Vector2();
  maxStdDev: number;
  minPixelRadius: number;
  maxPixelRadius: number;
  accumExtSplats: boolean;
  covSplats: boolean;
  minAlpha: number;
  enable2DGS: boolean;
  // enableRayEval: boolean;
  preBlurAmount: number;
  blurAmount: number;
  focalDistance: number;
  apertureAngle: number;
  falloff: number;
  clipXY: number;
  focalAdjustment: number;
  sortRadial: boolean;
  minSortIntervalMs: number;

  readonly timer: THREE.Timer;
  private readonly ownsTimer: boolean;
  lastFrame = -1;
  updateTimeoutId = -1;
  onDirty?: () => void;
  dirty: boolean;

  orderingTexture: THREE.DataTexture | null = null;
  maxSplats = 0;
  activeSplats = 0;

  display: SplatAccumulator;
  current: SplatAccumulator;
  accumulators: SplatAccumulator[] = [];

  sorting = false;
  sortDirty = false;
  lastSortTime = 0;
  sortWorker: SplatWorker | null = null;
  sortTimeoutId = -1;
  sortedCenter = new THREE.Vector3().setScalar(Number.NEGATIVE_INFINITY);
  sortedDir = new THREE.Vector3().setScalar(0);
  readback32 = new Uint32Array(0);

  target?: THREE.WebGLRenderTarget;
  backTarget?: THREE.WebGLRenderTarget;
  superPixels?: Uint8Array;
  targetPixels?: Uint8Array;
  superXY = 1;

  flushAfterGenerate = false;
  flushAfterRead = false;
  readPause = 1;
  sortPause = 0;
  sortDelay = 0;

  constructor(options: SparkRendererOptions) {
    if (!options) {
      throw new Error("SparkRenderer options are required");
    }
    if (!options.renderer) {
      throw new Error("renderer is required in SparkRenderer options");
    }

    const uniforms = SparkRenderer.makeUniforms();
    Object.assign(uniforms, options.extraUniforms ?? {});

    const shaders = getShaders();
    const premultipliedAlpha = options.premultipliedAlpha ?? true;
    const geometry = new SplatGeometry();
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: options.vertexShader ?? shaders.splatVertex,
      fragmentShader: options.fragmentShader ?? shaders.splatFragment,
      uniforms,
      premultipliedAlpha,
      transparent: options.transparent ?? true,
      depthTest: options.depthTest ?? true,
      depthWrite: options.depthWrite ?? false,
      side: THREE.DoubleSide,
      allowOverride: false,
    });

    super(geometry, material);
    this.material = material;
    this.uniforms = uniforms;
    // Disable frustum culling because we want to always draw them all
    // and cull Gsplats individually in the shader
    this.frustumCulled = false;

    // By default SparkRenderer will only render for layer 0
    // this.layers.enableAll();

    // sparkRendererInstance = this;
    this.renderer = options.renderer;
    this.onDirty = options.onDirty;
    this.dirty = true;
    this.autoUpdate = options.autoUpdate ?? true;
    this.preUpdate = options.preUpdate ?? true;

    this.maxStdDev = options.maxStdDev ?? Math.sqrt(8.0);
    this.minPixelRadius = options.minPixelRadius ?? 0.0; //1.6;
    this.maxPixelRadius = options.maxPixelRadius ?? 512.0;
    this.accumExtSplats = options.accumExtSplats ?? false;
    this.covSplats = options.covSplats ?? false;
    this.minAlpha = options.minAlpha ?? 0.5 * (1.0 / 255.0);
    this.enable2DGS = options.enable2DGS ?? false;
    // this.enableRayEval = options.enableRayEval ?? false;
    this.preBlurAmount = options.preBlurAmount ?? 0.0;
    this.blurAmount = options.blurAmount ?? 0.3;
    this.focalDistance = options.focalDistance ?? 0.0;
    this.apertureAngle = options.apertureAngle ?? 0.0;
    this.falloff = options.falloff ?? 1.0;
    this.clipXY = options.clipXY ?? 1.4;
    this.focalAdjustment = options.focalAdjustment ?? 1.0;
    this.sortRadial = options.sortRadial ?? true;
    this.minSortIntervalMs = options.minSortIntervalMs ?? 0;

    const { timer, ownsTimer } = resolveTimer(options.timer);
    this.timer = timer;
    this.ownsTimer = ownsTimer;

    const accumulatorOptions = {
      extSplats: this.accumExtSplats,
      covSplats: this.covSplats,
    };
    this.display = new SplatAccumulator(accumulatorOptions);
    this.current = this.display;
    this.accumulators.push(new SplatAccumulator(accumulatorOptions));
    this.accumulators.push(new SplatAccumulator(accumulatorOptions));

    // Check if the provoking vertex convention should be changed.
    const provokingVertexExt = this.renderer
      .getContext()
      .getExtension("WEBGL_provoking_vertex");
    if (provokingVertexExt) {
      provokingVertexExt.provokingVertexWEBGL(
        provokingVertexExt.FIRST_VERTEX_CONVENTION_WEBGL,
      );
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

  static makeUniforms() {
    const uniforms = {
      // // number of active splats to render
      // numSplats: { value: 0 },
      // Size of render viewport in pixels
      renderSize: { value: new THREE.Vector2() },
      // Near and far plane distances
      near: { value: 0.1 },
      far: { value: 1000.0 },
      // SplatAccumulator to view transformation quaternion
      renderToViewQuat: { value: new THREE.Quaternion() },
      // SplatAccumulator to view transformation translation
      renderToViewPos: { value: new THREE.Vector3() },
      // SplatAccumulator to view transformation uniform scale
      renderToViewScale: { value: 1 },
      renderToViewBasis: { value: new THREE.Matrix3() },
      renderToViewOffset: { value: new THREE.Vector3() },
      // Maximum distance (in stddevs) from Gsplat center to render
      maxStdDev: { value: 1.0 },
      // Minimum pixel radius for splat rendering
      minPixelRadius: { value: 0.0 },
      // Maximum pixel radius for splat rendering
      maxPixelRadius: { value: 512.0 },
      // Minimum alpha value for splat rendering
      minAlpha: { value: 0.5 * (1.0 / 255.0) },
      // Enable interpreting 0-thickness Gsplats as 2DGS
      enable2DGS: { value: false },
      // Enable ray-splat max response evaluation
      // enableRayEval: { value: false },
      // Add to projected 2D splat covariance diagonal (thickens and brightens)
      preBlurAmount: { value: 0.0 },
      // Add to 2D splat covariance diagonal and adjust opacity (anti-aliasing)
      blurAmount: { value: 0.3 },
      // Depth-of-field distance to focal plane
      focalDistance: { value: 0.0 },
      // Full-width angle of aperture opening (in radians)
      apertureAngle: { value: 0.0 },
      // Modulate Gaussian kernal falloff. 0 means "no falloff, flat shading",
      // 1 is normal e^-x^2 falloff.
      falloff: { value: 1.0 },
      // Clip Gsplats that are clipXY times beyond the +-1 frustum bounds
      clipXY: { value: 1.4 },
      // Debug renderSize scale factor
      focalAdjustment: { value: 1.0 },
      // Whether to encode Gsplat with linear RGB (for environment mapping)
      encodeLinear: { value: false },
      // Back-to-front sort ordering of splat indices
      ordering: { type: "t", value: SparkRenderer.emptyOrdering },
      enableExtSplats: { value: false },
      enableCovSplats: { value: false },
      // Gsplat collection to render
      extSplats: { type: "t", value: SplatAccumulator.emptyTexture },
      extSplats2: { type: "t", value: SplatAccumulator.emptyTexture },
      // Time in seconds for time-based effects
      time: { value: 0 },
      // Delta time in seconds since last frame
      deltaTime: { value: 0 },
      // Debug flag that alternates each frame
      debugFlag: { value: false },
    };
    return uniforms;
  }

  dispose() {
    if (this.target) {
      this.target.dispose();
      this.target = undefined;
    }
    if (this.backTarget) {
      this.backTarget.dispose();
      this.backTarget = undefined;
    }
    if (this.orderingTexture) {
      this.orderingTexture.dispose();
      this.orderingTexture = null;
    }

    const accumulators = new Set<SplatAccumulator>();
    accumulators.add(this.display);
    accumulators.add(this.current);
    for (const accumulator of this.accumulators) {
      accumulators.add(accumulator);
    }
    for (const accumulator of accumulators) {
      accumulator.dispose();
    }

    if (this.sortWorker) {
      this.sortWorker.dispose();
      this.sortWorker = null;
    }
  }

  setDirty() {
    if (!this.dirty) {
      this.dirty = true;
      this.onDirty?.();
    }
  }

  onBeforeRender(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    const spark = SparkRenderer.sparkOverride ?? this;

    const frame = renderer.info.render.frame;
    const isNewFrame = frame !== spark.lastFrame;
    spark.lastFrame = frame;

    const currentRenderTarget = renderer.getRenderTarget();
    const isXRRenderTarget = checkIsXRRenderTarget(currentRenderTarget);
    if (currentRenderTarget) {
      spark.renderSize.set(
        currentRenderTarget.width,
        currentRenderTarget.height,
      );

      // WebXR mode on Apple Vision Pro returns 1x1 when presenting.
      // Use a different means to figure out the render size.
      if (
        isXRRenderTarget &&
        spark.renderSize.x === 1 &&
        spark.renderSize.y === 1
      ) {
        const baseLayer = renderer.xr.getSession()?.renderState.baseLayer;
        if (baseLayer) {
          spark.renderSize.x = baseLayer.framebufferWidth;
          spark.renderSize.y = baseLayer.framebufferHeight;
        }
      }
    } else {
      renderer.getDrawingBufferSize(spark.renderSize);
    }
    this.uniforms.renderSize.value.copy(spark.renderSize);

    // Trigger update after refreshing renderSize but before any uniforms that
    // depend on the active accumulator, avoiding both size and display latency.
    if (spark.autoUpdate && isNewFrame) {
      const preUpdate = spark.preUpdate && !renderer.xr.isPresenting;
      let useCamera = camera;
      if (renderer.xr.isPresenting) {
        const xrCamera = renderer.xr.getCamera();
        // Keep the per-eye camera parented to the XR rig so its world transform
        // includes any scale applied to that rig.
        useCamera = xrCamera.cameras[0] ?? xrCamera;
      }
      if (preUpdate) {
        spark.updateInternal({
          scene,
          camera: useCamera,
          autoUpdate: true,
        });
      } else if (spark.updateTimeoutId === -1) {
        spark.updateTimeoutId = setTimeout(() => {
          spark.updateTimeoutId = -1;
          spark.updateInternal({
            scene,
            camera: useCamera,
            autoUpdate: true,
          });
        }, 1);
      }
    }

    const typedCamera = camera as
      | THREE.PerspectiveCamera
      | THREE.OrthographicCamera;

    this.uniforms.near.value = typedCamera.near;
    this.uniforms.far.value = typedCamera.far;

    const geometry = this.geometry as SplatGeometry;
    geometry.instanceCount = spark.activeSplats;

    const accumToWorld = new THREE.Matrix4();
    if (!this.display.extSplats) {
      accumToWorld.makeTranslation(spark.display.viewOrigin);
    }
    const cameraToWorld = camera.matrixWorld.clone();
    const worldToCamera = cameraToWorld.invert();
    const accumToCamera = worldToCamera.multiply(accumToWorld);
    accumToCamera.decompose(
      this.uniforms.renderToViewPos.value,
      this.uniforms.renderToViewQuat.value,
      renderToViewScaleTmp,
    );
    this.uniforms.renderToViewScale.value =
      (renderToViewScaleTmp.x +
        renderToViewScaleTmp.y +
        renderToViewScaleTmp.z) /
      3;
    this.uniforms.renderToViewBasis.value.setFromMatrix4(accumToCamera);

    this.uniforms.maxStdDev.value = spark.maxStdDev;
    this.uniforms.minPixelRadius.value = spark.minPixelRadius;
    this.uniforms.maxPixelRadius.value = spark.maxPixelRadius;
    this.uniforms.minAlpha.value = spark.minAlpha;
    this.uniforms.enable2DGS.value = spark.enable2DGS;
    // this.uniforms.enableRayEval.value = spark.enableRayEval;
    this.uniforms.preBlurAmount.value = spark.preBlurAmount;
    this.uniforms.blurAmount.value = spark.blurAmount;
    this.uniforms.focalDistance.value = spark.focalDistance;
    this.uniforms.apertureAngle.value = spark.apertureAngle;
    this.uniforms.falloff.value = spark.falloff;
    this.uniforms.clipXY.value = spark.clipXY;
    this.uniforms.focalAdjustment.value = spark.focalAdjustment;
    const outputColorSpace =
      currentRenderTarget === null
        ? renderer.outputColorSpace
        : isXRRenderTarget
          ? currentRenderTarget.texture.colorSpace
          : THREE.ColorManagement.workingColorSpace;
    this.uniforms.encodeLinear.value =
      outputColorSpace !== THREE.SRGBColorSpace;

    this.uniforms.ordering.value =
      spark.orderingTexture ?? SparkRenderer.emptyOrdering;
    this.uniforms.enableExtSplats.value = this.display.extSplats;
    this.uniforms.enableCovSplats.value = this.display.covSplats;
    if (this.display.extSplats) {
      const extSplats = spark.display.getTextures();
      this.uniforms.extSplats.value = extSplats[0];
      this.uniforms.extSplats2.value = extSplats[1];
    } else {
      const packedSplats = spark.display.getTextures();
      this.uniforms.extSplats.value = packedSplats[0];
      this.uniforms.extSplats2.value = packedSplats[0];
    }

    this.uniforms.time.value = spark.display.time;
    this.uniforms.deltaTime.value = spark.display.deltaTime;
    // Alternating debug flag that can aid in visual debugging
    this.uniforms.debugFlag.value = (performance.now() / 1000.0) % 2.0 < 1.0;

    spark.dirty = false;
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
    await this.updateInternal({ scene, camera, autoUpdate: false });
  }

  private async updateInternal({
    scene,
    camera,
    autoUpdate,
  }: {
    scene: THREE.Scene;
    camera: THREE.Camera;
    autoUpdate: boolean;
  }) {
    const renderer = this.renderer;
    if (this.ownsTimer) {
      this.timer.update();
    }

    const center = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());

    const viewChanged =
      center.distanceTo(this.sortedCenter) >
        0.001 * getCameraWorldScale(camera) || dir.dot(this.sortedDir) < 0.999;

    const next = this.accumulators.pop();
    if (!next) {
      // Should never happen
      throw new Error("No next accumulator");
    }
    if (next === this.current) {
      // Should never happen
      throw new Error(
        "Next accumulator is the same as the current accumulator",
      );
    }
    const { version, mappingVersion, generate } = next.prepareGenerate({
      renderer,
      scene,
      timer: this.timer,
      camera,
      sortRadial: this.sortRadial ?? true,
      renderSize: this.renderSize,
      previous: this.current,
    });

    let doUpdate = true;
    const needsUpdate = viewChanged || version !== this.current.version;
    const mappingUpdated = mappingVersion !== this.display.mappingVersion;

    if (autoUpdate && !needsUpdate) {
      // Triggered by auto-update but no change
      doUpdate = false;
    }

    if (mappingUpdated && this.sorting) {
      // We need to be able to sort the splats because the mapping has changed.
      // Try again next time around.
      doUpdate = false;
    }

    if (!doUpdate) {
      // Restore unused accumulator to the free list
      this.accumulators.push(next);
    } else {
      generate();

      if (this.flushAfterGenerate) {
        const gl = renderer.getContext() as WebGL2RenderingContext;
        gl.flush();
      }

      if (this.display.mappingVersion === next.mappingVersion) {
        // Same splat mapping so let's display it immediately and
        // reuse the sort order
        this.accumulators.push(this.display);
        this.display = next;
      } else {
        if (this.display !== this.current) {
          // The previous current is not being displayed, so replace it
          this.accumulators.push(this.current);
        }
      }

      this.current = next;
      this.sortDirty = true;
      this.setDirty();
    }

    await this.driveSort();
  }

  private async driveSort() {
    if (this.sorting || !this.sortDirty) {
      return;
    }

    if (this.sortTimeoutId !== -1) {
      clearTimeout(this.sortTimeoutId);
      this.sortTimeoutId = -1;
    }

    const now = performance.now();
    const nextSortTime = this.lastSortTime
      ? this.lastSortTime + this.minSortIntervalMs
      : now;
    if (now < nextSortTime) {
      this.sortTimeoutId = setTimeout(() => {
        this.sortTimeoutId = -1;
        this.driveSort();
      }, nextSortTime - now);
      return;
    }

    this.sorting = true;
    this.sortDirty = false;
    this.lastSortTime = now;

    if (this.readPause > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.readPause));
    }

    const current = this.current;

    this.sortedCenter.copy(current.viewOrigin);
    this.sortedDir.copy(current.viewDirection);

    const { numSplats, maxSplats } = current;
    const rows = Math.max(1, Math.ceil(maxSplats / 16384));
    const orderingMaxSplats = rows * 16384;
    this.maxSplats = Math.max(this.maxSplats, orderingMaxSplats);

    const ordering = new Uint32Array(this.maxSplats);
    const readback = Readback.ensureBuffer(maxSplats, this.readback32);
    this.readback32 = readback;

    await this.readbackDepth({
      current,
      renderer: this.renderer,
      numSplats,
      readback,
    });

    if (this.sortPause > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sortPause));
    }

    if (!this.sortWorker) {
      this.sortWorker = new SplatWorker();
    }
    const result = await this.sortWorker.call("sortSplats32", {
      numSplats,
      readback,
      ordering,
    });

    if (this.sortDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sortDelay));
    }

    this.readback32 = result.readback;

    this.activeSplats = result.activeSplats;

    if (this.orderingTexture) {
      if (rows > this.orderingTexture.image.height) {
        this.orderingTexture.dispose();
        this.orderingTexture = null;
      }
    }

    if (!this.orderingTexture) {
      // console.log(`Allocating orderingTexture: ${4096}x${rows}`);
      const orderingTexture = new THREE.DataTexture(
        result.ordering,
        4096,
        rows,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
      );
      orderingTexture.internalFormat = "RGBA32UI";
      orderingTexture.needsUpdate = true;
      this.orderingTexture = orderingTexture;
    } else {
      const renderer = this.renderer;
      if (!renderer.properties.has(this.orderingTexture)) {
        this.orderingTexture.needsUpdate = true;
      } else {
        uploadU32DataTextureRows(
          renderer,
          this.orderingTexture,
          4096,
          rows,
          result.ordering,
        );
      }
    }

    // console.log(`Sorted (${this.minSortIntervalMs}) ${numSplats} splats in ${(performance.now() - now).toFixed(0)} ms`);

    if (this.current.mappingVersion === current.mappingVersion) {
      if (this.current.mappingVersion !== this.display.mappingVersion) {
        this.accumulators.push(this.display);
        this.display = this.current;
      }
    }
    this.sorting = false;
    this.setDirty();

    this.driveSort();
  }

  private async readbackDepth({
    current,
    renderer,
    numSplats,
    readback,
  }: {
    current: SplatAccumulator;
    renderer: THREE.WebGLRenderer;
    numSplats: number;
    readback: Uint32Array;
  }) {
    if (!renderer) {
      throw new Error("No renderer");
    }
    if (!current.target) {
      throw new Error("No target");
    }

    const roundedCount =
      Math.ceil(numSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    if (readback.byteLength < roundedCount * 4) {
      throw new Error(
        `Readback buffer too small: ${readback.byteLength} < ${roundedCount * 4}`,
      );
    }
    const readbackUint8 = new Uint8Array(readback.buffer);
    const renderState = this.saveRenderState(renderer);

    // We can only read back one 2D array layer of pixels at a time,
    // so loop through them, initiate the readback, and collect the
    // completion promises.
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    let baseIndex = 0;
    const promises = [];

    while (baseIndex < numSplats) {
      const layer = Math.floor(baseIndex / layerSize);
      const layerBase = layer * layerSize;
      const layerYEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((numSplats - layerBase) / SPLAT_TEX_WIDTH),
      );

      // Compute the subarray that this layer of readback corresponds to
      const readbackSize = SPLAT_TEX_WIDTH * layerYEnd * 4;
      const subReadback = readbackUint8.subarray(
        layerBase * 4,
        layerBase * 4 + readbackSize,
      );
      renderer.setRenderTarget(current.target, layer);

      const promise = renderer.readRenderTargetPixelsAsync(
        current.target,
        0,
        0,
        SPLAT_TEX_WIDTH,
        layerYEnd,
        subReadback,
        undefined,
        current.extSplats ? 2 : 1,
      );
      promises.push(promise);

      if (this.flushAfterRead) {
        const gl = renderer.getContext() as WebGL2RenderingContext;
        gl.flush();
      }

      baseIndex += SPLAT_TEX_WIDTH * layerYEnd;
    }

    this.resetRenderState(renderer, renderState);
    return Promise.all(promises).then(() => readback);
  }

  private saveRenderState(renderer: THREE.WebGLRenderer) {
    return {
      target: renderer.getRenderTarget(),
      xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear,
    };
  }

  private resetRenderState(
    renderer: THREE.WebGLRenderer,
    state: {
      target: THREE.WebGLRenderTarget | null;
      xrEnabled: boolean;
      autoClear: boolean;
    },
  ) {
    renderer.setRenderTarget(state.target);
    renderer.xr.enabled = state.xrEnabled;
    renderer.autoClear = state.autoClear;
  }

  private static emptyOrdering = (() => {
    const numIndices = 4 * 4096 * 1;
    const emptyArray = new Uint32Array(numIndices);
    const texture = new THREE.DataTexture(emptyArray, 4096, 1);
    texture.format = THREE.RGBAIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RGBA32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  render(scene: THREE.Scene, camera: THREE.Camera) {
    try {
      SparkRenderer.sparkOverride = this;
      this.renderer.render(scene, camera);
    } finally {
      SparkRenderer.sparkOverride = undefined;
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
    try {
      this.renderer.setRenderTarget(target);
      SparkRenderer.sparkOverride = this;
      this.renderer.render(scene, camera);
    } finally {
      SparkRenderer.sparkOverride = undefined;
      this.renderer.setRenderTarget(previousTarget);
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

    await this.renderer.readRenderTargetPixelsAsync(
      this.target,
      0,
      0,
      width,
      height,
      superPixels,
    );

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
  private static pmrem: THREE.PMREMGenerator | null = null;

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
      !SparkRenderer.cubeRender ||
      SparkRenderer.cubeRender.target.width !== size ||
      SparkRenderer.cubeRender.near !== near ||
      SparkRenderer.cubeRender.far !== far
    ) {
      if (SparkRenderer.cubeRender) {
        SparkRenderer.cubeRender.target.dispose();
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
      SparkRenderer.cubeRender = { target, cubeCamera, near, far };
    }

    const { target, cubeCamera } = SparkRenderer.cubeRender;
    cubeCamera.position.copy(worldCenter);

    // Save the visibility state of objects we want to hide before render
    const objectVisibility = new Map<THREE.Object3D, boolean>();
    for (const object of hideObjects) {
      objectVisibility.set(object, object.visible);
      object.visible = false;
    }

    if (update) {
      const tempCamera = new THREE.Camera();
      tempCamera.position.copy(worldCenter);
      await this.update({ scene, camera: tempCamera });
    }

    try {
      SparkRenderer.sparkOverride = this;
      // Update the CubeCamera, which performs 6 cube face renders
      cubeCamera.update(this.renderer, scene);
    } finally {
      SparkRenderer.sparkOverride = undefined;
    }

    // Restore viewpoint to default and object visibility
    for (const [object, visible] of objectVisibility.entries()) {
      object.visible = visible;
    }

    return target.texture;
  }

  async readCubeTargets(): Promise<Uint8Array[]> {
    if (!SparkRenderer.cubeRender) {
      throw new Error("No cube render");
    }

    const textures = SparkRenderer.cubeRender.target.texture;
    const promises = [];
    const buffers = [];

    for (let i = 0; i < textures.images.length; ++i) {
      const { width, height } = textures.images[i];
      const byteSize = width * height * 4;
      const readback = new Uint8Array(byteSize);
      buffers.push(readback);
      const promise = this.renderer.readRenderTargetPixelsAsync(
        SparkRenderer.cubeRender.target,
        0,
        0,
        width,
        height,
        readback,
        i,
      );
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
    if (!SparkRenderer.pmrem) {
      SparkRenderer.pmrem = new THREE.PMREMGenerator(this.renderer);
    }

    return SparkRenderer.pmrem?.fromCubemap(cubeTexture).texture;
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

  get premultipliedAlpha(): boolean {
    return this.material.premultipliedAlpha;
  }

  set premultipliedAlpha(value: boolean) {
    if (this.material.premultipliedAlpha !== value) {
      this.material.premultipliedAlpha = value;
      this.material.needsUpdate = true;
    }
  }
}

function checkIsXRRenderTarget(renderTarget: THREE.RenderTarget | null) {
  return (renderTarget as unknown as Record<string, boolean>)?.isXRRenderTarget;
}
