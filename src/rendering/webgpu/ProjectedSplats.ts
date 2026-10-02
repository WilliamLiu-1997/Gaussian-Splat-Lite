import * as THREE from "three";
import type { ComputeNode } from "three/webgpu";
import {
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
  type WebGPURenderer,
} from "three/webgpu";
import { getTAAProjection } from "../../addons/taaShared";

import type { SplatAccumulator } from "../SplatAccumulator";
import { SPLATS_PER_INSTANCE, type SplatGeometry } from "../SplatGeometry";
import { getMeanViewPose, getViews } from "../rendererUtils";
import { createGenerateProgram } from "../tsl/GenerateProgram";
import { createProjectionProgram } from "../tsl/ProjectionProgram";
import type { ProjectedVertexData } from "../tsl/SplatMaterial";
import { N, type UniformType, uniformBinding } from "../tsl/shaderUtils";
import { splatViewportUniforms } from "../tsl/viewUniforms";
import { type Uniforms, makeGenerateUniforms } from "../uniforms";
import { ProjectionCache, getProjectionCacheSize } from "./ProjectionCache";
import {
  INVALID_SORT_KEY,
  RADIX_SORT_MODE_IDS,
  type RadixSortMode,
  WebGPURadixSort,
} from "./RadixSort";

const WORKGROUP_SIZE = 256;
const PROJECT_SLOTS = 8;

type BufferRef = { value: StorageBufferAttribute; name: string };
type ComputeSlot = { uniforms: Uniforms; node: ComputeNode };
type SlotSet = { slots: ComputeSlot[]; compiled: number };
type DeviceLimits = {
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxTextureArrayLayers: number;
  maxTextureDimension2D: number;
  maxComputeWorkgroupsPerDimension: number;
};
type ComputeRenderer = WebGPURenderer & {
  compileComputeAsync(nodes: ComputeNode[]): Promise<void>;
  backend: { device: { limits: DeviceLimits } };
};

function buffer(name: string): BufferRef {
  return { value: new StorageBufferAttribute(new Uint32Array(1), 1), name };
}

/**
 * Stores in `jitter` the NDC translation that `jittered` adds to `base`, as
 * TAA's sub-pixel view offsets do. Returns false for any other difference.
 */
