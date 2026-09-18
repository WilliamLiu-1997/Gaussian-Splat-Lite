import * as THREE from "three";

import type { GaussianSplatRenderer } from "./GaussianSplatRenderer";
import { StochasticHistory } from "./StochasticHistory";
import {
  type GaussianSplatCompatibleRenderer,
  assertSupportedRenderer,
  isWebGPURenderer,
  isXRRenderTarget,
  setRendererRenderTarget,
  setXRRenderTargetFlag,
} from "./rendererUtils";
import {
  stochasticResolveMarker,
  stochasticResolveRequired,
  stochasticSampleIndex,
} from "./stochastic";

import {
  configureNodeResolveOutput,
  createNodeResolveMaterial,
} from "./tsl/ResolveMaterial";
import { createWebGLResolveMaterial } from "./webgl/ResolveMaterial";

export type ResolveState = {
  history: StochasticHistory;
  sourceTexture: { value: THREE.Texture };
  splatMask: { value: THREE.Texture };
  spatialStrength: { value: number };
  sourceDepth: { value: THREE.DepthTexture };
  sourceRect: THREE.Vector4;
  sourceViews: THREE.Vector4[];
  outputOrigins: THREE.Vector2[];
  outputOrigin: THREE.Vector2;
  copyDepth: { value: boolean };
  resolve: { value: boolean };
  resolveDepth: { value: boolean };
  sourceEncoded: { value: boolean };
  presentHistory: { value: boolean };
};

/**
 * Optional stochastic spatial and temporal filter bound to one Splat renderer. It is
 * structurally compatible with Three.js EffectComposer and can also be called
 * explicitly from a render graph.
 */
export class StochasticResolvePass {
  isPass = true;
  readonly isStochasticResolvePass = true;
  needsSwap = true;
  clear = false;
  renderToScreen = false;

