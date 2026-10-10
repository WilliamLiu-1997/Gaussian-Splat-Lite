import * as THREE from "three";
import { applyThreeR186Patch } from "../patches/threeR186.js";
import { SplatWorker } from "../runtime/SplatWorker.js";
import { resolveTimer } from "../utils/three.js";
import { MaterialState } from "./MaterialState.js";
import { SortCenterCache } from "./SortCenterCache.js";
import { SplatAccumulator } from "./SplatAccumulator.js";
import { SplatGeometry } from "./SplatGeometry.js";
import { configureSplatOutput, createSplatBackend } from "./backend.js";
import {
  assertSupportedRenderer,
  getMeanViewPose,
  getRenderFrame,
  getViews,
  isWebGPURenderer,
} from "./rendererUtils.js";
import { DEFAULT_MIN_ALPHA, makeSplatUniforms } from "./uniforms.js";
const renderToViewScaleTmp = new THREE.Vector3();
const renderToViewMatrixTmp = new THREE.Matrix4();
const renderTranslationTmp = new THREE.Matrix4();
const headPositionTmp = new THREE.Vector3();
const headTargetTmp = new THREE.Vector3();
const UNSUPPORTED_CAMERA =
  "GaussianSplatRenderer draws ArrayCamera only for WebXR; render other views with separate cameras";
/**
 * Whether the camera is the WebXR camera or one of its eyes. Presenting alone
 * is not enough: Three draws render targets with the caller's camera when
 * xr.enabled is off, and WebGPURenderer whenever the target is not its output.
 */
function isXRCamera(camera, renderer) {
  if (!renderer.xr.isPresenting) return false;
  const xrCamera = renderer.xr.getCamera();
  return camera === xrCamera || xrCamera.cameras.includes(camera);
}
/**
 * Multiple views are drawn only as WebXR eyes. Classic WebGL draws each view
 * of an ArrayCamera separately, as a camera with a viewport.
 */
