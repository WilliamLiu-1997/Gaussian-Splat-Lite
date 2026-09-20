import * as THREE from "three";
import type { GaussianSplatRenderer } from "../rendering/GaussianSplatRenderer";
import {
  type GaussianSplatCompatibleRenderer,
  assertSupportedRenderer,
  isWebGPURenderer,
  isXRRenderTarget,
  setRendererRenderTarget,
} from "../rendering/rendererUtils";
import {
  stochasticResolveMarker,
  stochasticResolveRequired,
  stochasticTemporalSample,
} from "../rendering/stochastic";
import { createTAAPresentation } from "./TAAPresentation";
import { createNodeTAAPipeline } from "./tsl/TAAPipeline";
import { createWebGLTAAPipeline } from "./webgl/TAAPipeline";

const SAMPLES = 8;

function halton(index: number, base: number) {
  let result = 0;
  let fraction = 1;
  let remaining = index;
  while (remaining > 0) {
    fraction /= base;
    result += fraction * (remaining % base);
    remaining = Math.floor(remaining / base);
  }
  return result;
}

type TAAPipeline = ReturnType<
  typeof createNodeTAAPipeline | typeof createWebGLTAAPipeline
>;
type TAAView = {
  sourceCamera: THREE.Camera;
  camera: THREE.Camera;
  rect: THREE.Vector4;
  size: THREE.Vector2;
  sample: THREE.Vector4;
  projection: THREE.Matrix4;
  pipeline: TAAPipeline;
};

/** Selective stochastic TAA with independent histories for each camera view. */
export class StochasticTAAPass {
  readonly isStochasticTAAPass = true;
  private _enabled = true;
  private disposed = false;
  private views: TAAView[] = [];
  private presentation: ReturnType<typeof createTAAPresentation> | null = null;
  private renderer: GaussianSplatCompatibleRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private xrSession: object | null = null;
  private readonly viewport = new THREE.Vector4();
  private colorConfiguration = "";
  private frame = 0;
  private framesRemaining = 0;

  constructor(private _splatRenderer: GaussianSplatRenderer) {
    this._splatRenderer[stochasticResolveMarker](true);
  }

  get splatRenderer() {
    return this._splatRenderer;
  }

