import * as THREE from "three";

import type { GaussianSplatRenderer } from "../rendering/GaussianSplatRenderer";
import {
  type GaussianSplatCompatibleRenderer,
  assertSupportedRenderer,
  isWebGPURenderer,
  isXRRenderTarget,
  setRendererRenderTarget,
  setXRRenderTargetFlag,
} from "../rendering/rendererUtils";
import {
  stochasticResolveMarker,
  stochasticResolveRequired,
} from "../rendering/stochastic";
import { StochasticHistory } from "./StochasticHistory";

import {
  configureNodeResolveOutput,
  createNodeResolveMaterial,
} from "./tsl/ResolveMaterial";
import { createWebGLResolveMaterial } from "./webgl/ResolveMaterial";

/** Spatial kernel width and height in pixels; an integer of at least 2. */
const SPATIAL_FILTER_SIZE = 4;

export type ResolveState = {
  history: StochasticHistory;
  sourceTexture: { value: THREE.Texture };
  sourceDepth: { value: THREE.DepthTexture };
  sourceRect: THREE.Vector4;
  sourceViews: THREE.Vector4[];
  outputOrigins: THREE.Vector2[];
  outputOrigin: THREE.Vector2;
  copyDepth: { value: boolean };
  resolve: { value: boolean };
  sourceEncoded: { value: boolean };
};

/** Stochastic spatial and camera-motion filter bound to one Splat renderer. */
export class StochasticResolvePass {
  readonly isStochasticResolvePass = true;

  private _enabled = true;
  private _temporalEnabled = true;
  private disposed = false;
  private readonly sourceFallback = new THREE.DataTexture(
    new Float32Array([0, 0, 0, 0]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  private readonly state: ResolveState;
  private readonly depthFallback = new THREE.DepthTexture(1, 1);
  private readonly xrCamera = new THREE.ArrayCamera();
  private outputCamera: THREE.ArrayCamera | null = null;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly fullscreenCamera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    0,
    1,
  );
  private readonly historyViewport = new THREE.Vector4();
  private readonly webGLMaterial: THREE.ShaderMaterial;
  private readonly webGPUMaterial: ReturnType<typeof createNodeResolveMaterial>;
  private readonly webGLHistoryMaterial: THREE.ShaderMaterial;
  private readonly webGPUHistoryMaterial: ReturnType<
    typeof createNodeResolveMaterial
  >;
  private readonly mesh: THREE.Mesh;
  private readonly drawingBufferSize = new THREE.Vector2();
  private composeTarget: THREE.RenderTarget | null = null;

  constructor(private _splatRenderer: GaussianSplatRenderer) {
    this.sourceFallback.needsUpdate = true;
    this.state = {
      history: new StochasticHistory(this.sourceFallback, this.depthFallback),
      sourceTexture: { value: this.sourceFallback },
      sourceDepth: { value: this.depthFallback },
      sourceRect: new THREE.Vector4(0, 0, 1, 1),
      sourceViews: [],
      outputOrigins: [],
      outputOrigin: new THREE.Vector2(),
      copyDepth: { value: false },
      resolve: { value: false },
      sourceEncoded: { value: false },
    };

    this.webGLMaterial = createWebGLResolveMaterial(
      this.state,
      SPATIAL_FILTER_SIZE,
    );
    this.webGPUMaterial = createNodeResolveMaterial(
      this.state,
      SPATIAL_FILTER_SIZE,
    );
    this.webGLHistoryMaterial = createWebGLResolveMaterial(
      this.state,
      SPATIAL_FILTER_SIZE,
      true,
    );
    this.webGPUHistoryMaterial = createNodeResolveMaterial(
      this.state,
      SPATIAL_FILTER_SIZE,
      true,
    );

    this.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
    );
    this.mesh = new THREE.Mesh(this.geometry, this.webGLMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.layers.enableAll();
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      const index = this.outputCamera?.cameras.indexOf(
        camera as THREE.PerspectiveCamera,
      );
      const viewport = (camera as THREE.PerspectiveCamera).viewport;
      if (index !== undefined && index >= 0 && viewport) {
        this.state.sourceRect.copy(this.state.sourceViews[index]);
        this.state.outputOrigin.set(viewport.x, viewport.y);
        this.webGLMaterial.uniformsNeedUpdate = true;
      }
    };

    this.splatRenderer[stochasticResolveMarker](true);
  }

