import * as THREE from "three";
import {
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
} from "three/webgpu";
import { getTAAProjection } from "../../addons/taaShared.js";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry.js";
import { getMeanViewPose, getViews } from "../rendererUtils.js";
import { N, uniformBinding } from "../tsl/shaderUtils.js";
import {
  splatProjectionMatrix,
  splatViewportUniforms,
} from "../tsl/viewUniforms.js";
import { makeGenerateUniforms } from "../uniforms.js";
import { ProjectionCache, getProjectionCacheSize } from "./ProjectionCache.js";
import { createProjectionKernel } from "./ProjectionKernel.js";
import { RADIX_SORT_MODE_IDS, WebGPURadixSort } from "./RadixSort.js";
const PROJECT_SLOTS = 8;
function buffer(name) {
  return { value: new StorageBufferAttribute(new Uint32Array(1), 1), name };
}
/**
 * Stores in `jitter` the NDC translation that `jittered` adds to `base`, as
 * TAA's sub-pixel view offsets do. Returns false for any other difference.
 */
function getProjectionJitter(jittered, base, jitter) {
  const a = jittered.elements;
  const b = base.elements;
  for (let i = 0; i < 16; i++) {
    if (
      i !== 8 &&
      i !== 9 &&
      i !== 12 &&
      i !== 13 &&
      Math.abs(a[i] - b[i]) >
        4 * Number.EPSILON * Math.max(1, Math.abs(a[i]), Math.abs(b[i]))
    ) {
      return false;
    }
  }
  // Perspective offsets scale with view depth (w = -z); orthographic ones
  // translate clip space directly (w = 1). Each projection uses only one.
  jitter.set(a[12] - b[12] - (a[8] - b[8]), a[13] - b[13] - (a[9] - b[9]));
  return true;
}
function bindBuffer(ref) {
  // Stable binding names let projection slots share the same WGSL program.
  return N.storage(ref.value, "uint")
    .setName(ref.name)
    .onObjectUpdate(() => ref.value);
}
/** Fixed compute graph. Source mappings and storage may change without rebuilding shaders. */
export class ProjectedSplats {
  constructor(renderer, uniforms) {
    this.renderer = renderer;
    this.uniforms = uniforms;
    // Only the instance count changes; the other indirect draw arguments are fixed.
    this.indirect = new IndirectStorageBufferAttribute(
      new Uint32Array([SPLATS_PER_INSTANCE * 6, 0, 0, 0, 0]),
      1,
    );
    this.error = null;
    this.cache = new ProjectionCache();
    this.visibleCount = new StorageBufferAttribute(new Uint32Array(1), 1);
    this.keys = buffer("gslProjectionKeys");
    this.seeds = buffer("gslProjectionSeeds");
    // Mono and WebXR stereo stay compiled for our lifetime.
    this.slotSets = new Map();
    this.shrinkViews = false;
    this.onSessionEnd = () => {
      this.shrinkViews = true;
      this.onViewsReleased?.();
    };
    this.matrix = new THREE.Matrix4();
    this.translation = new THREE.Matrix4();
    this.scale = new THREE.Vector3();
    this.viewPosition = new THREE.Vector3();
    this.capacity = 0;
    this.viewCapacity = 0;
    this.disposed = false;
    this.projectedInputs = [];
    this.pendingInputs = [];
    this.limits = renderer.backend.device.limits;
    this.state = {
      ...uniforms,
      projectionMatrix: { value: new THREE.Matrix4() },
      renderToViewQuat: { value: new THREE.Quaternion() },
      renderToViewPos: { value: new THREE.Vector3() },
      renderToViewScale: { value: 1 },
      near: { value: 0.1 },
      far: { value: 1000 },
      renderSize: { value: new THREE.Vector2() },
      // Projected records of each eye start one capacity after the last.
      viewStride: { value: 1 },
      sortDirection: { value: new THREE.Vector3() },
      sortOffset: { value: new THREE.Vector3() },
      sortRadial: { value: false },
      // RADIX_SORT_MODE_IDS value of the current key encoding.
      sortMode: { value: 0 },
      // NDC translation the draw applies to unjittered projections.
      projectionJitter: { value: new THREE.Vector2() },
    };
    // Every view, including each WebXR eye, draws one compact sorted order.
    const count = N.storage(this.visibleCount, "uint")
      .setName("gslVisibleCount")
      .toReadOnly()
      .element(0);
    this.sorter = new WebGPURadixSort(1, this.keys, {
      count,
      mode: uniformBinding(this.state, "sortMode", "uint"),
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
    this.finish = N.Fn(() => {
      drawCount.assign(
        count.add(SPLATS_PER_INSTANCE - 1).div(N.uint(SPLATS_PER_INSTANCE)),
      );
    })()
      .compute(1, [1])
      .setName("Splat visible draw arguments");
    for (const eyes of [1, 2]) this.createSlotSet(eyes);
    const commonNodes = [this.resetCount, this.finish, ...this.sorter.nodes];
    this.nodes = [
      ...commonNodes,
      ...Array.from(this.slotSets.values()).flatMap((set) =>
        set.slots.map((slot) => slot.node),
      ),
    ];
    this.ready = renderer
      .compileComputeAsync([
        ...commonNodes,
        ...Array.from(this.slotSets.values(), (set) => set.slots[0].node),
      ])
      .then(() => {
        for (const set of this.slotSets.values()) set.compiled = 1;
      })
      .catch((error) => {
        this.error = error;
      });
    // Kernel preparation runs in order: startup slots, then each shrink.
    this.kernelWork = this.ready
      .then(() => this.compileSlots())
      .catch((error) => {
        this.error = error;
      });
    renderer.xr.addEventListener("sessionend", this.onSessionEnd);
  }
  createSlot(eyeCount) {
    const uniforms = {
      ...this.state,
      ...makeGenerateUniforms(),
    };
    const keys = bindBuffer(this.keys);
    const seeds = bindBuffer(this.seeds);
    // Compact slot of each mapped Splat, read by the first sort pass.
    const sortValues = N.storage(this.sorter.inputValues, "uint")
      .setName("gslSortInputValues")
      .onObjectUpdate(() => this.sorter.inputValues);
    const counter = N.storage(this.visibleCount, "uint")
      .setName("gslVisibleCount")
      .toAtomic();
    return {
      uniforms,
      node: createProjectionKernel({
        uniforms,
        eyeCount,
        keys,
        seeds,
        sortValues,
        counter,
        cache: this.cache,
      }),
    };
  }
  /** Projection uniforms of the precompiled eyes after the first. */
  ensureEyeUniforms(eyeCount) {
    for (let eye = 1; eye < eyeCount; eye++) {
      if (this.state[`projectionMatrix${eye}`]) continue;
      Object.assign(this.state, {
        [`projectionMatrix${eye}`]: { value: new THREE.Matrix4() },
        [`renderToViewQuat${eye}`]: { value: new THREE.Quaternion() },
        [`renderToViewPos${eye}`]: { value: new THREE.Vector3() },
        [`renderToViewScale${eye}`]: { value: 1 },
        [`near${eye}`]: { value: 0.1 },
        [`far${eye}`]: { value: 1000 },
        [`renderSize${eye}`]: { value: new THREE.Vector2() },
      });
    }
  }
  createSlotSet(eyeCount) {
    this.ensureEyeUniforms(eyeCount);
    this.slotSets.set(eyeCount, {
      compiled: 0,
      slots: Array.from({ length: PROJECT_SLOTS }, () =>
        this.createSlot(eyeCount),
      ),
    });
  }
  /** Warm the remaining slots at startup, yielding between each compilation. */
  async compileSlots() {
    for (let index = 1; index < PROJECT_SLOTS; index++) {
      for (const set of this.slotSets.values()) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.disposed || this.error) return;
        await this.renderer.compileComputeAsync([set.slots[index].node]);
        set.compiled++;
      }
    }
  }
  /** The selected, precompiled mode for mono or WebXR stereo. */
  getSlots(eyeCount) {
    const set = this.slotSets.get(eyeCount);
    if (!set) {
      throw new RangeError("WebGPU Splat projection supports one or two views");
    }
    return set.compiled === set.slots.length
      ? set.slots
      : set.slots.slice(0, set.compiled);
  }
  /** Compact storage and refresh existing bindings without compiling or stopping draws. */
  shrinkResources(getCount) {
    const shrink = this.kernelWork.then(() => this.compact(getCount));
    this.kernelWork = shrink.catch(() => {});
    return shrink;
  }
  async compact(getCount) {
    if (this.error) throw this.error;
    if (this.disposed) return;
    // Read both now: models can load and an XR session can start while
    // startup slots compile.
    const { xr } = this.renderer;
    const views = xr.isPresenting ? getViews(xr.getCamera()).length : 1;
    const resized = this.resize(getCount(), views, true);
    const seedsResized = this.resizeBuffer(
      this.seeds,
      this.uniforms.stochastic.value ? this.capacity : 1,
    );
    const refresh = new Set(resized || seedsResized ? this.nodes : []);
    // Idle slots must release source textures of removed models. The next
    // dispatch fills active slots again; compiled shader graphs stay intact.
    const textures = Object.entries(makeGenerateUniforms()).filter(
      ([, uniform]) => uniform.value?.isTexture,
    );
    for (const { slots } of this.slotSets.values()) {
      for (const { uniforms, node } of slots) {
        for (const [name, { value }] of textures) {
          if (uniforms[name].value !== value) {
            uniforms[name].value = value;
            refresh.add(node);
          }
        }
      }
    }
    if (resized || seedsResized) this.projectedInputs.length = 0;
    // Preparing a compiled node again only refreshes its uniforms and bind
    // groups. Dispose follows this in the queue.
    for (const node of refresh) await this.renderer.compileComputeAsync(node);
  }
  vertexData(camera, stochastic) {
    const multiView = getViews(camera)[0] !== camera;
    const eye = multiView ? N.cameraIndex : N.uint(0);
    const stride = uniformBinding(this.state, "viewStride", "uint");
    // Compute the eye offset before looking up its order.
    const base = eye.mul(stride).toVar();
    const i = N.uint(N.instanceIndex)
      .mul(SPLATS_PER_INSTANCE)
      .add(N.uint(N.positionGeometry.z));
    const count = N.storage(this.visibleCount, "uint")
      .setName("gslVisibleCount")
      .toReadOnly()
      .element(0);
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    const rgba = N.vec4(0).toVar();
    const splatUv = N.vec2(0).toVar();
    const stochasticSeed = stochastic ? N.uint(0).toVar() : undefined;
    const supportRadiusSquared = N.float(0).toVar();
    const kernelPower = N.float(0).toVar();
    const view = splatViewportUniforms(this.uniforms, camera);
    const projectionMatrix = splatProjectionMatrix(camera);
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
    // Indirect draws round up to whole quad groups; trim before any index or
    // cache load, including the unused tail of the final instance.
    N.If(i.lessThan(count), () => {
      // Every eye draws the one shared order of compact slots.
      const cacheIndex = i.toVar();
      const loadOrdered = () => {
        cacheIndex.assign(
          N.storage(this.sorter.ordering, "uint")
            .onObjectUpdate(() => this.sorter.ordering)
            .toReadOnly()
            .element(i),
        );
      };
      if (stochastic) {
        // Unsorted stochastic draws read compacted slots directly.
        N.If(
          uniformBinding(this.uniforms, "stochasticOrdering", "bool"),
          loadOrdered,
        );
      } else {
        loadOrdered();
      }
      stochasticSeed?.assign(
        bindBuffer(this.seeds).toReadOnly().element(cacheIndex),
      );
      const projected = this.cache.read(
        base.add(cacheIndex),
        pixelScale,
        centerRange,
        uniformBinding(this.state, "projectionJitter", "vec2"),
        projectionMatrix,
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
  resizeBuffer(ref, count) {
    if (ref.value.count === count) return false;
    const old = ref.value;
    ref.value = new StorageBufferAttribute(new Uint32Array(count), 1);
    old.dispose();
    return true;
  }
  resize(count, views, shrink = false) {
    const required = Math.max(1, count);
    const bytes = required * 4;
    const byteLimit = Math.min(
      this.limits.maxStorageBufferBindingSize,
      this.limits.maxBufferSize,
    );
    if (bytes > byteLimit) {
      throw new RangeError(
        `WebGPU sort requires ${bytes} bytes per index buffer; device binding limit is ${this.limits.maxStorageBufferBindingSize}. Request higher requiredLimits when creating WebGPURenderer or reduce resident Splats.`,
      );
    }
    const limit = Math.floor(byteLimit / 4);
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
    const viewCapacity =
      shrink || this.shrinkViews ? views : Math.max(views, this.viewCapacity);
    this.shrinkViews = false;
    if (capacity === this.capacity && viewCapacity === this.viewCapacity)
      return false;
    const size = getProjectionCacheSize(capacity * viewCapacity, this.limits);
    this.resizeBuffer(this.keys, capacity);
    this.sorter.resize(capacity, shrink);
    this.cache.resize(size);
    this.capacity = capacity;
    this.viewCapacity = viewCapacity;
    this.state.viewStride.value = capacity;
    return true;
  }
  render(accumulator, camera, geometry, radial, fastSort) {
    if (this.error) throw this.error;
    const cameras = getViews(camera);
    const multiView = cameras[0] !== camera;
    // WebXR eyes share one generated, culled, compacted and sorted set, like
    // one head; each eye still gets its exact projection.
    const slots = this.disposed ? [] : this.getSlots(cameras.length);
    if (slots.length === 0) {
      // Draw nothing only during the initial precompile.
      geometry.setIndirect(null);
      geometry.instanceCount = 0;
      return false;
    }
    this.resize(accumulator.numSplats, cameras.length);
    const { uniforms } = this;
    const stochastic = uniforms.stochastic.value;
    // Only stochastic draws read seeds; sorted rendering keeps one entry.
    this.resizeBuffer(this.seeds, stochastic ? this.capacity : 1);
    // Unsorted stochastic draws need no keys or sort.
    const sortMode = !stochastic
      ? fastSort
        ? "fast"
        : "full"
      : uniforms.stochasticOrdering.value
        ? "front"
        : null;
    if (sortMode) this.state.sortMode.value = RADIX_SORT_MODE_IDS[sortMode];
    this.state.sortRadial.value = radial;
    // TAA exposes its unjittered projection during scene capture. Project and
    // sort without the jitter so a still view reuses the compute results;
    // drawing applies the jitter as an NDC translation.
    const jitter = this.state.projectionJitter.value;
    jitter.set(0, 0);
    const unjittered = getTAAProjection(camera);
    const monoProjection =
      !multiView &&
      unjittered &&
      getProjectionJitter(camera.projectionMatrix, unjittered, jitter)
        ? unjittered
        : null;
    geometry.setIndirect(this.indirect);
    geometry.setSplatCount(Math.max(1, accumulator.numSplats));
    // The accumulator version covers source, mapping, transform, animation and
    // edit changes. Output color settings are draw-only.
    // Reuse the scratch snapshot; publish it only after a successful dispatch.
    const inputs = this.pendingInputs;
    let length = 0;
    inputs[length++] = accumulator;
    inputs[length++] = accumulator.version;
    inputs[length++] = accumulator.viewOrigin.x;
    inputs[length++] = accumulator.viewOrigin.y;
    inputs[length++] = accumulator.viewOrigin.z;
    inputs[length++] = cameras.length;
    inputs[length++] = stochastic;
    // Each mode keys only the sort options it reads.
    inputs[length++] = !stochastic && radial;
    inputs[length++] = sortMode;
    inputs[length++] = uniforms.maxStdDev.value;
    inputs[length++] = uniforms.minPixelRadius.value;
    inputs[length++] = uniforms.minAlpha.value;
    inputs[length++] = uniforms.preBlurAmount.value;
    inputs[length++] = uniforms.blurAmount.value;
    inputs[length++] = uniforms.clipXY.value;
    inputs[length++] = uniforms.focalAdjustment.value;
    for (const { node } of accumulator.mapping)
      inputs[length++] = node.layers.mask;
    for (const view of cameras) {
      for (const value of view.matrixWorld.elements) inputs[length++] = value;
      for (const value of (monoProjection ?? view.projectionMatrix).elements)
        inputs[length++] = value;
      inputs[length++] = view.near;
      inputs[length++] = view.far;
      inputs[length++] = view.layers.mask;
      inputs[length++] = view.viewport?.z ?? uniforms.renderSize.value.x;
      inputs[length++] = view.viewport?.w ?? uniforms.renderSize.value.y;
    }
    inputs.length = length;
    if (
      inputs.length === this.projectedInputs.length &&
      inputs.every((value, index) => value === this.projectedInputs[index])
    )
      return true;
    // A failed or partially submitted update must not reuse the old snapshot.
    this.projectedInputs.length = 0;
    cameras.forEach((view, eye) => {
      this.setEye(eye, view, monoProjection, accumulator);
    });
    this.setSortPose(cameras, accumulator);
    this.dispatch(slots, cameras, accumulator, sortMode);
    this.pendingInputs = this.projectedInputs;
    this.projectedInputs = inputs;
    return true;
  }
  /** Projection uniforms for one eye; eye 0 also serves mono draws. */
  setEye(eye, view, projection, accumulator) {
    const state = this.state;
    const suffix = eye ? `${eye}` : "";
    // WebXR eye viewports are physical pixels; Three draws them as given.
    const viewport = view.viewport;
    state[`projectionMatrix${suffix}`].value.copy(
      projection ?? view.projectionMatrix,
    );
    state[`near${suffix}`].value = view.near;
    state[`far${suffix}`].value = view.far;
    const renderSize = state[`renderSize${suffix}`].value;
    renderSize.copy(this.uniforms.renderSize.value);
    if (viewport) renderSize.set(viewport.z, viewport.w);
    this.matrix
      .copy(view.matrixWorld)
      .invert()
      .multiply(this.translation.makeTranslation(accumulator.viewOrigin))
      .decompose(
        state[`renderToViewPos${suffix}`].value,
        state[`renderToViewQuat${suffix}`].value,
        this.scale,
      );
    state[`renderToViewScale${suffix}`].value =
      (this.scale.x + this.scale.y + this.scale.z) / 3;
  }
  /** Sort from the views' mean pose: the camera, or the WebXR head. */
  setSortPose(views, accumulator) {
    // Read the views at each draw: after a manual update, the accumulator's
    // pose may be stale and only places the render origin.
    getMeanViewPose(views, this.viewPosition, this.state.sortDirection.value);
    this.state.sortOffset.value.subVectors(
      accumulator.viewOrigin,
      this.viewPosition,
    );
  }
  /**
   * Generates, projects, compacts and sorts the meshes any view draws. Sorted
   * modes also visit hidden meshes, which only mark their keys absent.
   */
  dispatch(slots, views, accumulator, sortMode) {
    const pending = [this.resetCount];
    let slotCount = 0;
    for (const { node, base, count, matrixWorld } of accumulator.mapping) {
      const drawn = views.some((view) => view.layers.test(node.layers));
      // Sorting reads a key for every mapped Splat, including hidden meshes.
      if (!drawn && !sortMode) continue;
      // A slot's uniforms can only be changed after its preceding batch has
      // been submitted. Keep the last batch open for draw arguments and sorting.
      if (slotCount === slots.length) {
        this.renderer.compute(pending);
        pending.length = 0;
        slotCount = 0;
      }
      const slot = slots[slotCount++];
      if (drawn) accumulator.prepareUniforms(node, slot.uniforms, matrixWorld);
      slot.uniforms.targetBase.value = base;
      // Hidden meshes read no source data; each Splat fails visibility.
      slot.uniforms.targetCount.value = drawn ? count : 0;
      slot.node.count = count;
      pending.push(slot.node);
    }
    pending.push(this.finish);
    if (sortMode)
      pending.push(...this.sorter.prepare(accumulator.numSplats, sortMode));
    this.renderer.compute(pending);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.projectedInputs.length = 0;
    this.pendingInputs.length = 0;
    this.renderer.xr.removeEventListener("sessionend", this.onSessionEnd);
    void this.kernelWork.then(() => this.disposeResources());
  }
  disposeResources() {
    for (const { slots } of this.slotSets.values())
      for (const { node } of slots) node.dispose();
    this.resetCount.dispose();
    this.finish.dispose();
    this.slotSets.clear();
    this.nodes.length = 0;
    this.sorter.dispose();
    this.cache.dispose();
    this.visibleCount.dispose();
    this.keys.value.dispose();
    this.seeds.value.dispose();
    this.indirect.dispose();
  }
}