function getProjectionJitter(
  jittered: THREE.Matrix4,
  base: THREE.Matrix4,
  jitter: THREE.Vector2,
) {
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
    new Uint32Array([SPLATS_PER_INSTANCE * 6, 0, 0, 0, 0]),
    1,
  );
  /** Common kernels, the full sorter and the first slot are ready; remaining slots warm automatically. */
  readonly ready: Promise<void>;
  error: unknown = null;
  /**
   * Called when kernels for a new WebXR eye count can draw, or when a slot
   * fails to compile. Draws hide Splats until then, so on-demand hosts must
   * redraw.
   */
  onKernelsReady?: () => void;

  private readonly limits: DeviceLimits;
  private readonly cache = new ProjectionCache();
  private readonly visibleCount = new StorageBufferAttribute(
    new Uint32Array(1),
    1,
  );
  private readonly keys = buffer("gslProjectionKeys");
  private readonly seeds = buffer("gslProjectionSeeds");
  private readonly sorter: WebGPURadixSort;
  // Slots for each eye count. One eye compiles at startup; WebXR eye counts
  // compile as a session starts or on first use, so other draws pay nothing.
  private readonly slotSets = new Map<number, SlotSet>();
  private readonly compilations: Promise<void>[] = [];
  private readonly onSessionStart = () => void this.getSlots(2);
  private shrinkViews = false;
  private readonly onSessionEnd = () => {
    this.shrinkViews = true;
    this.onKernelsReady?.();
  };
  private readonly resetCount: ComputeNode;
  private readonly finish: ComputeNode;
  private readonly state: Uniforms;
  private readonly matrix = new THREE.Matrix4();
  private readonly translation = new THREE.Matrix4();
  private readonly scale = new THREE.Vector3();
  private readonly viewPosition = new THREE.Vector3();
  private capacity = 0;
  private viewCapacity = 0;
  private disposed = false;
  private projectedInputs: unknown[] = [];

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
    const mono = this.createSlotSet(1);
    this.ready = computeRenderer
      .compileComputeAsync([
        this.resetCount,
        this.finish,
        ...this.sorter.nodes,
        mono.slots[0].node,
      ])
      .then(() => {
        mono.compiled = 1;
      })
      .catch((error: unknown) => {
        this.error = error;
      });
    this.compilations.push(this.ready.then(() => this.compileSlots(mono)));
    renderer.xr.addEventListener("sessionstart", this.onSessionStart);
    renderer.xr.addEventListener("sessionend", this.onSessionEnd);
  }

  private createSlot(eyeCount = 1): ComputeSlot {
    this.ensureEyeUniforms(eyeCount);
    const uniforms = {
      ...this.state,
      ...makeGenerateUniforms(),
    };
    const u = <Type extends UniformType>(name: string, type: Type) =>
      uniformBinding(uniforms, name, type);
    const generate = createGenerateProgram({ uniforms });
    // Eye 0 reads the unsuffixed uniforms; later eyes append their index.
    const eyes = Array.from({ length: eyeCount }, (_, eye) =>
      eye ? `${eye}` : "",
    ).map((suffix) => ({
      project: createProjectionProgram(uniforms, {
        projectionMatrix: u(`projectionMatrix${suffix}`, "mat4"),
        renderToViewQuat: u(`renderToViewQuat${suffix}`, "vec4"),
        renderToViewPos: u(`renderToViewPos${suffix}`, "vec3"),
        renderToViewScale: u(`renderToViewScale${suffix}`, "float"),
        near: u(`near${suffix}`, "float"),
        far: u(`far${suffix}`, "float"),
        renderSize: u(`renderSize${suffix}`, "vec2"),
      }),
      pixelScale: u(`renderSize${suffix}`, "vec2")
        .mul(u("focalAdjustment", "float"))
        .mul(0.5),
    }));
    const viewStride = u("viewStride", "uint");
    const direction = u("sortDirection", "vec3");
    const sortOffset = u("sortOffset", "vec3");
    const radial = u("sortRadial", "bool");
    const sortMode = u("sortMode", "uint");
    const front = sortMode.equal(N.uint(RADIX_SORT_MODE_IDS.front));
    const stochastic = u("stochastic", "bool");
    const centerRange = u("clipXY", "float").abs().max(1).mul(1.000001);
    const keys = bindBuffer(this.keys);
    const seeds = bindBuffer(this.seeds);
    // Compact slot of each mapped Splat, read by the first sort pass.
    const sortValues = N.storage(this.sorter.inputValues, "uint")
      .setName("gslSortInputValues")
      .onObjectUpdate(() => this.sorter.inputValues);
    const counter = N.storage(this.visibleCount, "uint")
      .setName("gslVisibleCount")
      .toAtomic();
    const node = N.Fn(() => {
      const index = N.uint(N.instanceIndex);
      // Sorted draws key each Splat at its mapping index, not its atomic slot.
      // The first radix pass compacts keys in mapping order, so equal keys
      // keep source order every frame.
      const sorted = stochastic
        .not()
        .or(u("stochasticOrdering", "bool"))
        .toVar();
      const mappingIndex = u("targetBase", "uint").add(index).toVar();
      // Decode, edit and evaluate color once, then project for each eye.
      const generated = generate.prepare(index);
      const projected = eyes.map(({ project }) => {
        const projection = project(generated, false);
        const extent = projection.axis1.abs().add(projection.axis2.abs());
        const ndc = projection.clipCenter.xy.div(projection.clipCenter.w);
        // Reject only quads wholly outside the viewport; clipXY and every
        // existing visual cutoff remain part of the shared projection math.
        const onscreen = N.all(ndc.abs().lessThanEqual(extent.add(1)));
        return { projection, ndc, visible: projection.valid.and(onscreen) };
      });
      // Shared culling keeps Splats any eye draws.
      const visible = projected
        .slice(1)
        .reduce((any, eye) => any.or(eye.visible), projected[0].visible);
      N.If(visible, () => {
        const rgb = generated.resolveRgb().toVar();
        // Compact survivors and their stable seeds into the same slots.
        const slot = N.atomicAdd(counter.element(0), N.uint(1)).toVar();
        projected.forEach(({ projection, ndc, visible: eyeVisible }, eye) => {
          const cacheIndex = viewStride.mul(eye).add(slot);
          const write = () => {
            projection.rgba.rgb.assign(rgb);
            this.cache.write(
              cacheIndex,
              projection,
              ndc,
              eyes[eye].pixelScale,
              centerRange,
            );
          };
          if (eyeCount > 1) {
            N.If(eyeVisible, write).Else(() => {
              this.cache.writeHidden(cacheIndex);
            });
          } else {
            write();
          }
        });
        N.If(stochastic, () => {
          seeds.element(slot).assign(generated.stochasticSeed);
        });
        // Sorted blending orders back to front by depth or distance;
        // stochastic ordering uses front-to-back depth.
        N.If(sorted, () => {
          const center = generated.center.add(sortOffset);
          const metric = N.select(
            radial.and(front.not()),
            center.dot(center),
            center.dot(direction),
          );
          const bits = N.floatBitsToUint(metric);
          // Non-finite metrics draw last; INVALID_SORT_KEY marks absence.
          const key = N.uint(INVALID_SORT_KEY - 1).toVar();
          N.If(
            bits.bitAnd(N.uint(0x7fffffff)).lessThan(N.uint(0x7f800000)),
            () => {
              // Signed float bits in ascending order, preserved across
              // negative view depths; inverted for back-to-front keys.
              const ascending = N.select(
                bits.bitAnd(N.uint(0x80000000)).notEqual(0),
                bits.bitXor(N.uint(0xffffffff)),
                bits.bitXor(N.uint(0x80000000)),
              );
              key.assign(
                ascending.bitXor(
                  N.select(front, N.uint(0), N.uint(0xffffffff)),
                ),
              );
            },
          );
          // Discard low mantissa bits before storing the key: front keys keep
          // 16 bits and fast keys 24. Projection/depth cache precision is
          // independent of this sorting approximation.
          const shift = N.select(
            front,
            N.uint(16),
            N.select(
              sortMode.equal(N.uint(RADIX_SORT_MODE_IDS.fast)),
              N.uint(8),
              N.uint(0),
            ),
          );
          keys.element(mappingIndex).assign(key.shiftRight(shift));
          sortValues.element(mappingIndex).assign(slot);
        });
      }).Else(() => {
        N.If(sorted, () => {
          keys.element(mappingIndex).assign(N.uint(INVALID_SORT_KEY));
        });
      });
    })()
      .compute(1, [WORKGROUP_SIZE])
      .setName(
        eyeCount > 1
          ? `Splat generate project compact ${eyeCount} eyes`
          : "Splat generate project compact",
      );
    return { uniforms, node };
  }

  /** Projection uniforms of each eye after the first, created on demand. */
  private ensureEyeUniforms(eyeCount: number) {
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

  private createSlotSet(eyeCount: number): SlotSet {
    const set: SlotSet = {
      slots: Array.from({ length: PROJECT_SLOTS }, () =>
        this.createSlot(eyeCount),
      ),
      compiled: 0,
    };
    this.slotSets.set(eyeCount, set);
    return set;
  }

  /**
   * Compiled slots that project this many eyes. One eye uses the startup
   * slots; WebXR eye counts build theirs on first request.
   */
  private getSlots(eyeCount: number) {
    let set = this.slotSets.get(eyeCount);
    if (!set) {
      set = this.createSlotSet(eyeCount);
      this.compilations.push(this.compileSlots(set));
    }
    return set.slots.slice(0, set.compiled);
  }

  private async compileSlots(set: SlotSet) {
    try {
      // A drawable set yields first, so readiness callbacks run before the
      // slots that only batch more meshes.
      if (set.compiled > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      while (!this.disposed && !this.error && set.compiled < set.slots.length) {
        await (this.renderer as ComputeRenderer).compileComputeAsync([
          set.slots[set.compiled].node,
        ]);
        set.compiled++;
        // The first slot is enough to draw; later ones only batch more meshes.
        if (set.compiled === 1 && !this.disposed) this.onKernelsReady?.();
      }
    } catch (error) {
      this.error = error;
      // The next draw throws the compilation error.
      if (!this.disposed) this.onKernelsReady?.();
    }
  }

  vertexData(camera: THREE.Camera, stochastic: boolean): ProjectedVertexData {
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
      return;
    const size = getProjectionCacheSize(capacity * viewCapacity, this.limits);
    this.resizeBuffer(this.keys, capacity);
    this.sorter.resize(capacity, shrink);
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
    fastSort: boolean,
    shrink = false,
  ) {
    if (this.error) throw this.error;
    const cameras = getViews(camera) as THREE.PerspectiveCamera[];
    const multiView = cameras[0] !== camera;
    // WebXR eyes share one generated, culled, compacted and sorted set, like
    // one head; each eye still gets its exact projection.
    const slots = this.disposed ? [] : this.getSlots(cameras.length);
    if (slots.length === 0) {
      // Draw nothing until the kernels for this eye count compile.
      geometry.setIndirect(null);
      geometry.instanceCount = 0;
      return false;
    }
    this.resize(accumulator.numSplats, cameras.length, shrink);
    const { uniforms } = this;
    const stochastic = uniforms.stochastic.value;
    // Only stochastic draws read seeds; sorted rendering keeps one entry.
    this.resizeBuffer(this.seeds, stochastic ? this.capacity : 1);
    // Unsorted stochastic draws need no keys or sort.
    const sortMode: RadixSortMode | null = !stochastic
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
    const jitter = this.state.projectionJitter.value as THREE.Vector2;
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
    const inputs = [
      accumulator,
      accumulator.version,
      ...accumulator.viewOrigin.toArray(),
      cameras.length,
      stochastic,
      // Each mode keys only the sort options it reads.
      !stochastic && radial,
      sortMode,
      uniforms.maxStdDev.value,
      uniforms.minPixelRadius.value,
      uniforms.maxPixelRadius.value,
      uniforms.minAlpha.value,
      uniforms.preBlurAmount.value,
      uniforms.blurAmount.value,
      uniforms.clipXY.value,
      uniforms.focalAdjustment.value,
    ];
    for (const { node } of accumulator.mapping) inputs.push(node.layers.mask);
    for (const view of cameras) {
      inputs.push(
        ...view.matrixWorld.elements,
        ...(monoProjection ?? view.projectionMatrix).elements,
        view.near,
        view.far,
        view.layers.mask,
        view.viewport?.z ?? uniforms.renderSize.value.x,
        view.viewport?.w ?? uniforms.renderSize.value.y,
      );
    }
    if (
      !shrink &&
      inputs.length === this.projectedInputs.length &&
      inputs.every((value, index) => value === this.projectedInputs[index])
    )
      return true;
    // A failed or partially submitted update must not reuse the old snapshot.
    this.projectedInputs = [];
    cameras.forEach((view, eye) => {
      this.setEye(eye, view, monoProjection, accumulator);
    });
    this.setSortPose(cameras, accumulator);
    this.dispatch(slots, cameras, accumulator, sortMode);
    this.projectedInputs = inputs;
    return true;
  }

  /** Projection uniforms for one eye; eye 0 also serves mono draws. */
  private setEye(
    eye: number,
    view: THREE.PerspectiveCamera,
    projection: THREE.Matrix4 | null,
    accumulator: SplatAccumulator,
  ) {
    const state = this.state;
    const suffix = eye ? `${eye}` : "";
    // WebXR eye viewports are physical pixels; Three draws them as given.
    const viewport = view.viewport;
    state[`projectionMatrix${suffix}`].value.copy(
      projection ?? view.projectionMatrix,
    );
    state[`near${suffix}`].value = view.near;
    state[`far${suffix}`].value = view.far;
    const renderSize = state[`renderSize${suffix}`].value as THREE.Vector2;
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
  private setSortPose(
    views: THREE.PerspectiveCamera[],
    accumulator: SplatAccumulator,
  ) {
    // Read the views at each draw: after a manual update, the accumulator's
    // pose may be stale and only places the render origin.
    getMeanViewPose(
      views,
      this.viewPosition,
      this.state.sortDirection.value as THREE.Vector3,
    );
    (this.state.sortOffset.value as THREE.Vector3).subVectors(
      accumulator.viewOrigin,
      this.viewPosition,
    );
  }

  /**
   * Generates, projects, compacts and sorts the meshes any view draws. Sorted
   * modes also visit hidden meshes, which only mark their keys absent.
   */
  private dispatch(
    slots: ComputeSlot[],
    views: THREE.Camera[],
    accumulator: SplatAccumulator,
    sortMode: RadixSortMode | null,
  ) {
    const pending: ComputeNode[] = [this.resetCount];
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
    this.projectedInputs = [];
    this.renderer.xr.removeEventListener("sessionstart", this.onSessionStart);
    this.renderer.xr.removeEventListener("sessionend", this.onSessionEnd);
    void Promise.all(this.compilations).then(() => this.disposeResources());
  }

  private disposeResources() {
    for (const { slots } of this.slotSets.values())
      for (const slot of slots) slot.node.dispose();
    for (const node of [this.resetCount, this.finish]) node.dispose();
    this.sorter.dispose();
    this.cache.dispose();
    this.visibleCount.dispose();
    this.keys.value.dispose();
    this.seeds.value.dispose();
    this.indirect.dispose();
  }
}