  set splatRenderer(value: GaussianSplatRenderer) {
    if (value === this._splatRenderer || this.disposed) return;
    if (this._enabled) this._splatRenderer[stochasticResolveMarker](false);
    this._splatRenderer = value;
    if (this._enabled) value[stochasticResolveMarker](true);
    this.resetHistory();
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled || this.disposed) return;
    this._enabled = value;
    this._splatRenderer[stochasticResolveMarker](value);
    this.resetHistory();
  }

  /** Whether a render-on-demand loop still has stochastic samples to draw. */
  get needsRender() {
    return this._enabled && this.framesRemaining > 0;
  }

  /** Schedule another 8 samples after scene/camera updates. */
  requestRender() {
    this.framesRemaining = SAMPLES;
  }

  /** Discard history after camera cuts, model edits or rendering-option changes. */
  resetHistory() {
    this.frame = 0;
    for (const view of this.views) view.pipeline.reset();
    this.requestRender();
  }

  compose(
    renderer: GaussianSplatCompatibleRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    if (this.disposed) throw new Error("StochasticTAAPass is disposed");
    assertSupportedRenderer(renderer);
    if (!this._enabled) {
      renderer.render(scene, camera);
      return;
    }
    camera.updateWorldMatrix(true, false);
    const previousTarget = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipmapLevel = renderer.getActiveMipmapLevel();
    let destination = previousTarget;
    let xrOutput = false;
    if (renderer.xr.isPresenting) {
      if (isWebGPURenderer(renderer)) {
        const target = renderer.getOutputRenderTarget();
        if (previousTarget === null || previousTarget === target) {
          destination = target;
          xrOutput = true;
        }
      } else {
        xrOutput = isXRRenderTarget(previousTarget);
      }
    }
    let renderCamera = camera;
    if (xrOutput) {
      if (renderer.xr.cameraAutoUpdate)
        renderer.xr.updateCamera(camera as THREE.PerspectiveCamera);
      renderCamera = renderer.xr.getCamera();
    }
    const eyes = (renderCamera as THREE.ArrayCamera).isArrayCamera
      ? (renderCamera as THREE.ArrayCamera)
      : null;
    const cameras = eyes ? eyes.cameras : [camera];
    if (cameras.length === 0) return;
    const outputEncoded = destination === null || xrOutput;
    const configuration = `${THREE.ColorManagement.workingColorSpace}/${renderer.outputColorSpace}/${renderer.toneMapping}/${renderer.toneMappingExposure}/${outputEncoded}/${xrOutput}`;
    if (
      this.renderer !== renderer ||
      this.scene !== scene ||
      this.camera !== renderCamera ||
      this.views.length !== cameras.length ||
      this.views.some((view, i) => view.sourceCamera !== cameras[i])
    ) {
      this.disposeViews();
      this.renderer = renderer;
      this.scene = scene;
      this.camera = renderCamera;
      this.views = cameras.map((sourceCamera) => {
        const viewCamera = eyes
          ? new (sourceCamera.constructor as new () => THREE.Camera)().copy(
              sourceCamera,
              false,
            )
          : sourceCamera;
        if (eyes)
          (viewCamera as THREE.PerspectiveCamera).viewport =
            new THREE.Vector4();
        const sample = new THREE.Vector4();
        const size = new THREE.Vector2();
        const pipeline = isWebGPURenderer(renderer)
          ? createNodeTAAPipeline(
              renderer,
              scene,
              viewCamera,
              sample,
              size,
              () => this.splatRenderer.stochasticActive,
            )
          : createWebGLTAAPipeline(
              renderer,
              scene,
              viewCamera,
              sample,
              size,
              () => this.splatRenderer.stochasticActive,
            );
        return {
          sourceCamera,
          camera: viewCamera,
          rect: new THREE.Vector4(),
          size,
          sample,
          projection: new THREE.Matrix4(),
          pipeline,
        };
      });
      this.presentation = createTAAPresentation(renderer, this.views);
      this.resetHistory();
    }
    const session = xrOutput ? renderer.xr.getSession() : null;
    if (
      configuration !== this.colorConfiguration ||
      session !== this.xrSession
    ) {
      this.xrSession = session;
      this.resetHistory();
      this.colorConfiguration = configuration;
    }
    if (!eyes) {
      if (destination) this.viewport.copy(destination.viewport);
      else
        renderer
          .getViewport(this.viewport)
          .multiplyScalar(renderer.getPixelRatio())
          .floor();
    }
    for (const view of this.views) {
      const rect = eyes
        ? (view.sourceCamera as THREE.PerspectiveCamera).viewport
        : this.viewport;
      if (!rect || rect.z <= 0 || rect.w <= 0)
        throw new Error("TAA views require a non-empty viewport");
      if (
        !view.rect.equals(rect) ||
        !view.projection.equals(view.sourceCamera.projectionMatrix)
      )
        this.resetHistory();
      view.rect.copy(rect);
      view.size.set(rect.z, rect.w);
      view.projection.copy(view.sourceCamera.projectionMatrix);
      if (eyes) {
        view.camera.copy(view.sourceCamera, false);
        view.camera.matrixWorldAutoUpdate = false;
        // Camera.copy() omits this flag. Without it Three rebuilds a reversed
        // eye projection and loses the XR runtime's asymmetric frustum.
        (
          view.camera as THREE.Camera & { _reversedDepth: boolean }
        )._reversedDepth = view.sourceCamera.reversedDepth;
        // Each view renders into its own origin-zero texture, preserving the
        // eye's asymmetric projection and world transform.
        (
          view.camera as THREE.Camera & { viewport: THREE.Vector4 }
        ).viewport.set(0, 0, rect.z, rect.w);
      }
    }
    const stochastic = this.splatRenderer[stochasticResolveRequired](
      camera,
      renderer,
    );
    const toneMapping = renderer.toneMapping;
    const colorSpace = renderer.outputColorSpace;
    const xrEnabled = renderer.xr.enabled;
    const autoClear = renderer.autoClear;
    const index = this.frame % SAMPLES;
    try {
      renderer.xr.enabled = false;
      for (const view of this.views) {
        const { sample, size, pipeline } = view;
        sample.set(
          (2 * (halton(index + 1, 2) - 0.5)) / size.x,
          (2 * (halton(index + 1, 3) - 0.5)) / size.y,
          (index * 17) % 32,
          (index * 29) % 32,
        );
        if (!stochastic) sample.set(0, 0, 0, 0);
        this.splatRenderer[stochasticTemporalSample](sample);
        pipeline.render(outputEncoded);
      }
      this.presentation?.render(destination, outputEncoded);
      this.frame++;
      this.framesRemaining = Math.max(0, this.framesRemaining - 1);
      if (!this.splatRenderer.stochasticActive) {
        this.frame = 0;
        this.framesRemaining = 0;
      }
    } catch (error) {
      this.resetHistory();
      throw error;
    } finally {
      for (const view of this.views) view.sample.set(0, 0, 0, 0);
      this.splatRenderer[stochasticTemporalSample](this.views[0].sample);
      setRendererRenderTarget(renderer, previousTarget, cubeFace, mipmapLevel);
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = colorSpace;
      renderer.xr.enabled = xrEnabled;
      renderer.autoClear = autoClear;
    }
  }

  private disposeViews() {
    this.presentation?.dispose();
    this.presentation = null;
    for (const view of this.views) view.pipeline.dispose();
    this.views = [];
  }

  dispose() {
    if (this.disposed) return;
    this.enabled = false;
    this.disposeViews();
    this.disposed = true;
  }
}
