import * as THREE from "three";
import { Splats, type SplatsOptions } from "../../data/Splats";
import {
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_WIDTH,
  type SplatResult,
} from "../../data/defines";
import {
  SH_ARRAY_COUNTS,
  SH_KEYS,
  getSplatTextureBytes,
} from "../../data/splatData";
import { getTextureSize } from "../../data/textureLayout";
import { SplatMesh } from "../../scene/SplatMesh";

// Small allocation blocks avoid a separate 2048-Splat texture row per region.
const BLOCK_BITS = 6;
const BLOCK_SIZE = 1 << BLOCK_BITS;
const MIN_LAYER_SIZE = 8192;

export function sogBatchAllocationSize(count: number) {
  return Math.ceil(count / BLOCK_SIZE) * BLOCK_SIZE;
}

export function sogBatchTextureLayout(count: number) {
  // Grow the layer dimensions instead of splitting a chunk into more Meshes.
  // Keep the same backing-array alignment as Splats to avoid a second copy.
  const aligned = getTextureSize(count).maxSplats;
  const layerSize = Math.min(
    SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT,
    Math.max(MIN_LAYER_SIZE, 2 ** Math.ceil(Math.log2(aligned / 256))),
  );
  return {
    capacity: Math.ceil(aligned / layerSize) * layerSize,
    layerSize,
  };
}