  get splatRenderer(): GaussianSplatRenderer {
    return this._splatRenderer;
  }

  set splatRenderer(value: GaussianSplatRenderer) {
    if (value === this._splatRenderer || this.disposed) return;
    if (this._enabled) this._splatRenderer[stochasticResolveMarker](false);
    this._splatRenderer = value;
    this.resetHistory();
    if (this._enabled) this._splatRenderer[stochasticResolveMarker](true);
  }

  /** Reproject history during camera movement in compose(). */
  get temporalEnabled(): boolean {
    return this._temporalEnabled;
  }

  set temporalEnabled(value: boolean) {
    const enabled = Boolean(value);
    if (enabled === this._temporalEnabled || this.disposed) return;
    this._temporalEnabled = enabled;
    this.resetHistory();
    if (!enabled) this.state.history.dispose();
  }

  /** Call after camera cuts or scene changes that should discard history. */
  resetHistory() {
    this.state.history.reset();
    if (this._enabled && !this.disposed) this.splatRenderer.setDirty();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    const enabled = Boolean(value);
    if (enabled === this._enabled || this.disposed) return;
    this._enabled = enabled;
    this.resetHistory();
    this.splatRenderer[stochasticResolveMarker](enabled);
  }

  private xrTarget(
    renderer: GaussianSplatCompatibleRenderer,
    target = renderer.getRenderTarget(),
  ) {
    if (!renderer.xr.isPresenting) return null;
    if (isWebGPURenderer(renderer)) {
      const output = renderer.getOutputRenderTarget();
      return target === null || target === output ? output : null;
    }
    return isXRRenderTarget(target) ? target : null;
  }

  /** Pack the eyes into one reusable 2D input, independent of XR layer layout. */
  private prepareXRViews(camera: THREE.ArrayCamera) {
    const renderCamera = this.xrCamera;
    renderCamera.copy(camera, false);
    renderCamera.matrixWorldAutoUpdate = false;
    renderCamera.cameras.length = camera.cameras.length;
    this.state.sourceViews.length = camera.cameras.length;
    this.state.outputOrigins.length = camera.cameras.length;
    let width = 0;
    let height = 0;
    camera.cameras.forEach((eye, i) => {
      const viewport = eye.viewport;
      if (!viewport) throw new Error("XR views must have a viewport");
      this.state.outputOrigins[i] ??= new THREE.Vector2();
      this.state.outputOrigins[i].set(viewport.x, viewport.y);
      this.state.sourceViews[i] ??= new THREE.Vector4();
      this.state.sourceViews[i].set(width, 0, viewport.z, viewport.w);
      renderCamera.cameras[i] ??= new THREE.PerspectiveCamera();
      const copy = renderCamera.cameras[i];
      copy.copy(eye, false);
      copy.matrixWorldAutoUpdate = false;
      copy.viewport = this.state.sourceViews[i];
      width += viewport.z;
      height = Math.max(height, viewport.w);
    });
    this.drawingBufferSize.set(width, height);
  }

  private prepareComposeTarget(
    renderer: GaussianSplatCompatibleRenderer,
    destination: THREE.RenderTarget | null,
  ) {
    const { x: width, y: height } = this.drawingBufferSize;
    if (!this.composeTarget) {
      this.composeTarget = new THREE.RenderTarget(width, height, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
      });
      this.composeTarget.texture.name = "StochasticResolvePass.composeColor";
    } else {
      this.composeTarget.setSize(width, height);
    }
    const target = this.composeTarget;
    if (
      (destination?.depthBuffer || this._temporalEnabled) &&
      !target.depthTexture
    ) {
      target.depthTexture = new THREE.DepthTexture(width, height);
      target.dispose();
    }