  private _enabled = true;
  private _temporalEnabled = false;
  private historyVersion: number;
  private disposed = false;
  private readonly sourceFallback = new THREE.DataTexture(
    new Float32Array([0, 0, 0, 0]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  private readonly state: ResolveState;
  private readonly maskFallback = this.sourceFallback.clone();
  private readonly depthFallback = new THREE.DepthTexture(1, 1);
  private readonly xrCamera = new THREE.ArrayCamera();
  private outputCamera: THREE.ArrayCamera | null = null;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
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
    this.historyVersion = _splatRenderer.display.version;
    this.sourceFallback.needsUpdate = true;
    this.state = {
      history: new StochasticHistory(this.sourceFallback, this.depthFallback),
      sourceTexture: { value: this.sourceFallback },
      splatMask: { value: this.maskFallback },
      spatialStrength: { value: 1 },
      sourceDepth: { value: this.depthFallback },
      sourceRect: new THREE.Vector4(0, 0, 1, 1),
      sourceViews: [],
      outputOrigins: [],
      outputOrigin: new THREE.Vector2(),
      copyDepth: { value: false },
      resolve: { value: false },
      resolveDepth: { value: false },
      sourceEncoded: { value: false },
      presentHistory: { value: false },
    };

    this.webGLMaterial = createWebGLResolveMaterial(this.state);
    this.webGPUMaterial = createNodeResolveMaterial(this.state);
    this.webGLHistoryMaterial = createWebGLResolveMaterial(this.state, true);
    this.webGPUHistoryMaterial = createNodeResolveMaterial(this.state, true);

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
    this.historyVersion = value.display.version;
    this.resetHistory();
    if (this._enabled) this._splatRenderer[stochasticResolveMarker](true);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Experimental camera-reprojected history for non-XR compose(). */
  get temporalEnabled(): boolean {
    return this._temporalEnabled;
  }

  set temporalEnabled(value: boolean) {
    const enabled = Boolean(value);
    if (enabled === this._temporalEnabled || this.disposed) return;
    this._temporalEnabled = enabled;
    this.state.history.reset();
    if (!enabled) this.state.history.dispose();
    this.splatRenderer.setDirty();
  }

  /** Also requests accumulation frames through the Splat renderer's onDirty. */
  get needsHistoryFrame(): boolean {
    return (
      this._enabled && this._temporalEnabled && this.state.history.needsFrame
    );
  }

  /** Call after a camera cut or changes to other scene objects or lighting. */
  resetHistory() {
    this.state.history.reset();
    if (this._enabled && this._temporalEnabled && !this.disposed)
      this.splatRenderer.setDirty();
  }

  set enabled(value: boolean) {
    const enabled = Boolean(value);
    if (enabled === this._enabled || this.disposed) return;
    this._enabled = enabled;
    this.resetHistory();
    this.splatRenderer[stochasticResolveMarker](enabled);
  }

  setSize(_width: number, _height: number) {}

  private hasDepthCompanion() {
    const splat = this.splatRenderer;
    return (splat.autoStochastic || splat.renderDepth) && !splat.depthWrite;
  }

  private refreshHistorySource() {
    const version = this.splatRenderer.display.version;
    if (version !== this.historyVersion) {
      // Camera-dependent SH changes during movement; only stationary samples
      // require an unchanged source. Recheck after native preparation too.
      if (this.state.history.stationary.value) this.state.history.reset();
      this.historyVersion = version;
    }
  }

  private xrTarget(
    renderer: GaussianSplatCompatibleRenderer,
    target = renderer.getRenderTarget(),
  ) {
    if (!renderer.xr.isPresenting) return null;
    return isWebGPURenderer(renderer)
      ? renderer.getOutputRenderTarget()
      : isXRRenderTarget(target)
        ? target
        : null;
  }

  /** Pack the eyes into one reusable 2D input, independent of XR layer layout. */
  private prepareXRViews(
    camera: THREE.ArrayCamera,
    renderCamera?: THREE.ArrayCamera,
  ) {
    if (renderCamera) {
      renderCamera.copy(camera, false);
      renderCamera.matrixWorldAutoUpdate = false;
      renderCamera.cameras.length = camera.cameras.length;
    }
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
      if (renderCamera) {
        renderCamera.cameras[i] ??= new THREE.PerspectiveCamera();
        const copy = renderCamera.cameras[i];
        copy.copy(eye, false);
        copy.matrixWorldAutoUpdate = false;
        copy.viewport = this.state.sourceViews[i];
      }
      width += viewport.z;
      height = Math.max(height, viewport.w);
    });
    this.drawingBufferSize.set(width, height);
  }

