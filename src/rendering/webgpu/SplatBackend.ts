import { StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import type { SplatAccumulator } from "../SplatAccumulator";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import type { SplatNodeMaterial } from "../tsl/SplatMaterial";
import type { Uniforms } from "../uniforms";
import { WebGPUAccumulatorSort } from "./AccumulatorSort";
import { installWebGPUCompatibilityPatches } from "./compatibility";

/** WebGPU materials and ordering resources, including sorter ownership. */
export class WebGPUSplatBackend extends NodeSplatBackend {
  readonly kind = "webgpu";
  private readonly sorter: WebGPUAccumulatorSort;
  private ordering: StorageBufferAttribute | null;
  private disposed = false;
  precompile: Promise<void> | null;
  sortError: unknown = null;

  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    super(renderer, uniforms, options);
    installWebGPUCompatibilityPatches(renderer);
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
      (material as SplatNodeMaterial).orderingNode.value = this.ordering;
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
