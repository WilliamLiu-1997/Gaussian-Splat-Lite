import type { Camera, Object3D, Scene } from "three";
import type { GaussianSplatRenderer } from "../../rendering/GaussianSplatRenderer";
import type { SplatAccumulator } from "../../rendering/SplatAccumulator";
import type { SplatRendererPlugin } from "../../rendering/SplatRendererPlugin";
import { ModelLighting, type SplatModelLightingOptions } from "./ModelLighting";
import { SplatLighting } from "./SplatLighting";

export type SplatLightingPluginOptions = {
  enabled?: boolean;
};

/** Scene lighting and mutual mesh/Splat shadows, loaded independently of the renderer. */
export class SplatLightingPlugin implements SplatRendererPlugin {
  readonly name = "SplatLightingPlugin";
  private owner: GaussianSplatRenderer | null = null;
  private lighting: SplatLighting | null = null;
  private models = new ModelLighting();
  private on: boolean;

  constructor({ enabled = true }: SplatLightingPluginOptions = {}) {
    this.on = enabled;
  }

  init(renderer: GaussianSplatRenderer) {
    this.owner = renderer;
    this.lighting = new SplatLighting(
      renderer,
      renderer.backend,
      this.on,
      (mesh) => this.models.flags(mesh),
    );
  }

  get enabled() {
    return this.on;
  }

  set enabled(value: boolean) {
    if (this.on === value) return;
    this.on = value;
    if (this.lighting) this.lighting.enabled = value;
    this.owner?.selectMaterial();
    this.owner?.setDirty();
  }

  setModelOptions(model: Object3D, options: SplatModelLightingOptions) {
    this.models.set(model, options);
    this.owner?.setDirty();
  }

  getModelOptions(model: Object3D): Required<SplatModelLightingOptions> {
    const flags = this.models.flags(model);
    return {
      receiveLight: (flags & 1) !== 0,
      receiveShadow: (flags & 2) !== 0,
      castShadow: (flags & 4) !== 0,
    };
  }

  clone() {
    const plugin = new SplatLightingPlugin({ enabled: this.on });
    plugin.models = this.models;
    return plugin;
  }

  copy(source: SplatRendererPlugin) {
    const plugin = source as SplatLightingPlugin;
    this.models = plugin.models;
    this.enabled = plugin.enabled;
  }

  sync() {
    this.lighting?.sync();
  }

  selectMaterial(stochastic: boolean) {
    return this.lighting?.selectMaterial(stochastic) ?? null;
  }

  startsFrame(counterChanged: boolean) {
    return this.lighting?.startsFrame(counterChanged) ?? counterChanged;
  }

  prepareDraw(scene: Scene, camera: Camera, display: SplatAccumulator) {
    this.lighting?.prepareDraw(scene, camera, display);
  }

  dispose() {
    this.lighting?.dispose();
    this.lighting = null;
    this.owner = null;
  }
}
