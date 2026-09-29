import type * as THREE from "three";
import type { GaussianSplatRenderer } from "../rendering/GaussianSplatRenderer";
import { splatLayerAttach } from "../rendering/SplatLayer";
import { createSplatLayerViews } from "../rendering/SplatLayerViews";
import {
  type GaussianSplatCompatibleRenderer,
  assertSupportedRenderer,
  isWebGPURenderer,
  setRendererRenderTarget,
} from "../rendering/rendererUtils";
import {
  stochasticResolveRequired,
  stochasticTemporalFrame,
} from "../rendering/stochastic";
import { TAA_SAMPLES } from "./TAAHistory";
import { createNodeTAAPipeline } from "./tsl/TAAPipeline";
import { createWebGLTAAPipeline } from "./webgl/TAAPipeline";

/**
 * Independent Splat histories: temporal accumulation at rest and spatial/temporal
 * reconstruction in motion. Ordinary geometry is composed outside the history.
 */
export class StochasticTAAPass {
  readonly isStochasticTAAPass = true;
  private _enabled = true;
  private _temporalEnabled = true;
  private disposed = false;
  private readonly layerViews = createSplatLayerViews(
    (renderer, { camera, size, layer }) => {
      const source = layer.splats;
      const pipeline = isWebGPURenderer(renderer)
        ? createNodeTAAPipeline(renderer, camera, size, source)
        : createWebGLTAAPipeline(renderer, camera, size, source);
      return { pipeline, active: false, dispose: () => pipeline.dispose() };
    },
  );
  private frame = 0;
  private framesRemaining = 0;

  constructor(private _splatRenderer: GaussianSplatRenderer) {
    this._splatRenderer[splatLayerAttach](true);
  }

  get splatRenderer() {
    return this._splatRenderer;
  }

  set splatRenderer(value: GaussianSplatRenderer) {
    if (value === this._splatRenderer || this.disposed) return;
    if (this._enabled) this._splatRenderer[splatLayerAttach](false);
    this._splatRenderer = value;
    if (this._enabled) value[splatLayerAttach](true);
    this.resetHistory();
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled || this.disposed) return;
    this._enabled = value;
    this._splatRenderer[splatLayerAttach](value);
    this.resetHistory();
  }

  /** Disable temporal accumulation while retaining quad spatial reconstruction. */
  get temporalEnabled() {
    return this._temporalEnabled;
  }

  set temporalEnabled(value: boolean) {
    if (value === this._temporalEnabled || this.disposed) return;
    this._temporalEnabled = value;
    this.resetHistory();
  }

  /** Whether a render-on-demand loop still has stochastic samples to draw. */
  get needsRender() {
    return (
      this._enabled &&
      this._temporalEnabled &&
      (this.framesRemaining > 0 ||
        this.layerViews.views.some(
          (view) => view.filter.active && view.filter.pipeline.needsRender,
        ))
    );
  }

  /** Schedule another 256 samples after scene/camera updates. */
  requestRender() {
    this.framesRemaining = TAA_SAMPLES;
  }

  /** Discard history after camera cuts, model edits or rendering-option changes. */
  resetHistory() {
    this.frame = 0;
    for (const view of this.layerViews.views) view.filter.pipeline.reset();
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
    if (!this.splatRenderer[stochasticResolveRequired](camera, renderer)) {
      for (const view of this.layerViews.views) {
        view.filter.pipeline.reset();
        view.filter.active = false;
      }
      this.frame = 0;
      this.framesRemaining = 0;
      renderer.render(scene, camera);
      return;
    }
    const previousTarget = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipmapLevel = renderer.getActiveMipmapLevel();
    const output = this.layerViews.update(renderer, scene, camera);
    if (!output) return;
    if (output.reset) this.resetHistory();
    const views = this.layerViews.views;
    const toneMapping = renderer.toneMapping;
    const colorSpace = renderer.outputColorSpace;
    const xrEnabled = renderer.xr.enabled;
    const autoClear = renderer.autoClear;
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      this.splatRenderer[stochasticTemporalFrame](
        this._temporalEnabled ? this.frame : 0,
      );
      for (const view of views) {
        const { layer, filter } = view;
        const { pipeline } = filter;
        filter.active = layer.renderIsolated(
          scene,
          view.camera,
          this.splatRenderer,
          pipeline.composite,
          () =>
            pipeline.resolve(
              this.splatRenderer.display.version,
              this._temporalEnabled,
            ),
        );
        if (!filter.active) pipeline.reset();
      }
      this.layerViews.present(output.destination, output.outputEncoded);
      this.frame = (this.frame + 1) & 0x7fffffff;
      this.framesRemaining = views.some((view) => view.filter.active)
        ? Math.max(0, this.framesRemaining - 1)
        : 0;
    } catch (error) {
      this.resetHistory();
      throw error;
    } finally {
      this.splatRenderer[stochasticTemporalFrame](-1);
      setRendererRenderTarget(renderer, previousTarget, cubeFace, mipmapLevel);
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = colorSpace;
      renderer.xr.enabled = xrEnabled;
      renderer.autoClear = autoClear;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.enabled = false;
    this.layerViews.dispose();
    this.disposed = true;
  }
}
