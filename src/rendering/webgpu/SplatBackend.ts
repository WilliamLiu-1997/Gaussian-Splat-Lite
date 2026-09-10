import type { WebGPURenderer } from "three/webgpu";
import type { SplatMaterial, SplatMaterialOptions } from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import { createSplatNodeMaterial } from "../tsl/SplatMaterial";
import type { Uniforms } from "../uniforms";
import { ProjectedSplats } from "./ProjectedSplats";

/** Native WebGPU: fixed compute projection, visible compaction, GPU sort and indirect draw. */
export class WebGPUSplatBackend extends NodeSplatBackend {
  readonly kind = "webgpu";
  readonly projection: ProjectedSplats;
  precompile: Promise<void> | null;

  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    if (options.vertexShader || options.fragmentShader) {
      throw new Error(
        "Custom GLSL shaders are only supported by WebGLRenderer",
      );
    }
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
    this.projection.dispose();
  }
}
