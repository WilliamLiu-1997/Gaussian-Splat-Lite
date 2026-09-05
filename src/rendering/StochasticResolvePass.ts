import * as THREE from "three";

import type { GaussianSplatRenderer } from "./GaussianSplatRenderer";
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
} from "./stochastic";

import { createWebGLResolveMaterial } from "./webgl/ResolveMaterial";
import {
  configureWebGPUResolveOutput,
  createWebGPUResolveMaterial,
} from "./webgpu/ResolveMaterial";

export type ResolveState = {
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

/**
 * Optional stochastic spatial filter. It is structurally compatible with
 * Three.js EffectComposer and can also be called explicitly from a render graph.
 */
export class StochasticResolvePass {
  isPass = true;
  readonly isStochasticResolvePass = true;
  needsSwap = true;
  clear = false;
  renderToScreen = false;

  private _enabled = true;
  private disposed = false;
  private readonly splats = new Set<GaussianSplatRenderer>();
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
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly webGLMaterial: THREE.ShaderMaterial;
  private readonly webGPUMaterial: ReturnType<
    typeof createWebGPUResolveMaterial
  >;
  private readonly mesh: THREE.Mesh;
  private readonly drawingBufferSize = new THREE.Vector2();
  private composeTarget: THREE.RenderTarget | null = null;

  constructor(splats: GaussianSplatRenderer | Iterable<GaussianSplatRenderer>) {
    this.sourceFallback.needsUpdate = true;
    this.state = {
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

    this.webGLMaterial = createWebGLResolveMaterial(this.state);
    this.webGPUMaterial = createWebGPUResolveMaterial(this.state);

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

    if (Symbol.iterator in Object(splats)) {
      for (const splat of splats as Iterable<GaussianSplatRenderer>) {
        this.addSplatRenderer(splat);
      }
    } else {
      this.addSplatRenderer(splats as GaussianSplatRenderer);
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    const enabled = Boolean(value);
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    for (const splat of this.splats) {
      splat[stochasticResolveMarker](enabled);
    }
  }

  addSplatRenderer(splat: GaussianSplatRenderer) {
    if (this.disposed) throw new Error("StochasticResolvePass is disposed");
    if (this.splats.has(splat)) return;
    this.splats.add(splat);
    if (this._enabled) splat[stochasticResolveMarker](true);
  }

  removeSplatRenderer(splat: GaussianSplatRenderer): boolean {
    if (!this.splats.delete(splat)) return false;
    if (this._enabled) splat[stochasticResolveMarker](false);
    return true;
  }

  setSize(_width: number, _height: number) {}

  private requiresResolve(
    camera: THREE.Camera,
    renderer: GaussianSplatCompatibleRenderer,
  ) {
    for (const splat of this.splats) {
      if (splat[stochasticResolveRequired](camera, renderer)) return true;
    }
    return false;
  }

  private hasActiveStochasticSplat() {
    for (const splat of this.splats) {
      if (splat.stochasticActive) return true;
    }
    return false;
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
    try {
      if (!this._enabled) {
        renderer.render(scene, camera);
      } else {
        // A WebGL canvas blends the library's stored sRGB Splat colors in the
        // output domain, while a regular offscreen target blends in working
        // linear space. Avoid that visible color change on already-sorted
        // frames, where there is nothing for this pass to resolve.
        camera.updateWorldMatrix(true, false);
        if (!this.requiresResolve(camera, renderer)) {
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
        const width = this.drawingBufferSize.x;
        const height = this.drawingBufferSize.y;
        if (!this.composeTarget) {
          this.composeTarget = new THREE.RenderTarget(width, height, {
            type: THREE.HalfFloatType,
            depthBuffer: true,
          });
          this.composeTarget.texture.name =
            "StochasticResolvePass.composeColor";
        } else {
          this.composeTarget.setSize(width, height);
        }
        if (xrTarget && !this.composeTarget.depthTexture) {
          this.composeTarget.depthTexture = new THREE.DepthTexture(
            width,
            height,
          );
          this.composeTarget.dispose();
        }

        // WebGL's canvas applies its sRGB conversion before fixed-function
        // blending. Marking this float target as an output target reproduces
        // that ordering, so transparent objects over Splats do not brighten.
        const sourceEncoded =
          !isWebGPURenderer(renderer) &&
          renderer.outputColorSpace === THREE.SRGBColorSpace;
        const composeTarget = this.composeTarget;
        setXRRenderTargetFlag(composeTarget, sourceEncoded);
        composeTarget.texture.colorSpace = sourceEncoded
          ? THREE.SRGBColorSpace
          : THREE.NoColorSpace;

        renderer.autoClear = false;
        setRendererRenderTarget(renderer, this.composeTarget);
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
        renderer.render(scene, renderCamera);
        this.resolve(renderer, this.composeTarget, xrTarget);
      }
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
    if (outputTarget === input || outputTarget?.texture === input.texture) {
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
    this.state.sourceDepth.value = input.depthTexture ?? this.depthFallback;
    this.state.copyDepth.value =
      xrOutput && !!outputTarget?.depthBuffer && input.depthTexture !== null;
    this.state.resolve.value = this._enabled && this.hasActiveStochasticSplat();

    const webGPU = isWebGPURenderer(renderer);
    const sourceColorSpace =
      !webGPU && isXRRenderTarget(input)
        ? input.texture.colorSpace
        : THREE.ColorManagement.workingColorSpace;
    this.state.sourceEncoded.value =
      !webGPU &&
      THREE.ColorManagement.getTransfer(sourceColorSpace) ===
        THREE.SRGBTransfer;

    const material = webGPU ? this.webGPUMaterial : this.webGLMaterial;
    material.depthTest = this.state.copyDepth.value;
    material.depthWrite = this.state.copyDepth.value;
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
      if (webGPU) {
        configureWebGPUResolveOutput(this.webGPUMaterial, renderer, xrOutput);
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
    if (this._enabled) {
      for (const splat of this.splats) {
        splat[stochasticResolveMarker](false);
      }
    }
    this.splats.clear();
    this.webGLMaterial.dispose();
    this.webGPUMaterial.dispose();
    this.geometry.dispose();
    this.sourceFallback.dispose();
    this.depthFallback.dispose();
    this.composeTarget?.dispose();
    this.composeTarget = null;
    this.disposed = true;
  }
}