    // WebGL's canvas applies its sRGB conversion before fixed-function
    // blending. Marking this float target as an output target reproduces
    // that ordering, so transparent objects over Splats do not brighten.
    const sourceEncoded =
      !isWebGPURenderer(renderer) &&
      (destination === null || isXRRenderTarget(destination)) &&
      renderer.outputColorSpace === THREE.SRGBColorSpace;
    setXRRenderTargetFlag(target, sourceEncoded);
    target.texture.colorSpace = sourceEncoded
      ? THREE.SRGBColorSpace
      : THREE.NoColorSpace;
    return target;
  }

  /** Renders a complete scene, then resolves its marked Splat pixels. */
  compose(
    renderer: GaussianSplatCompatibleRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    if (this.disposed) throw new Error("StochasticResolvePass is disposed");
    assertSupportedRenderer(renderer);
    const previousTarget = renderer.getRenderTarget();
    const xrTarget = this.xrTarget(renderer);
    const destination = xrTarget ?? previousTarget;

    const previousAutoClear = renderer.autoClear;
    const previousXREnabled = renderer.xr.enabled;
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    try {
      if (!this._enabled) {
        this.state.history.reset();
        renderer.render(scene, camera);
        return;
      }

      // A WebGL canvas blends the library's stored sRGB Splat colors in the
      // output domain, while a regular offscreen target blends in working
      // linear space. Avoid that visible color change on already-sorted
      // frames, where there is nothing for this pass to resolve.
      camera.updateWorldMatrix(true, false);
      if (!this.splatRenderer[stochasticResolveRequired](camera, renderer)) {
        this.state.history.reset();
        renderer.render(scene, camera);
        return;
      }

      let renderCamera = camera;
      let outputCamera: THREE.ArrayCamera | null = null;
      if (xrTarget) {
        if (renderer.xr.cameraAutoUpdate)
          renderer.xr.updateCamera(camera as THREE.PerspectiveCamera);
        outputCamera = renderer.xr.getCamera();
        if (outputCamera.cameras.length === 0) return;
        this.prepareXRViews(outputCamera);
        renderCamera = this.xrCamera;
        // Render the packed eyes without Three replacing them with the XR views.
        renderer.xr.enabled = false;
      } else if (destination) {
        this.drawingBufferSize.set(destination.width, destination.height);
      } else {
        renderer.getDrawingBufferSize(this.drawingBufferSize);
      }
      const composeTarget = this.prepareComposeTarget(renderer, destination);

      renderer.autoClear = false;
      setRendererRenderTarget(renderer, composeTarget);
      renderer.clear(
        renderer.autoClearColor,
        renderer.autoClearDepth,
        renderer.autoClearStencil,
      );
      renderer.render(scene, renderCamera);
      this.resolveTarget(
        renderer,
        composeTarget,
        destination,
        renderCamera,
        outputCamera,
      );
    } catch (error) {
      this.state.history.reset();
      throw error;
    } finally {
      setRendererRenderTarget(
        renderer,
        previousTarget,
        previousCubeFace,
        previousMipmapLevel,
      );
      renderer.xr.enabled = previousXREnabled;
      renderer.autoClear = previousAutoClear;
    }
  }

  private resolveTarget(
    renderer: GaussianSplatCompatibleRenderer,
    input: THREE.RenderTarget,
    outputTarget: THREE.RenderTarget | null,
    camera: THREE.Camera,
    outputCamera: THREE.ArrayCamera | null,
  ) {
    // Preserve the existing output-depth contract independently of history.
    const copyDepth =
      !!outputTarget?.depthBuffer && input.depthTexture !== null;
    const { history } = this.state;
    let historyTarget: THREE.RenderTarget | null = null;
    if (this.splatRenderer.stochasticActive && this._temporalEnabled) {
      // compose() owns the input target and attaches its depth texture.
      historyTarget = history.begin(
        renderer,
        camera,
        input,
        outputCamera ? this.state.sourceViews : undefined,
      );
    } else {
      history.reset();
    }

    if (historyTarget) this.writeHistory(renderer, input, historyTarget);
    this.renderResolve(
      renderer,
      historyTarget ?? input,
      outputTarget,
      outputCamera,
      copyDepth,
      historyTarget ? "present" : "resolve",
    );
    if (historyTarget) history.commit();
  }

  private writeHistory(
    renderer: GaussianSplatCompatibleRenderer,
    input: THREE.RenderTarget,
    target: THREE.RenderTarget,
  ) {
    const { history } = this.state;
    this.historyViewport.copy(target.viewport);
    try {
      for (let i = 0; i < history.views.length; i++) {
        const rect = history.selectView(i);
        target.viewport.copy(rect);
        this.renderResolve(
          renderer,
          input,
          target,
          null,
          true,
          "history",
          rect,
        );
      }
    } finally {
      target.viewport.copy(this.historyViewport);
    }
  }

  private renderResolve(
    renderer: GaussianSplatCompatibleRenderer,
    input: THREE.RenderTarget,
    outputTarget: THREE.RenderTarget | null,
    outputCamera: THREE.ArrayCamera | null,
    copyDepth: boolean,
    mode: "resolve" | "history" | "present",
    sourceRect?: THREE.Vector4,
  ) {
    const writeHistory = mode === "history";
    const presentHistory = mode === "present";
    const xrOutput = outputCamera !== null;
    this.state.sourceTexture.value = input.texture;
    this.state.sourceRect.set(0, 0, input.width, input.height);
    this.state.outputOrigin.set(0, 0);
    if (sourceRect) {
      this.state.sourceRect.copy(sourceRect);
      this.state.outputOrigin.set(sourceRect.x, sourceRect.y);
    }
    this.state.copyDepth.value = copyDepth;
    this.state.sourceDepth.value =
      (copyDepth ? input.depthTexture : null) ?? this.depthFallback;
    this.state.resolve.value =
      !presentHistory && this.splatRenderer.stochasticActive;

    const webGPU = isWebGPURenderer(renderer);
    const sourceColorSpace =
      !webGPU && isXRRenderTarget(input)
        ? input.texture.colorSpace
        : THREE.ColorManagement.workingColorSpace;
    if (!presentHistory)
      this.state.sourceEncoded.value =
        !webGPU &&
        THREE.ColorManagement.getTransfer(sourceColorSpace) ===
          THREE.SRGBTransfer;

    const material = writeHistory
      ? webGPU
        ? this.webGPUHistoryMaterial
        : this.webGLHistoryMaterial
      : webGPU
        ? this.webGPUMaterial
        : this.webGLMaterial;
    if (material.depthWrite !== this.state.copyDepth.value)
      material.needsUpdate = true;
    material.depthTest = this.state.copyDepth.value;
    material.depthWrite = this.state.copyDepth.value;
    const reversed = webGPU
      ? renderer.reversedDepthBuffer
      : renderer.capabilities.reversedDepthBuffer;
    material.depthFunc = reversed ? THREE.NeverDepth : THREE.AlwaysDepth;
    this.mesh.material = material;

    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    const previousXREnabled = renderer.xr.enabled;
    const previousAutoClear = renderer.autoClear;
    const previousToneMapping = renderer.toneMapping;
    const previousColorSpace = renderer.outputColorSpace;
    try {
      this.outputCamera = outputCamera;
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      if (webGPU && !writeHistory) {
        configureNodeResolveOutput(
          this.webGPUMaterial,
          xrOutput ? previousToneMapping : THREE.NoToneMapping,
          xrOutput ? previousColorSpace : THREE.NoColorSpace,
        );
        if (xrOutput) {
          // Convert in the resolve shader so Three's output blit does not drop
          // the per-eye depth or allocate another full-resolution intermediate.
          renderer.toneMapping = THREE.NoToneMapping;
          renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
        }
      }
      setRendererRenderTarget(renderer, outputTarget);
      renderer.render(this.mesh, outputCamera ?? this.fullscreenCamera);
    } finally {
      setRendererRenderTarget(
        renderer,
        previousTarget,
        previousCubeFace,
        previousMipmapLevel,
      );
      this.outputCamera = null;
      renderer.xr.enabled = previousXREnabled;
      renderer.autoClear = previousAutoClear;
      renderer.toneMapping = previousToneMapping;
      renderer.outputColorSpace = previousColorSpace;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.enabled = false;
    this.webGLMaterial.dispose();
    this.webGPUMaterial.dispose();
    this.webGLHistoryMaterial.dispose();
    this.webGPUHistoryMaterial.dispose();
    this.state.history.dispose();
    this.geometry.dispose();
    this.sourceFallback.dispose();
    this.depthFallback.dispose();
    this.composeTarget?.dispose();
    this.composeTarget = null;
    this.disposed = true;
  }
}
