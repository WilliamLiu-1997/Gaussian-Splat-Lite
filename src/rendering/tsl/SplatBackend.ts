import * as THREE from "three";
import { PMREMGenerator, type WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend";
import { usesNativeWebGPU } from "../rendererUtils";
import type { Uniforms } from "../uniforms";
import {
  type ProjectedVertexData,
  type SplatNodeMaterial,
  createSplatNodeMaterial,
} from "./SplatMaterial";
import type { TSLNode } from "./shaderUtils";

export function configureNodeSplatOutput(
  renderer: WebGPURenderer,
  target: THREE.RenderTarget | null,
  uniforms: Uniforms,
  markerUsers: number,
) {
  const xrOutput =
    target === renderer.getOutputRenderTarget() ||
    (
      target as
        | (THREE.RenderTarget & { isPostProcessingRenderTarget?: boolean })
        | null
    )?.isPostProcessingRenderTarget;
  // Alpha-2 markers must not escape through Three's XR output intermediate.
  uniforms.stochasticResolve.value =
    markerUsers > 0 &&
    (!renderer.xr.isPresenting ||
      (!xrOutput &&
        (target?.texture.type === THREE.HalfFloatType ||
          target?.texture.type === THREE.FloatType)));
  uniforms.encodeLinear.value =
    THREE.ColorManagement.workingColorSpace !== THREE.SRGBColorSpace;
}

/** Drawing and readback shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  readonly material: SplatNodeMaterial;

  constructor(
    readonly renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    orderingNode?: TSLNode,
    private readonly vertexData?: (camera: THREE.Camera) => ProjectedVertexData,
  ) {
    if (options.vertexShader || options.fragmentShader) {
      throw new Error(
        "Custom GLSL shaders are only supported by WebGLRenderer",
      );
    }
    this.material = createSplatNodeMaterial({
      uniforms,
      ...options,
      orderingNode,
      vertexData,
    });
  }

  createDepthMaterial(uniforms: Uniforms) {
    return createSplatNodeMaterial({
      uniforms,
      orderingNode: this.material.orderingNode,
      premultipliedAlpha: false,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      vertexData: this.vertexData,
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
