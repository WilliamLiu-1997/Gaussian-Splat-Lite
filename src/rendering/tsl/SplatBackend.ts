import type * as THREE from "three";
import { PMREMGenerator, type WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend";
import { usesNativeWebGPU } from "../rendererUtils";
import type { Uniforms } from "../uniforms";
import {
  type OrderingNode,
  type ProjectedVertexData,
  type SplatNodeMaterial,
  createSplatNodeMaterial,
} from "./SplatMaterial";

/** Drawing and readback shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  readonly sortedMaterial: SplatNodeMaterial;
  readonly uniformMaterial: SplatNodeMaterial;

  constructor(
    readonly renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    orderingNode?: OrderingNode,
    vertexData?: (camera: THREE.Camera) => ProjectedVertexData,
  ) {
    this.sortedMaterial = createSplatNodeMaterial({
      uniforms,
      ...options,
      orderingNode,
      vertexData,
      sorted: true,
    });
    this.uniformMaterial = createSplatNodeMaterial({
      uniforms,
      ...options,
      orderingNode: this.sortedMaterial.orderingNode,
      vertexNode: this.sortedMaterial.vertexNode,
    });
  }

  selectMaterial(useUniform: boolean) {
    return useUniform ? this.uniformMaterial : this.sortedMaterial;
  }

  dispose() {
    this.sortedMaterial.dispose();
    this.uniformMaterial.dispose();
  }

  createDepthMaterial(uniforms: Uniforms) {
    return createSplatNodeMaterial({
      uniforms,
      orderingNode: this.sortedMaterial.orderingNode,
      premultipliedAlpha: false,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });
  }

  async readPixels(
    target: THREE.WebGLRenderTarget,
    pixels: Uint8Array,
    face = 0,
  ) {
    const readback = await this.renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      target.width,
      target.height,
      0,
      face,
    );
    const source = new Uint8Array(
      readback.buffer,
      readback.byteOffset,
      readback.byteLength,
    );
    if (!usesNativeWebGPU(this.renderer)) {
      pixels.set(source);
      return;
    }
    // WebGPU rows are padded to 256 bytes and use the opposite Y origin.
    const rowBytes = target.width * 4;
    const rowStride =
      target.height > 1
        ? (source.byteLength - rowBytes) / (target.height - 1)
        : rowBytes;
    for (let y = 0; y < target.height; y++) {
      const start = (target.height - y - 1) * rowStride;
      pixels.set(source.subarray(start, start + rowBytes), y * rowBytes);
    }
  }

  createPMREMGenerator() {
    return new PMREMGenerator(this.renderer);
  }
}