  private prepareComposeTarget(
    renderer: GaussianSplatCompatibleRenderer,
    needsDepthTexture: boolean,
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
    if (needsDepthTexture && !target.depthTexture) {
      target.depthTexture = new THREE.DepthTexture(width, height);
      target.dispose();
    }

    // WebGL's canvas applies its sRGB conversion before fixed-function
    // blending. Marking this float target as an output target reproduces
    // that ordering, so transparent objects over Splats do not brighten.
    const sourceEncoded =
      !isWebGPURenderer(renderer) &&
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
    if (previousTarget !== null && previousTarget !== xrTarget) {
      throw new Error(
        "StochasticResolvePass.compose() renders to the canvas; use resolve() inside a custom render graph",
      );
    }

    const previousAutoClear = renderer.autoClear;
    const previousXREnabled = renderer.xr.enabled;
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    const temporal = this._temporalEnabled && !renderer.xr.isPresenting;
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
      if (
        !this.splatRenderer[stochasticResolveRequired](camera, renderer) &&
        !(temporal && this.hasDepthCompanion())
      ) {
        this.state.history.reset();
        renderer.render(scene, camera);
        return;
      }

      let renderCamera = camera;
      if (xrTarget) {
        if (renderer.xr.cameraAutoUpdate)
          renderer.xr.updateCamera(camera as THREE.PerspectiveCamera);
        const xrCamera = renderer.xr.getCamera();
        if (xrCamera.cameras.length === 0) return;
        this.prepareXRViews(xrCamera, this.xrCamera);
        renderCamera = this.xrCamera;
        // Render the packed eyes without Three replacing them with the XR views.
        renderer.xr.enabled = false;
      } else {
        renderer.getDrawingBufferSize(this.drawingBufferSize);
      }
      const composeTarget = this.prepareComposeTarget(
        renderer,
        xrTarget !== null || temporal,
      );

      if (temporal) {
        this.refreshHistorySource();
        // Wait for auto mode's sorted replacement before stationary averaging.
        const settling =
          !this.splatRenderer.stochastic && this.splatRenderer.stochasticActive;
        const sample = this.state.history.prepare(camera, settling);
        this.splatRenderer[stochasticSampleIndex](sample);
      }

      renderer.autoClear = false;
      setRendererRenderTarget(renderer, composeTarget);
      renderer.clear(
        renderer.autoClearColor,
        renderer.autoClearDepth,
        renderer.autoClearStencil,
      );
      renderer.render(scene, renderCamera);
      if (
        temporal &&
        (this.splatRenderer.stochasticActive || this.hasDepthCompanion())
      ) {
        this.refreshHistorySource();
        this.composeHistory(renderer, composeTarget, camera);
      } else {
        this.state.history.reset();
        this.resolve(renderer, composeTarget, xrTarget);
      }
    } finally {
      this.splatRenderer[stochasticSampleIndex](0);
      setRendererRenderTarget(
        renderer,
        previousTarget,
        previousCubeFace,
        previousMipmapLevel,
      );
      renderer.xr.enabled = previousXREnabled;
      renderer.autoClear = previousAutoClear;
    }
    if (this.needsHistoryFrame) this.splatRenderer.setDirty();
  }

  private composeHistory(
    renderer: GaussianSplatCompatibleRenderer,
    input: THREE.RenderTarget,
    camera: THREE.Camera,
  ) {
    const { history } = this.state;
    const target = history.begin(renderer, camera, input);
    const toneMapping = renderer.toneMapping;
    const sourceEncoded =
      !isWebGPURenderer(renderer) &&
      THREE.ColorManagement.getTransfer(
        isXRRenderTarget(input)
          ? input.texture.colorSpace
          : THREE.ColorManagement.workingColorSpace,
      ) === THREE.SRGBTransfer;
    try {
      this.resolve(renderer, input, target);
      history.active.value = false;
      this.state.presentHistory.value = true;
      // Presentation smoothing follows the counts just written by this frame.
      history.samples.value = target.textures[1];
      this.state.sourceEncoded.value = sourceEncoded;
      this.state.splatMask.value = input.texture;
      // Encoded WebGL scene colors already include tone mapping.
      if (sourceEncoded) renderer.toneMapping = THREE.NoToneMapping;
      this.resolve(renderer, target, null);
      history.commit(camera);
    } catch (error) {
      history.reset();
      throw error;
    } finally {
      history.active.value = false;
      this.state.presentHistory.value = false;
      renderer.toneMapping = toneMapping;
    }
  }

  /** EffectComposer-compatible entry point. Add this before OutputPass. */
  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    _deltaTime?: number,
    _maskActive?: boolean,
  ) {
    this.resolve(
      renderer,
      readBuffer,
      this.renderToScreen ? null : writeBuffer,
    );
  }

  /** Explicit WebGL/WebGPU render-graph entry point. */
  resolve(
    renderer: GaussianSplatCompatibleRenderer,
    input: THREE.RenderTarget,
    destination: THREE.RenderTarget | null,
  ) {
    if (this.disposed) throw new Error("StochasticResolvePass is disposed");
    assertSupportedRenderer(renderer);
    if (
      input.texture.type !== THREE.HalfFloatType &&
      input.texture.type !== THREE.FloatType
    ) {
      throw new Error(
        "StochasticResolvePass requires a HalfFloatType or FloatType input target",
      );
    }
    const width = input.width;
    const height = input.height;
    const xrTarget = this.xrTarget(renderer, destination ?? undefined);
    const xrOutput =
      xrTarget !== null && (destination === null || destination === xrTarget);
    const outputCamera = xrOutput ? renderer.xr.getCamera() : null;
    const outputTarget = xrOutput ? xrTarget : destination;
    if (outputTarget?.texture === input.texture) {
      throw new Error(
        "StochasticResolvePass input and destination must differ",
      );
    }
    if (outputCamera) {
      if (outputCamera.cameras.length === 0) return;
      this.prepareXRViews(outputCamera);
      if (
        width !== this.drawingBufferSize.x ||
        height !== this.drawingBufferSize.y
      ) {
        throw new Error(
          "XR resolve input must pack the eye viewports horizontally",
        );
      }
    } else if (destination) {
      if (destination.width !== width || destination.height !== height) {
        throw new Error(
          "StochasticResolvePass input and destination sizes must match",
        );
      }
    } else {
      renderer.getDrawingBufferSize(this.drawingBufferSize);
      if (
        this.drawingBufferSize.x !== width ||
        this.drawingBufferSize.y !== height
      ) {
        throw new Error(
          "StochasticResolvePass input and drawing-buffer sizes must match",
        );
      }
    }

    this.state.sourceTexture.value = input.texture;
    this.state.sourceRect.set(0, 0, width, height);
    this.state.outputOrigin.set(0, 0);
    this.state.sourceDepth.value =
      (this.state.presentHistory.value
        ? this.composeTarget?.depthTexture
        : input.depthTexture) ?? this.depthFallback;
    this.state.copyDepth.value =
      input.depthTexture !== null &&
      (this.state.history.active.value ||
        this.state.presentHistory.value ||
        (xrOutput && !!outputTarget?.depthBuffer));
    this.state.resolveDepth.value =
      this._enabled &&
      this.hasDepthCompanion() &&
      !this.splatRenderer.stochasticActive &&
      (this.state.history.active.value || this.state.presentHistory.value);
    this.state.resolve.value =
      this._enabled &&
      !this.state.presentHistory.value &&
      (this.splatRenderer.stochasticActive || this.state.resolveDepth.value);
    this.state.spatialStrength.value = this.state.presentHistory.value
      ? this.state.history.spatialWeight.value
      : 1;

    const webGPU = isWebGPURenderer(renderer);
    const sourceColorSpace =
      !webGPU && isXRRenderTarget(input)
        ? input.texture.colorSpace
        : THREE.ColorManagement.workingColorSpace;
    if (!this.state.presentHistory.value)
      this.state.sourceEncoded.value =
        !webGPU &&
        THREE.ColorManagement.getTransfer(sourceColorSpace) ===
          THREE.SRGBTransfer;

    const material = this.state.history.active.value
      ? webGPU
        ? this.webGPUHistoryMaterial
        : this.webGLHistoryMaterial
      : webGPU
        ? this.webGPUMaterial
        : this.webGLMaterial;
    material.depthTest = this.state.copyDepth.value;
    material.depthWrite = this.state.copyDepth.value;
    // r186 reverses AlwaysDepth to NeverDepth along with ordered comparisons.
    // Resolve must overwrite depth unconditionally on both depth conventions.
    const reversedDepth = webGPU
      ? renderer.reversedDepthBuffer
      : renderer.capabilities.reversedDepthBuffer;
    material.depthFunc = reversedDepth ? THREE.NeverDepth : THREE.AlwaysDepth;
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
      if (webGPU && !this.state.history.active.value) {
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
      if (this.clear) {
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
      }
      renderer.render(this.mesh, outputCamera ?? this.camera);
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
    this.maskFallback.dispose();
    this.depthFallback.dispose();
    this.composeTarget?.dispose();
    this.composeTarget = null;
    this.disposed = true;
  }
}
