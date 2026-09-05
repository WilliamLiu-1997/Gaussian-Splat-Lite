import * as THREE from "three";
import {
  PMREMGenerator,
  StorageBufferAttribute,
  type WebGPURenderer,
} from "three/webgpu";
import type { SplatAccumulator } from "../SplatAccumulator";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import type { Uniforms } from "../uniforms";
import { WebGPUAccumulatorSort } from "./AccumulatorSort";
import {
  type WebGPUSplatMaterial,
  createWebGPUSplatMaterial,
} from "./SplatMaterial";
import { installWebGPUCompatibilityPatches } from "./compatibility";

export function configureWebGPUSplatOutput(
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

/** WebGPU materials and ordering resources, including sorter ownership. */
export class WebGPUSplatBackend {
  readonly kind = "webgpu";
  readonly material: WebGPUSplatMaterial;
  private readonly sorter: WebGPUAccumulatorSort;
  private ordering: StorageBufferAttribute | null;
  private disposed = false;
  precompile: Promise<void> | null;
  sortError: unknown = null;

  constructor(
    readonly renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    if (options.vertexShader || options.fragmentShader) {
      throw new Error(
        "Custom GLSL shaders are only supported by WebGLRenderer",
      );
    }
    installWebGPUCompatibilityPatches(renderer);
    this.material = createWebGPUSplatMaterial({ uniforms, ...options });
    this.ordering = this.material.orderingNode.value;
    const sorter = new WebGPUAccumulatorSort(1);
    this.sorter = sorter;
    this.precompile = sorter
      .precompile(renderer)
      .catch((error: unknown) => {
        this.sortError = error;
      })
      .finally(() => {
        this.precompile = null;
        // The compiler can create resources after dispose(); release them last.
        if (this.disposed) sorter.dispose();
      });
  }

  createDepthMaterial(uniforms: Uniforms) {
    return createWebGPUSplatMaterial({
      uniforms,
      orderingNode: this.material.orderingNode,
      premultipliedAlpha: false,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      depthOnly: true,
    });
  }

  getOrderingCapacity(count: number) {
    return Math.max(1, count);
  }

  get cpuOrdering(): Uint32Array | null {
    return this.ordering === this.sorter.ordering
      ? null
      : ((this.ordering?.array as Uint32Array | null) ?? null);
  }

  private setOrdering(
    ordering: StorageBufferAttribute,
    sorterOwnedPrevious?: StorageBufferAttribute,
  ) {
    if (this.ordering === ordering) return;
    if (this.ordering && this.ordering !== sorterOwnedPrevious)
      this.ordering.dispose();
    this.ordering = ordering;
    this.material.orderingNode.value = ordering;
  }

  setCPUOrdering({ ordering, activeSplats, capacity }: CPUOrderingUpdate) {
    let attribute =
      this.ordering === this.sorter.ordering ? null : this.ordering;
    if (!attribute || attribute.array.length !== capacity) {
      // GPU allocation storage contains no computed indices on the CPU and
      // must never be transferred to the worker or overwritten by its result.
      attribute = new StorageBufferAttribute(ordering, 1);
      attribute.name = "GaussianSplatOrdering";
      this.setOrdering(attribute, this.sorter.ordering);
    } else {
      attribute.array = ordering;
      attribute.clearUpdateRanges();
      if (activeSplats > 0) {
        attribute.addUpdateRange(0, activeSplats);
        attribute.needsUpdate = true;
      }
    }
  }

  sortAccumulator(
    current: SplatAccumulator,
    capacity: number,
    shrink: boolean,
    radial: boolean,
  ) {
    const previous = this.sorter.ordering;
    this.sorter.resize(capacity, shrink);
    this.setOrdering(this.sorter.ordering, previous);
    this.sorter.sort({
      renderer: this.renderer,
      splats: current.getTextures()[0],
      count: current.numSplats,
      direction: current.viewDirection,
      radial,
    });
  }

  async shrinkSort(capacity: number): Promise<boolean> {
    if (capacity >= this.sorter.capacity) return false;
    if (this.precompile) await this.precompile;
    if (this.disposed) return false;
    const previous = this.sorter.ordering;
    const active = this.ordering === previous;
    this.sorter.resize(capacity, true);
    if (active) this.setOrdering(this.sorter.ordering, previous);
    return active;
  }

  bindOrdering(material: SplatMaterial, _uniforms: Uniforms) {
    if (this.ordering)
      (material as WebGPUSplatMaterial).orderingNode.value = this.ordering;
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
    copyReadbackRGBA(pixels, readback, target.width, target.height);
  }

  createPMREMGenerator() {
    return new PMREMGenerator(this.renderer);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ordering && this.ordering !== this.sorter.ordering)
      this.ordering.dispose();
    this.ordering = null;
    if (!this.precompile) this.sorter.dispose();
  }
}

function copyReadbackRGBA(
  target: Uint8Array,
  readback: ArrayBufferView,
  width: number,
  height: number,
) {
  const source = new Uint8Array(
    readback.buffer,
    readback.byteOffset,
    readback.byteLength,
  );
  const rowBytes = width * 4;
  const rowStride =
    height > 1 ? (source.byteLength - rowBytes) / (height - 1) : rowBytes;
  for (let y = 0; y < height; y++) {
    const sourceRow = height - y - 1;
    target.set(
      source.subarray(sourceRow * rowStride, sourceRow * rowStride + rowBytes),
      y * rowBytes,
    );
  }
}
