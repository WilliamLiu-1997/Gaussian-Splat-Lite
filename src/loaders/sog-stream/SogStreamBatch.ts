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

  constructor(count: number, numSh: number) {
    const { capacity, layerSize } = sogBatchTextureLayout(count);
    const arrays = Array.from(
      { length: 2 + SH_ARRAY_COUNTS[numSh] },
      () => new Uint32Array(capacity * 4),
    );
    const packed: SplatResult = {
      numSplats: 0,
      splatArrays: [arrays[0], arrays[1]],
      sortCenters: new Float32Array(capacity * 3),
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
    return { visibilityChanged: (previous === 0) !== (opacity === 0) };
  }

  override copySortCenters(
    target: Float32Array,
    targetStart: number,
    count: number,
  ) {
    super.copySortCenters(target, targetStart, count);
    // Invisible cached slots stay allocated but do not enter CPU/worker sorting.
    for (let start = 0; start < count; start += BLOCK_SIZE) {
      if (this.blockValues[(start / BLOCK_SIZE) * 4 + 3] !== 0) continue;
      target.fill(
        Number.NaN,
        targetStart + start * 3,
        targetStart + Math.min(count, start + BLOCK_SIZE) * 3,
      );
    }
  }

  override copySplatRecords(
    firstTarget: Uint32Array,
    secondTarget: Uint32Array,
    sourceStart: number,
    count: number,
  ) {
    super.copySplatRecords(firstTarget, secondTarget, sourceStart, count);
    // Raycasting uses packed source records rather than the generated fade table.
    for (let index = 0; index < count; index++) {
      const block = Math.floor((sourceStart + index) / BLOCK_SIZE);
      if (this.blockValues[block * 4 + 3] === 0) firstTarget[index * 4 + 3] = 0;
    }
  }

  override setTextureUniforms(uniforms: Record<string, THREE.IUniform>) {
    uniforms.sourceSplats.value = this.batchTextures[0];
    uniforms.sourceSplats2.value = this.batchTextures[1];
    uniforms.sh1Texture.value = this.batchTextures[2] ?? Splats.emptyTexture;
    uniforms.sh2Texture.value = this.batchTextures[3] ?? Splats.emptyTexture;
    uniforms.sh3TextureA.value = this.batchTextures[4] ?? Splats.emptyTexture;
    uniforms.sh3TextureB.value = this.batchTextures[5] ?? Splats.emptyTexture;
    uniforms.sourceLayerBits.value = Math.log2(this.layerSize);
    uniforms.sourceBlockBits.value = BLOCK_BITS;
    uniforms.sourceBlocks.value = this.blockTexture;
    this.needsUpdate = false;
  }

  get residentBytes() {
    const textureBytes = this.batchTextures.reduce(
      (bytes, texture) => bytes + (texture.image.data?.byteLength ?? 0),
      0,
    );
    return (
      this.getByteLength() + textureBytes + this.blockValues.byteLength * 2
    );
  }

  override dispose() {
    super.dispose();
    for (const texture of this.batchTextures) texture.dispose();
    this.batchTextures = [];
    this.blockTexture.dispose();
    this.blockValues = new Float32Array(0);
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
  private visibleRegions = 0;

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
    this.numSplats = this.source.numSplats;
    this.slots.set(start, count);
  }

  setRegionOpacity(start: number, opacity: number) {
    const count = this.slots.get(start);
    if (count === undefined) return;
    const changed = this.source.setOpacity(start, count, opacity);
    if (!changed) return;
    this.updateVersion({ sort: changed.visibilityChanged });
    if (changed.visibilityChanged) {
      this.visibleRegions += opacity > 0 ? 1 : -1;
      if (opacity > 0 && this.visibleRegions === 1) {
        this.layers.mask = this.group.layers.mask;
        this.group.add(this);
      } else if (this.visibleRegions === 0) this.removeFromParent();
    }
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
    this.numSplats = this.source.numSplats;
  }
}
