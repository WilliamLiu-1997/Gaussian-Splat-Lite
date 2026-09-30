import type { WebGPURenderer } from "three/webgpu";
import type { SplatMaterial, SplatMaterialOptions } from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import { createSplatNodeMaterial } from "../tsl/SplatMaterial";
import type { Uniforms } from "../uniforms";
import { createWebGPULayers } from "./LayeredOverdraw";
import { ProjectedSplats } from "./ProjectedSplats";

/** Native WebGPU: fixed compute projection, visible compaction, GPU sort and indirect draw. */
export class WebGPUSplatBackend extends NodeSplatBackend {
  readonly kind = "webgpu";
  readonly projection: ProjectedSplats;
  precompile: Promise<void> | null;
  private layeredState: ReturnType<typeof createWebGPULayers> | null = null;

  constructor(
    renderer: WebGPURenderer,
    private readonly uniforms: Uniforms,
    private readonly options: SplatMaterialOptions,
  ) {
    const projection = new ProjectedSplats(renderer, uniforms);
    super(renderer, uniforms, options, undefined, (camera) =>
      projection.vertexData(camera),
    );
    this.projection = projection;
    this.precompile = projection.ready.finally(() => {
      this.precompile = null;
    });
  }

  get sortError() {
    return this.projection.error;
  }
  getOrderingCapacity(count: number) {
    return Math.max(1, count);
  }

  /** Front-to-back layer passes and their composite, created on first use. */
  get layered() {
    this.layeredState ??= createWebGPULayers(
      this.renderer,
      this.projection,
      this.uniforms,
      this.options,
      this.sortedMaterial.orderingNode,
    );
    return this.layeredState;
  }

  /** Releases layer targets while layered overdraw is disabled. */
  releaseLayered() {
    this.layeredState?.overdraw.release();
  }

  createDepthMaterial(uniforms: Uniforms) {
    return createSplatNodeMaterial({
      uniforms,
      vertexData: (camera) => this.projection.vertexData(camera, true),
      premultipliedAlpha: false,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });
  }

  bindOrdering(_material: SplatMaterial, _uniforms: Uniforms) {}

  dispose() {
    super.dispose();
    this.layeredState?.dispose();
    this.layeredState = null;
    this.projection.dispose();
  }
}
