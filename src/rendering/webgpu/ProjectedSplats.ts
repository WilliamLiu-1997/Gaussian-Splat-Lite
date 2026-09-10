import * as THREE from "three";
import * as TSL from "three/tsl";
import {
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
  type WebGPURenderer,
} from "three/webgpu";

import type { SplatAccumulator } from "../SplatAccumulator";
import {
  type SplatGeometry,
  WEBGPU_SPLATS_PER_INSTANCE,
} from "../SplatGeometry";
import { createGenerateProgram } from "../tsl/GenerateProgram";
import { createProjectionProgram } from "../tsl/ProjectionProgram";
import type { ProjectedVertexData } from "../tsl/SplatMaterial";
import { type TSLNode, uniformBinding } from "../tsl/shaderUtils";
import { splatViewportUniforms } from "../tsl/viewUniforms";
import { type Uniforms, makeGenerateUniforms } from "../uniforms";
import { ProjectionCache, getProjectionCacheSize } from "./ProjectionCache";
import { WebGPURadixSort } from "./RadixSort";

const N = TSL as Record<string, TSLNode>;
const WORKGROUP_SIZE = 256;
const PROJECT_SLOTS = 8;

type BufferRef = { value: StorageBufferAttribute; name: string };
type ComputeSlot = { uniforms: Uniforms; node: TSLNode };
type DeviceLimits = {
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxTextureArrayLayers: number;
  maxTextureDimension2D: number;
  maxComputeWorkgroupsPerDimension: number;
};
type ComputeRenderer = WebGPURenderer & {
  compileComputeAsync(nodes: TSLNode[]): Promise<void>;
  backend: { device: { limits: DeviceLimits } };
};

function buffer(name: string): BufferRef {
  return { value: new StorageBufferAttribute(new Uint32Array(1), 1), name };
}

function bindBuffer(ref: BufferRef) {
  // Stable binding names let projection slots share the same WGSL program.
  return N.storage(ref.value, "uint")
    .setName(ref.name)
    .onObjectUpdate(() => ref.value);
}

/** Fixed compute graph. Source mappings and storage may change without rebuilding shaders. */
export class ProjectedSplats {
  // Only the instance count changes; the other indirect draw arguments are fixed.
  readonly indirect = new IndirectStorageBufferAttribute(
    new Uint32Array([WEBGPU_SPLATS_PER_INSTANCE * 6, 0, 0, 0, 0]),
    1,
  );
  /** Common kernels, the full sorter and the first slot are ready; remaining slots warm automatically. */
  readonly ready: Promise<void>;
  error: unknown = null;