function makeTexture(data: Uint32Array, capacity: number, layerSize: number) {
  const texture = new THREE.DataArrayTexture(
    data,
    SPLAT_TEX_WIDTH,
    layerSize / SPLAT_TEX_WIDTH,
    capacity / layerSize,
  );
  texture.format = THREE.RGBAIntegerFormat;
  texture.type = THREE.UnsignedIntType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** Packed source with small independently uploaded layers and a fade table. */
class BatchSplats extends Splats {
  readonly layerSize: number;
  private packed: SplatResult;
  private batchTextures: THREE.DataArrayTexture[];
  private blockValues: Float32Array;
  private blockTexture: THREE.DataTexture;
  private readonly activeRanges = new Map<number, number>();
  private activeCount = 0;
  private indicesDirty = false;
  private indices = new Uint32Array(0);
  private indexTexture = Splats.emptyTexture;

  constructor(count: number, numSh: number) {
    const { capacity, layerSize } = sogBatchTextureLayout(count);
    const arrays = Array.from(
      { length: 2 + SH_ARRAY_COUNTS[numSh] },
      () => new Uint32Array(capacity * 4),
    );
    const packed: SplatResult = {
      numSplats: 0,
      splatArrays: [arrays[0], arrays[1]],
      extra: Object.fromEntries(
        arrays.slice(2).map((array, index) => [SH_KEYS[index], array]),
      ),
    };
    super(packed as SplatsOptions);
    this.layerSize = layerSize;
    this.packed = packed;
    this.batchTextures = arrays.map((array) =>
      makeTexture(array, capacity, layerSize),
    );
    const blockCount = capacity / BLOCK_SIZE;
    const width = Math.min(SPLAT_TEX_WIDTH, blockCount);
    const height = Math.ceil(blockCount / width);
    const blocks = new Uint32Array(width * height * 4);
    this.blockValues = new Float32Array(blocks.buffer);
    this.blockTexture = new THREE.DataTexture(
      blocks,
      width,
      height,
      THREE.RGBAIntegerFormat,
      THREE.UnsignedIntType,
    );
    this.blockTexture.needsUpdate = true;
  }

  write(start: number, data: Splats) {
    const count = data.getNumSplats();
    const source = data.takeData();
    for (let index = 0; index < 2; index++) {
      this.packed.splatArrays[index].set(
        source.splatArrays[index].subarray(0, count * 4),
        start * 4,
      );
    }
    for (const key of SH_KEYS) {
      const target = this.packed.extra[key];
      const array = source.extra[key];
      if (target && array) target.set(array.subarray(0, count * 4), start * 4);
    }
    // Slot padding must never participate in rendering or sorting.
    const second = this.packed.splatArrays[1];
    for (
      let index = start + count;
      index < start + sogBatchAllocationSize(count);
      index++
    ) {
      second[index * 4 + 1] = 0xfc000000;
      second[index * 4 + 2] = 0xfc00fc00;
    }
    const firstLayer = Math.floor(start / this.layerSize);
    const lastLayer = Math.ceil((start + count) / this.layerSize);
    for (const texture of this.batchTextures) {
      for (let layer = firstLayer; layer < lastLayer; layer++)
        texture.addLayerUpdate(layer);
      texture.needsUpdate = true;
    }
    this.numSplats = Math.max(this.numSplats, start + count);
    this.needsUpdate = true;
  }

  setOpacity(start: number, count: number, opacity: number) {
    const first = start / BLOCK_SIZE;
    const previous = this.blockValues[first * 4 + 3];
    if (previous === Math.fround(opacity)) return;
    const last = first + sogBatchAllocationSize(count) / BLOCK_SIZE;
    for (let block = first; block < last; block++) {
      const offset = block * 4;
      this.blockValues[offset] = 1;
      this.blockValues[offset + 1] = 1;
      this.blockValues[offset + 2] = 1;
      this.blockValues[offset + 3] = opacity;
    }
    this.blockTexture.needsUpdate = true;
    const visibilityChanged = (previous === 0) !== (opacity === 0);
    if (visibilityChanged) {
      if (opacity > 0) this.activeRanges.set(start, count);
      else this.activeRanges.delete(start);
      this.activeCount += opacity > 0 ? count : -count;
      this.indicesDirty = true;
    }
    return { visibilityChanged };
  }

  // Renderer-facing methods share compact indices; packed storage keeps its
  // fixed source slots and high-water mark in numSplats.
  override getNumSplats() {
    return this.activeCount;
  }

  private updateIndices() {
    if (!this.indicesDirty) return;
    // Four source indices per texel. Capacity follows visible records rather
    // than the highest occupied source slot; fade-only updates reuse the map.
    if (
      this.activeCount > this.indices.length ||
      this.activeCount < this.indices.length / 4
    ) {
      const { width, height, maxSplats } = getTextureSize(
        Math.max(1, Math.ceil(this.activeCount / 4)),
      );
      const length = maxSplats * 4;
      if (length !== this.indices.length) {
        if (this.indexTexture !== Splats.emptyTexture)
          this.indexTexture.dispose();
        this.indices = new Uint32Array(length);
        this.indexTexture = makeTexture(
          this.indices,
          maxSplats,
          width * height,
        );
      }
    }
    let target = 0;
    for (const [start, count] of this.activeRanges) {
      for (let index = start; index < start + count; index++)
        this.indices[target++] = index;
    }
    this.indexTexture.needsUpdate = true;
    this.indicesDirty = false;
  }

  override copySortCenters(
    target: Float32Array,
    targetStart: number,
    count: number,
  ) {
    if (count > this.activeCount || targetStart + count * 3 > target.length)
      throw new Error("Invalid sort center copy range");
    this.updateIndices();
    const [first, second] = this.packed.splatArrays;
    const centers = new Float32Array(
      first.buffer,
      first.byteOffset,
      first.length,
    );
    for (let index = 0; index < count; index++) {
      const source = this.indices[index] * 4;
      const disabled =
        second[source + 1] >>> 16 === 0xfc00 &&
        second[source + 2] === 0xfc00fc00;
      for (let axis = 0; axis < 3; axis++)
        target[targetStart + index * 3 + axis] = disabled
          ? Number.NaN
          : centers[source + axis];
    }
  }

  override copySplatRecords(
    firstTarget: Uint32Array,
    secondTarget: Uint32Array,
    sourceStart: number,
    count: number,
  ) {
    if (sourceStart + count > this.activeCount)
      throw new Error("Invalid rendered Splat copy range");
    this.updateIndices();
    const [first, second] = this.packed.splatArrays;
    for (let index = 0; index < count; index++) {
      const source = this.indices[sourceStart + index] * 4;
      for (let word = 0; word < 4; word++) {
        firstTarget[index * 4 + word] = first[source + word];
        secondTarget[index * 4 + word] = second[source + word];
      }
    }
  }

  override setTextureUniforms(uniforms: Record<string, THREE.IUniform>) {
    this.updateIndices();
    uniforms.sourceSplats.value = this.batchTextures[0];
    uniforms.sourceSplats2.value = this.batchTextures[1];
    uniforms.sh1Texture.value = this.batchTextures[2] ?? Splats.emptyTexture;
    uniforms.sh2Texture.value = this.batchTextures[3] ?? Splats.emptyTexture;
    uniforms.sh3TextureA.value = this.batchTextures[4] ?? Splats.emptyTexture;
    uniforms.sh3TextureB.value = this.batchTextures[5] ?? Splats.emptyTexture;
    uniforms.sourceLayerBits.value = Math.log2(this.layerSize);
    uniforms.sourceBlockBits.value = BLOCK_BITS;
    uniforms.sourceBlocks.value = this.blockTexture;
    uniforms.sourceIndexed.value = true;
    uniforms.sourceIndices.value = this.indexTexture;
    this.needsUpdate = false;
  }

  get residentBytes() {
    const textureBytes = this.batchTextures.reduce(
      (bytes, texture) => bytes + (texture.image.data?.byteLength ?? 0),
      0,
    );
    return (
      this.getByteLength() +
      textureBytes +
      (this.blockValues.byteLength + this.indices.byteLength) * 2
    );
  }

  override dispose() {
    super.dispose();
    for (const texture of this.batchTextures) texture.dispose();
    this.batchTextures = [];
    this.blockTexture.dispose();
    this.blockValues = new Float32Array(0);
    if (this.indexTexture !== Splats.emptyTexture) this.indexTexture.dispose();
    this.indexTexture = Splats.emptyTexture;
    this.indices = new Uint32Array(0);
    this.activeRanges.clear();
    this.activeCount = 0;
    this.indicesDirty = false;
    this.packed = {
      numSplats: 0,
      splatArrays: [new Uint32Array(0), new Uint32Array(0)],
      extra: {},
    };
  }
}

/** Regions share one source, one scene node and one accumulator generation call. */
export class SogStreamBatch extends SplatMesh {
  private readonly source: BatchSplats;
  private readonly slots = new Map<number, number>();
  private readonly dirtyLayers = new Set<number>();

  constructor(
    capacity: number,
    readonly numSh: number,
    private readonly group: THREE.Group,
    private readonly onEmpty: () => void,
  ) {
    const source = new BatchSplats(capacity, numSh);
    super({ splats: source });
    this.source = source;
    this.name = "sog-batch";
  }

  get residentBytes() {
    return this.source.residentBytes;
  }

  beginUpdate() {
    this.dirtyLayers.clear();
    this.layers.mask = this.group.layers.mask;
  }

  uploadBytes(start: number, count: number) {
    let layers = 0;
    for (
      let layer = Math.floor(start / this.source.layerSize);
      layer < Math.ceil((start + count) / this.source.layerSize);
      layer++
    ) {
      if (!this.dirtyLayers.has(layer)) layers++;
    }
    return getSplatTextureBytes(layers * this.source.layerSize, this.numSh);
  }

  writeRegion(start: number, data: Splats) {
    const count = data.getNumSplats();
    // The scheduler assigns disjoint fixed slots; only occupancy changes.
    if (this.slots.has(start))
      throw new Error("Streaming batch region slot is occupied");
    this.source.write(start, data);
    for (
      let layer = Math.floor(start / this.source.layerSize);
      layer < Math.ceil((start + count) / this.source.layerSize);
      layer++
    )
      this.dirtyLayers.add(layer);
    this.slots.set(start, count);
  }

  setRegionOpacity(start: number, opacity: number) {
    const count = this.slots.get(start);
    if (count === undefined) return;
    const changed = this.source.setOpacity(start, count, opacity);
    if (!changed) return;
    if (changed.visibilityChanged) {
      this.numSplats = this.source.getNumSplats();
      this.updateMappingVersion();
      if (this.numSplats > 0 && this.parent !== this.group) {
        this.layers.mask = this.group.layers.mask;
        this.group.add(this);
      } else if (this.numSplats === 0) this.removeFromParent();
    } else this.updateVersion({ sort: false });
  }

  releaseRegion(start: number) {
    if (!this.slots.has(start)) return;
    this.setRegionOpacity(start, 0);
    this.slots.delete(start);
    if (!this.slots.size) {
      this.dispose();
      this.onEmpty();
      return;
    }
    this.source.numSplats = 0;
    for (const [offset, count] of this.slots)
      this.source.numSplats = Math.max(this.source.numSplats, offset + count);
  }
}