function isSupportedCamera(camera, renderer) {
  return (
    isXRCamera(camera, renderer) ||
    (!camera.isArrayCamera && camera.viewport === undefined)
  );
}
function assertSupportedCamera(camera, renderer) {
  if (!isSupportedCamera(camera, renderer)) throw new Error(UNSUPPORTED_CAMERA);
}
// Average (uniform) world scale of a camera, read without updating it.
function getCameraWorldScale(camera) {
  const scale = renderToViewScaleTmp.setFromMatrixScale(camera.matrixWorld);
  return (scale.x + scale.y + scale.z) / 3;
}
export class GaussianSplatRenderer extends THREE.Mesh {
  constructor(options) {
    if (!options?.renderer) {
      throw new Error("renderer is required in GaussianSplatRenderer options");
    }
    assertSupportedRenderer(options.renderer);
    if (isWebGPURenderer(options.renderer))
      applyThreeR186Patch(options.renderer);
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
    this.materialState = new MaterialState(material);
    /** @internal False for a second renderer on the same scene, so each `onFrame` runs once per frame. */
    this.frameCallbacks = true;
    this.renderSize = new THREE.Vector2();
    /**
     * Noise pattern index, wrapped to uint32. Each value selects an independent
     * pattern. Disable autoAdvanceStochasticSample for manual control.
     */
    this.stochasticSample = 0;
    this.lastFrame = -1;
    this.updateTimeoutId = -1;
    this.orderingBuffer = new Uint32Array(0);
    // A CPU ordering matching the displayed accumulator; unsorted stochastic
    // updates display without one.
    this.orderingReady = false;
    // Mean pose of the WebXR eyes; see getGenerationCamera().
    this.headCamera = new THREE.PerspectiveCamera();
    this.maxSplats = 0;
    this.activeSplats = 0;
    this.accumulators = [];
    this.sorting = false;
    this.sortDirty = false;
    this.lastSortTime = 0;
    this.sortWorker = null;
    this.sortedCenter = new THREE.Vector3().setScalar(Number.NEGATIVE_INFINITY);
    this.sortedDir = new THREE.Vector3().setScalar(0);
    this.sortCenterCache = new SortCenterCache();
    this.sortStateRevision = 0;
    this.uploadedSortStateRevision = -1;
    this.updateRunning = false;
    this.updatePromise = Promise.resolve();
    this.queuedUpdate = null;
    this.disposed = false;
    this.unsupportedCameraReported = false;
    this.reportedRenderError = "";
    this.viewportSize = new THREE.Vector4();
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
      backend.projection.ready.then(() => {
        if (!this.disposed) this.setDirty();
      });
      // XR session end can reclaim the second eye's work storage.
      backend.projection.onViewsReleased = () => {
        if (!this.disposed) this.setDirty();
      };
    }
  }
  raycast(_raycaster, _intersects) {}
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
    this.resetSortWorker();
    this.orderingBuffer = new Uint32Array(0);
    this.orderingReady = false;
    this.maxSplats = 0;
    this.activeSplats = 0;
    this.backend.dispose();
    this.uniforms.stochasticNoise.value.dispose();
    const accumulators = new Set();
    accumulators.add(this.display);
    accumulators.add(this.current);
    for (const accumulator of this.accumulators) {
      accumulators.add(accumulator);
    }
    for (const accumulator of accumulators) {
      accumulator.dispose();
    }
    this.accumulators.length = 0;
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
  resetSortWorker() {
    this.sortWorker?.dispose();
    this.sortWorker = null;
    this.sortCenterCache.dispose();
    this.uploadedSortStateRevision = -1;
  }
  /**
   * Frees the worker, its sort state and the ordering, which unsorted draws
   * never read. Re-enabling sorting reallocates them and uploads centers.
   */
  releaseOrdering() {
    this.resetSortWorker();
    if (this.backend.kind !== "webgpu") this.backend.releaseOrdering();
    this.orderingBuffer = new Uint32Array(0);
    this.maxSplats = 0;
  }
  takeAccumulator() {
    return this.accumulators.pop() ?? new SplatAccumulator();
  }
  releaseAccumulator(accumulator) {
    this.accumulators.push(accumulator);
  }
  disposeOversizedAccumulators(maxSplats) {
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
  syncStochasticFrame() {
    const active =
      this.backend.kind === "webgpu" || this.display.numSplats === 0
        ? this._stochastic
        : this.display.hasStochasticSeeds;
    if (active === this.stochasticFrame) return;
    this.stochasticFrame = active;
    this.selectMaterial();
    this.setDirty();
  }
  selectMaterial() {
    const material = this.backend.selectMaterial(this.stochasticFrame);
    this.applyMaterialState(this.stochasticFrame, material);
    this.material = material;
  }
  applyMaterialState(stochasticActive, material = this.material) {
    this.materialState.sync(material, this.material);
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
    this.materialState.record(material);
  }
  runAutomaticUpdate(request, insideDraw = false) {
    try {
      void this.updateInternal(request, insideDraw).catch((error) =>
        this.reportRenderError(error),
      );
    } catch (error) {
      this.reportRenderError(error);
    }
  }
  reportRenderError(error) {
    const message = String(error);
    if (message !== this.reportedRenderError) {
      this.reportedRenderError = message;
      console.error("Gaussian Splat render failed", error);
    }
  }
  onBeforeRender(renderer, scene, camera) {
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
  prepareDraw(renderer, scene, camera) {
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
      camera.viewport ??
      (xrView ? getViews(updateCamera)[0].viewport : undefined);
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
        this.runAutomaticUpdate(updateRequest, true);
      } else if (this.updateTimeoutId === -1) {
        this.updateTimeoutId = setTimeout(() => {
          this.updateTimeoutId = -1;
          this.runAutomaticUpdate(updateRequest);
        }, 0);
      }
    }
    const typedCamera = camera;
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
      this.backend.projection.render(
        display,
        camera,
        geometry,
        this.sortRadial,
        this.fastSort,
      );
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
  async update({ scene, camera, excludedObjects }) {
    assertSupportedCamera(camera, this.renderer);
    this.reportedRenderError = "";
    if (this.backend.kind === "webgpu") {
      await this.backend.projection.ready;
      if (this.backend.projection.error) throw this.backend.projection.error;
    }
    await this.updateInternal({
      scene,
      camera,
      shrinkResources: false,
      excludedObjects,
    });
  }
  /** Updates the scene and compacts work and edit storage while retaining compiled kernels. */
  async shrinkResources({ scene, camera }) {
    assertSupportedCamera(camera, this.renderer);
    this.reportedRenderError = "";
    await this.updateInternal({
      scene,
      camera,
      shrinkResources: true,
    });
    if (this.backend.kind === "webgpu") {
      // An update can replace the accumulator while startup slots compile.
      await this.backend.projection.shrinkResources(
        () => this.current.numSplats,
      );
    }
    if (this.disposed) return;
    this.setDirty();
  }
  updateInternal(request, insideDraw = false) {
    if (this.disposed) return Promise.resolve();
    if (this.backend.kind === "webgpu") {
      const { scene, shrinkResources } = request;
      // Three.js updates the scene's world matrices before it draws.
      if (!insideDraw && scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
      if (!request.camera.isArrayCamera)
        request.camera.updateWorldMatrix(true, false);
      const camera = this.getGenerationCamera(request.camera);
      if (this.ownsTimer) this.timer.update();
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
        shrinkResources,
        excludedObjects: request.excludedObjects,
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
      excludedObjects: request.excludedObjects,
    };
    if (!this.updateRunning) {
      this.updateRunning = true;
      this.updatePromise = this.drainUpdates();
    }
    return this.updatePromise;
  }
  async drainUpdates() {
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
  async performUpdate({
    scene,
    camera: updateCamera,
    shrinkResources,
    excludedObjects,
  }) {
    const next = this.takeAccumulator();
    const renderer = this.renderer;
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (!updateCamera.isArrayCamera)
      updateCamera.updateWorldMatrix(true, false);
    if (this.ownsTimer) {
      this.timer.update();
    }
    // Read the mode when the update runs; queued requests may predate a switch.
    // Back-to-front for blending, front-to-back for stochastic overdraw, or
    // source order for unsorted stochastic draws.
    const mode = !this._stochastic
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
    let preparation;
    try {
      preparation = next.prepareGenerate({
        renderer,
        scene,
        timer: this.timer,
        camera,
        layerCamera: updateCamera,
        previous: this.current,
        frameCallbacks: this.frameCallbacks,
        shrinkResources,
        excludedObjects,
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
  getGenerationCamera(camera) {
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
  async driveSort(shrinkOrdering, forceSort, mode) {
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
      const cameraPosition = current.viewOrigin.toArray();
      const direction = current.viewDirection.toArray();
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
  get encodeLinear() {
    return this._encodeLinear;
  }
  set encodeLinear(value) {
    if (value === this._encodeLinear) return;
    this._encodeLinear = value;
    this.setDirty();
  }
  get premultipliedAlpha() {
    return this._premultipliedAlpha;
  }
  set premultipliedAlpha(value) {
    const nextValue = Boolean(value);
    if (this._premultipliedAlpha !== nextValue) {
      this._premultipliedAlpha = nextValue;
      this.applyMaterialState(this.stochasticFrame);
    }
  }
  get transparent() {
    return this._transparent;
  }
  set transparent(value) {
    const nextValue = Boolean(value);
    if (this._transparent !== nextValue) {
      this._transparent = nextValue;
      this.applyMaterialState(this.stochasticFrame);
    }
  }
  get fastSort() {
    return this._fastSort;
  }
  set fastSort(value) {
    const nextValue = Boolean(value);
    if (nextValue === this._fastSort) return;
    this._fastSort = nextValue;
    // Stochastic orderings sort front to back and ignore it.
    if (!this._stochastic && this.backend.kind !== "webgpu") {
      this.sortDirty = true;
    }
    this.setDirty();
  }
  get stochasticSort() {
    return this._stochasticSort;
  }
  set stochasticSort(value) {
    const nextValue = Boolean(value);
    if (nextValue === this._stochasticSort) return;
    this._stochasticSort = nextValue;
    if (this._stochastic && this.backend.kind !== "webgpu") {
      this.sortDirty = true;
    }
    this.setDirty();
  }
  get stochastic() {
    return this._stochastic;
  }
  /**
   * Whether Splats currently draw stochastically. It follows `stochastic`
   * once an update for the new mode is displayed.
   */
  get stochasticActive() {
    return this.stochasticFrame;
  }
  set stochastic(value) {
    const nextValue = Boolean(value);
    if (nextValue === this._stochastic) return;
    this._stochastic = nextValue;
    if (this.display.numSplats === 0) this.syncStochasticFrame();
    this.sortDirty = true;
    this.setDirty();
  }
  get depthTest() {
    return this._depthTest;
  }
  set depthTest(value) {
    this._depthTest = Boolean(value);
    this.applyMaterialState(this.stochasticFrame);
  }
  get depthWrite() {
    return this._depthWrite;
  }
  set depthWrite(value) {
    this._depthWrite = Boolean(value);
    this.applyMaterialState(this.stochasticFrame);
  }
}
function isOpaqueMaterial(material) {
  return (
    material.transparent === false &&
    material.blending === THREE.NormalBlending &&
    material.alphaToCoverage === false
  );
}