  private readonly limits: DeviceLimits;
  private readonly cache = new ProjectionCache();
  private readonly visibleCount = new StorageBufferAttribute(
    new Uint32Array(1),
    1,
  );
  private readonly keys = buffer("gslProjectionKeys");
  private readonly seeds = buffer("gslProjectionSeeds");
  private readonly counts = buffer("gslProjectionCounts");
  private readonly sorter: WebGPURadixSort;
  private readonly slots: ComputeSlot[] = [];
  private readonly compilation: Promise<void>;
  private compiledSlots = 0;
  private readonly resetCount: TSLNode;
  private readonly finish: TSLNode;
  private readonly state: Uniforms;
  private readonly matrix = new THREE.Matrix4();
  private readonly translation = new THREE.Matrix4();
  private readonly scale = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private capacity = 0;
  private viewCapacity = 0;
  private disposed = false;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly uniforms: Uniforms,
  ) {
    const computeRenderer = renderer as ComputeRenderer;
    this.limits = computeRenderer.backend.device.limits;
    this.state = {
      ...uniforms,
      projectionMatrix: { value: new THREE.Matrix4() },
      renderToViewQuat: { value: new THREE.Quaternion() },
      renderToViewPos: { value: new THREE.Vector3() },
      renderToViewScale: { value: 1 },
      near: { value: 0.1 },
      far: { value: 1000 },
      renderSize: { value: new THREE.Vector2() },
      viewBase: { value: 0 },
      viewIndex: { value: 0 },
      viewStride: { value: 1 },
      multiView: { value: false },
      sortDirection: { value: new THREE.Vector3() },
      sortOffset: { value: new THREE.Vector3() },
      sortRadial: { value: false },
    };
    const viewBase = uniformBinding(this.state, "viewBase", "uint");
    const multiView = uniformBinding(this.state, "multiView", "bool");
    const stochastic = uniformBinding(uniforms, "stochastic", "bool");
    // Mono draws read the buffers directly. ArrayCamera draws need every eye's
    // order and seeds at once; the finish node or final sort scatter writes them.
    // Texture arrays avoid dividing the storage-binding capacity by eye count.
    const count = N.storage(this.visibleCount, "uint")
      .setName("gslVisibleCount")
      .toReadOnly()
      .element(0);
    const seeds = bindBuffer(this.seeds).toReadOnly();
    this.sorter = new WebGPURadixSort(1, this.keys, {
      count,
      storeOrder: (index, value) => {
        N.If(multiView, () => {
          // Sorted color uses x; stochastic/depth draws use direct slots and y.
          this.cache.storeOrder(
            viewBase.add(index),
            N.uvec4(value, seeds.element(index), 0, 0),
          );
        });
      },
      maxComputeWorkgroupsPerDimension:
        this.limits.maxComputeWorkgroupsPerDimension,
      maxStorageBufferBindingSize: Math.min(
        this.limits.maxStorageBufferBindingSize,
        this.limits.maxBufferSize,
      ),
    });
    const drawCount = N.storage(this.indirect, "uint")
      .setName("gslDrawIndirect")
      .element(1);
    const counter = N.storage(this.visibleCount, "uint")
      .setName("gslVisibleCount")
      .toAtomic();
    this.resetCount = N.Fn(() => {
      N.atomicStore(counter.element(0), N.uint(0));
    })()
      .compute(1, [1])
      .setName("Splat reset visible count");
    const counts = bindBuffer(this.counts);
    const viewIndex = uniformBinding(this.state, "viewIndex", "uint");
    this.finish = N.Fn(() => {
      const index = N.uint(N.instanceIndex);
      N.If(index.equal(0), () => {
        counts.element(viewIndex).assign(count);
        const instances = count
          .add(WEBGPU_SPLATS_PER_INSTANCE - 1)
          .div(N.uint(WEBGPU_SPLATS_PER_INSTANCE));
        // The first eye resets the count; later eyes extend it to their maximum.
        drawCount.assign(
          N.select(viewIndex.equal(0), instances, drawCount.max(instances)),
        );
      });
      // Only stochastic ArrayCamera draws need this per-eye copy;
      // mono reads seeds directly.
      N.If(multiView.and(stochastic).and(index.lessThan(count)), () => {
        this.cache.storeOrder(
          viewBase.add(index),
          N.uvec4(index, seeds.element(index), 0, 0),
        );
      });
    })()
      .compute(1, [WORKGROUP_SIZE])
      .setName("Splat visible draw arguments");
    for (let i = 0; i < PROJECT_SLOTS; i++) this.slots.push(this.createSlot());
    this.ready = computeRenderer
      .compileComputeAsync([
        this.resetCount,
        this.finish,
        ...this.sorter.nodes,
        this.slots[0].node,
      ])
      .then(() => {
        this.compiledSlots = 1;
      })
      .catch((error: unknown) => {
        this.error = error;
      });
    this.compilation = this.ready.then(() => this.compileRemainingSlots());
  }

  private async compileRemainingSlots() {
    if (this.disposed || this.compiledSlots === 0) return;
    try {
      // Yield to let readiness callbacks run before warming remaining slots.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      while (!this.disposed && this.compiledSlots < this.slots.length) {
        await (this.renderer as ComputeRenderer).compileComputeAsync([
          this.slots[this.compiledSlots].node,
        ]);
        this.compiledSlots++;
      }
    } catch (error) {
      this.error = error;
    }
  }

  private createSlot(): ComputeSlot {
    const uniforms = { ...this.state, ...makeGenerateUniforms() };
    const u = (name: string, type: string) =>
      uniformBinding(uniforms, name, type);
    const generate = createGenerateProgram({ uniforms });
    const project = createProjectionProgram(uniforms, {
      projectionMatrix: u("projectionMatrix", "mat4"),
      renderToViewQuat: u("renderToViewQuat", "vec4"),
      renderToViewPos: u("renderToViewPos", "vec3"),
      renderToViewScale: u("renderToViewScale", "float"),
      near: u("near", "float"),
      far: u("far", "float"),
      renderSize: u("renderSize", "vec2"),
    });
    const viewBase = u("viewBase", "uint");
    const direction = u("sortDirection", "vec3");
    const sortOffset = u("sortOffset", "vec3");
    const radial = u("sortRadial", "bool");
    const stochastic = u("stochastic", "bool");
    const centerRange = u("clipXY", "float").abs().max(1).mul(1.000001);
    const pixelScale = u("renderSize", "vec2")
      .mul(u("focalAdjustment", "float"))
      .mul(0.5);
    const keys = bindBuffer(this.keys);
    const seeds = bindBuffer(this.seeds);
    const counter = N.storage(this.visibleCount, "uint")
      .setName("gslVisibleCount")
      .toAtomic();
    const node = N.Fn(() => {
      const index = N.uint(N.instanceIndex);
      const generated = generate.prepare(index);
      const projection = project(generated, false);
      const extent = projection.axis1.abs().add(projection.axis2.abs());
      const ndc = projection.clipCenter.xy.div(projection.clipCenter.w);
      // Reject only quads wholly outside the viewport; clipXY and every
      // existing visual cutoff remain part of the shared projection math.
      const onscreen = N.all(ndc.abs().lessThanEqual(extent.add(1)));
      N.If(projection.valid.and(onscreen), () => {
        projection.rgba.rgb.assign(generated.resolveRgb());
        // Compact survivors and their stable seeds into the same slots.
        const slot = N.atomicAdd(counter.element(0), N.uint(1)).toVar();
        this.cache.write(
          viewBase.add(slot),
          projection,
          ndc,
          pixelScale,
          centerRange,
        );
        seeds.element(slot).assign(generated.stochasticSeed);
        N.If(stochastic.not(), () => {
          // Signed float keys preserve back-to-front order across negative view depths.
          const center = generated.center.add(sortOffset);
          const metric = N.select(
            radial,
            center.dot(center),
            center.dot(direction),
          );
          const bits = N.floatBitsToUint(metric);
          const key = N.uint(0xffffffff).toVar();
          N.If(
            bits.bitAnd(N.uint(0x7fffffff)).lessThan(N.uint(0x7f800000)),
            () => {
              key.assign(
                N.select(
                  bits.bitAnd(N.uint(0x80000000)).notEqual(0),
                  bits,
                  bits.bitXor(N.uint(0x7fffffff)),
                ),
              );
            },
          );
          keys.element(slot).assign(key);
        });
      });
    })()
      .compute(1, [WORKGROUP_SIZE])
      .setName("Splat generate project compact");
    return { uniforms, node };
  }

  vertexData(camera: THREE.Camera, depthOnly = false): ProjectedVertexData {
    const array = camera as THREE.ArrayCamera;
    const multiView = array.isArrayCamera === true && array.cameras.length > 0;
    const eye = multiView ? N.cameraIndex : N.uint(0);
    const stride = uniformBinding(this.state, "viewStride", "uint");
    // Both coverage branches need the eye offset before any order lookup.
    const base = eye.mul(stride).toVar();
    const i = N.uint(N.instanceIndex)
      .mul(WEBGPU_SPLATS_PER_INSTANCE)
      .add(N.uint(N.positionGeometry.z));
    const counts = bindBuffer(this.counts).toReadOnly();
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    const rgba = N.vec4(0).toVar();
    const splatUv = N.vec2(0).toVar();
    const stochasticSeed = N.uint(0).toVar();
    const stochastic = uniformBinding(this.uniforms, "stochastic", "bool");
    const supportRadiusSquared = N.float(0).toVar();
    const kernelPower = N.float(0).toVar();
    const view = splatViewportUniforms(this.uniforms, camera);
    const centerRange = uniformBinding(this.uniforms, "clipXY", "float")
      .abs()
      .max(1)
      .mul(1.000001);
    const renderSize = multiView
      ? view.renderSize
      : uniformBinding(this.state, "renderSize", "vec2");
    const pixelScale = renderSize
      .mul(uniformBinding(this.uniforms, "focalAdjustment", "float"))
      .mul(0.5);

    // Indirect draws round up to whole quad groups; trim each eye before any
    // index or cache load, including the unused tail of the final instance.
    N.If(i.lessThan(counts.element(eye)), () => {
      const cacheIndex = i.toVar();
      const assignSeed = () => {
        stochasticSeed.assign(
          multiView
            ? this.cache.readOrder(base.add(i)).y
            : bindBuffer(this.seeds).toReadOnly().element(i),
        );
      };
      if (depthOnly) {
        assignSeed();
      } else {
        N.If(stochastic, assignSeed).Else(() => {
          cacheIndex.assign(
            multiView
              ? this.cache.readOrder(base.add(i)).x
              : N.storage(this.sorter.ordering, "uint")
                  .onObjectUpdate(() => this.sorter.ordering)
                  .toReadOnly()
                  .element(i),
          );
        });
      }
      const projected = this.cache.read(
        base.add(cacheIndex),
        pixelScale,
        centerRange,
      );
      clipPosition.assign(projected.clipPosition);
      rgba.assign(projected.rgba);
      splatUv.assign(projected.splatUv);
      supportRadiusSquared.assign(projected.supportRadiusSquared);
      kernelPower.assign(projected.kernelPower);
    });
    return {
      clipPosition,
      rgba,
      splatUv,
      stochasticSeed,
      supportRadiusSquared,
      kernelPower,
      viewportOrigin: view.viewportOrigin,
    };
  }

  private resizeBuffer(ref: BufferRef, count: number) {
    if (ref.value.count === count) return;
    const old = ref.value;
    ref.value = new StorageBufferAttribute(new Uint32Array(count), 1);
    old.dispose();
  }

  private resize(count: number, views: number, shrink = false) {
    const required = Math.max(1, count);
    const bytes = required * 4;
    if (
      bytes >
      Math.min(
        this.limits.maxStorageBufferBindingSize,
        this.limits.maxBufferSize,
      )
    ) {
      throw new RangeError(
        `WebGPU sort requires ${bytes} bytes per index buffer; device binding limit is ${this.limits.maxStorageBufferBindingSize}. Request higher requiredLimits when creating WebGPURenderer or reduce resident Splats.`,
      );
    }
    const limit = Math.floor(
      Math.min(
        this.limits.maxStorageBufferBindingSize,
        this.limits.maxBufferSize,
      ) / 4,
    );
    // Amortize small mapping changes without tying shader graphs to capacity.
    const capacity = shrink
      ? required
      : required <= this.capacity
        ? this.capacity
        : Math.min(
            limit,
            Math.max(
              required,
              2048,
              Math.ceil((this.capacity * 1.5) / 2048) * 2048,
            ),
          );
    const viewCapacity = shrink ? views : Math.max(views, this.viewCapacity);
    if (capacity === this.capacity && viewCapacity === this.viewCapacity)
      return;
    const size = getProjectionCacheSize(capacity * viewCapacity, this.limits);
    this.resizeBuffer(this.keys, capacity);
    this.sorter.resize(capacity, shrink);
    this.resizeBuffer(this.seeds, capacity);
    this.resizeBuffer(this.counts, viewCapacity);
    this.cache.resize(size);
    this.capacity = capacity;
    this.viewCapacity = viewCapacity;
    this.state.viewStride.value = capacity;
  }

  render(
    accumulator: SplatAccumulator,
    camera: THREE.Camera,
    geometry: SplatGeometry,
    radial: boolean,
    shrink = false,
  ) {
    if (this.error) throw this.error;
    if (this.compiledSlots === 0 || this.disposed) {
      geometry.instanceCount = 0;
      return;
    }
    const array = camera as THREE.ArrayCamera;
    const multiView = array.isArrayCamera === true && array.cameras.length > 0;
    const cameras = multiView ? array.cameras : [camera];
    this.resize(accumulator.numSplats, cameras.length, shrink);
    this.state.multiView.value = multiView;
    this.finish.count =
      multiView && this.uniforms.stochastic.value
        ? Math.max(1, accumulator.numSplats)
        : 1;
    this.cache.ensureOrder(multiView, shrink);
    geometry.setIndirect(this.indirect);
    geometry.setSplatCount(Math.max(1, accumulator.numSplats));
    for (let eye = 0; eye < cameras.length; eye++) {
      const view = cameras[eye] as THREE.PerspectiveCamera;
      this.state.viewIndex.value = eye;
      this.state.viewBase.value = eye * this.capacity;
      this.state.sortRadial.value = radial;
      view.getWorldDirection(this.direction);
      this.state.sortDirection.value.copy(this.direction);
      view.getWorldPosition(this.direction);
      this.state.sortOffset.value
        .copy(accumulator.viewOrigin)
        .sub(this.direction);
      this.state.projectionMatrix.value.copy(view.projectionMatrix);
      this.state.near.value = view.near;
      this.state.far.value = view.far;
      this.state.renderSize.value.copy(this.uniforms.renderSize.value);
      if (view.viewport)
        this.state.renderSize.value.set(view.viewport.z, view.viewport.w);
      this.matrix
        .copy(view.matrixWorld)
        .invert()
        .multiply(this.translation.makeTranslation(accumulator.viewOrigin))
        .decompose(
          this.state.renderToViewPos.value,
          this.state.renderToViewQuat.value,
          this.scale,
        );
      this.state.renderToViewScale.value =
        (this.scale.x + this.scale.y + this.scale.z) / 3;
      const pending: TSLNode[] = [this.resetCount];
      let slotCount = 0;
      for (const { node, count } of accumulator.mapping) {
        if (!view.layers.test(node.layers)) continue;
        // A slot's uniforms can only be changed after its preceding batch has
        // been submitted. Keep the last batch open for draw arguments and sorting.
        if (slotCount === this.compiledSlots) {
          this.renderer.compute(pending);
          pending.length = 0;
          slotCount = 0;
        }
        const slot = this.slots[slotCount++];
        accumulator.prepareUniforms(node, slot.uniforms);
        slot.uniforms.targetCount.value = count;
        slot.node.count = count;
        pending.push(slot.node);
      }
      pending.push(this.finish);
      if (!this.uniforms.stochastic.value && accumulator.numSplats > 0) {
        pending.push(...this.sorter.prepare(accumulator.numSplats));
      }
      this.renderer.compute(pending);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    void this.compilation.then(() => this.disposeResources());
  }

  private disposeResources() {
    for (const slot of this.slots) slot.node.dispose();
    for (const node of [this.resetCount, this.finish]) node.dispose();
    this.sorter.dispose();
    this.cache.dispose();
    this.visibleCount.dispose();
    this.keys.value.dispose();
    this.seeds.value.dispose();
    this.counts.value.dispose();
    this.indirect.dispose();
  }
}
