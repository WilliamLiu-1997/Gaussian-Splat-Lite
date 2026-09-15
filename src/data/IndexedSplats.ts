import * as THREE from "three";
import { SplatOpacityTable } from "./SplatOpacityTable";
import { Splats, type SplatsOptions } from "./Splats";
import {
  type ReorderedSplatResult,
  SPLAT_BOUNDS_BLOCK_SIZE,
  SPLAT_TEX_WIDTH,
  type SplatResult,
} from "./defines";
import type { RaycastRangeCallback, SplatRaycastQuery } from "./raycast";
import { decodeShRgbToArray } from "./splatCodec";
import { SH_ARRAY_COUNTS, SH_KEYS, getSplatTextureBytes } from "./splatData";
import { getTextureSize } from "./textureLayout";
import { decodeSplat } from "./unpack";

type IndexedSplatsOptions = {
  capacity: number;
  layerSize: number;
  numSh: number;
  blockBits: number;
};

function makeTexture(
  data: Uint32Array,
  width: number,
  height: number,
  depth: number,
) {
  const texture = new THREE.DataArrayTexture(data, width, height, depth);
  texture.format = THREE.RGBAIntegerFormat;
  texture.type = THREE.UnsignedIntType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

type DecodedSplat = ReturnType<typeof decodeSplat>;
type DecodedSplatWithSh = DecodedSplat & { sh: THREE.Color[] };

/** Fixed packed storage with one visible-index contract for rendering and CPU reads.
 * Fades affect display only: records returned to picking retain their source opacity. */
export abstract class IndexedSplats extends Splats {
  readonly layerSize: number;
  readonly numSh: 0 | 1 | 2 | 3;
  protected readonly opacities: SplatOpacityTable;
  protected sourceIndices = new Uint32Array(0);
  protected visibleIndices: Uint32Array;
  private sourceArrays: Uint32Array[];
  private sourceCenters: Float32Array;
  private sourceTextures: THREE.DataArrayTexture[];
  private indexTexture = Splats.emptyTexture;
  private readonly blockBits: number;
  private readonly dirtyLayers = new Set<number>();
  private uploadCharged = false;
  private disposed = false;
  private readonly spatialChunks = new Map<
    number,
    { count: number; bounds: Float32Array }
  >();
  private spatialBoundsBytes = 0;

  constructor({ capacity, layerSize, numSh, blockBits }: IndexedSplatsOptions) {
    // RAD and SOG layout helpers supply aligned power-of-two layers.
    if (capacity > 0x1_0000_0000)
      throw new Error("Indexed Splat capacity exceeds 32-bit addressing");
    super();
    this.maxSplats = capacity;
    this.layerSize = layerSize;
    this.numSh = numSh as 0 | 1 | 2 | 3;
    this.blockBits = blockBits;
    this.opacities = new SplatOpacityTable(capacity, layerSize, blockBits);
    this.sourceArrays = Array.from(
      { length: 2 + SH_ARRAY_COUNTS[numSh] },
      () => new Uint32Array(capacity * 4),
    );
    this.sourceCenters = new Float32Array(this.sourceArrays[0].buffer);
    this.sourceIds = new Uint32Array(capacity);
    this.visibleIndices = new Uint32Array(capacity);
    this.sourceTextures = this.sourceArrays.map((array) =>
      makeTexture(
        array,
        SPLAT_TEX_WIDTH,
        layerSize / SPLAT_TEX_WIDTH,
        capacity / layerSize,
      ),
    );
  }

  protected assertLive() {
    if (this.disposed) throw new Error("Streaming Splat source is disposed");
  }

  override initialize(options: SplatsOptions = {}) {
    // Splats calls initialize once during super(); fixed storage is installed next.
    if (this.sourceArrays !== undefined)
      throw new Error("Streaming sources cannot be reinitialized");
    return super.initialize(options);
  }

  /** Range-based sources can materialize their visible map lazily. */
  protected ensureIndices() {}

  /** Each source updates its bounds independently of the visible-index map. */
  protected commitIndices(indices: Uint32Array) {
    const target = this.prepareIndices(indices.length);
    for (let index = 0; index < indices.length; index++) {
      const source = indices[index];
      target[index] = source;
      this.visibleIndices[source] = index;
    }
  }

  /** Reserve index storage and mark it for upload; fill the first count entries synchronously. */
  protected prepareIndices(count: number) {
    this.assertLive();
    if (
      count > this.sourceIndices.length ||
      count < this.sourceIndices.length / 4
    ) {
      const layout = getTextureSize(Math.max(1, Math.ceil(count / 4)));
      const capacity = layout.maxSplats * 4;
      if (capacity !== this.sourceIndices.length) {
        if (this.indexTexture !== Splats.emptyTexture)
          this.indexTexture.dispose();
        this.sourceIndices = new Uint32Array(capacity);
        this.indexTexture = makeTexture(
          this.sourceIndices,
          layout.width,
          layout.height,
          layout.depth,
        );
      }
    }
    this.numSplats = count;
    if (this.indexTexture !== Splats.emptyTexture)
      this.indexTexture.needsUpdate = true;
    this.needsUpdate = true;
    return this.sourceIndices;
  }

  beginUpdate() {
    this.dirtyLayers.clear();
  }

  /** The first write accounts for a complete GPU allocation on either backend. */
  uploadBytes(start: number, count: number) {
    if (!this.uploadCharged) return this.initialUploadBytes;
    let layers = 0;
    for (
      let layer = Math.floor(start / this.layerSize);
      layer < Math.ceil((start + count) / this.layerSize);
      layer++
    )
      if (!this.dirtyLayers.has(layer)) layers++;
    return (
      getSplatTextureBytes(layers * this.layerSize, this.numSh) +
      ((layers * this.layerSize) / 2 ** this.blockBits) * 4
    );
  }

  /** Copies packed records. Input buffers remain caller-owned for both formats. */
  protected writeRecords(
    start: number,
    data: ReorderedSplatResult,
    allocation: number,
  ) {
    this.assertLive();
    const count = data.numSplats;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(allocation) ||
      allocation < count ||
      start + allocation > this.maxSplats
    )
      throw new Error("Invalid streaming Splat write range");
    const arrays = [
      ...data.splatArrays,
      ...SH_KEYS.slice(0, SH_ARRAY_COUNTS[this.numSh]).map(
        (key) => data.extra[key],
      ),
    ];
    if (
      arrays.length !== this.sourceArrays.length ||
      data.sourceIds.length < count ||
      arrays.some(
        (array) =>
          count > 0 &&
          (!(array instanceof Uint32Array) || array.length < count * 4),
      )
    )
      throw new Error("Incomplete packed Splat or SH records");
    if (
      data.spatialBounds?.length !==
      Math.ceil(count / SPLAT_BOUNDS_BLOCK_SIZE) * 6
    )
      throw new Error("Incorrect spatial bounds block length");
    this.releaseSpatialBounds(start);
    // Packed data remains caller-owned, as do its spatial bounds.
    const bounds = data.spatialBounds.slice();
    this.spatialChunks.set(start, { count, bounds });
    this.spatialBoundsBytes += bounds.byteLength;
    this.sourceIds.set(data.sourceIds.subarray(0, count), start);
    this.sourceIds.fill(0, start + count, start + allocation);
    const firstLayer = Math.floor(start / this.layerSize);
    const lastLayer = Math.ceil((start + allocation) / this.layerSize);
    for (let index = 0; index < this.sourceArrays.length; index++) {
      const target = this.sourceArrays[index];
      const source = arrays[index];
      if (source) target.set(source.subarray(0, count * 4), start * 4);
      target.fill(0, (start + count) * 4, (start + allocation) * 4);
      for (let layer = firstLayer; layer < lastLayer; layer++)
        this.sourceTextures[index].addLayerUpdate(layer);
      this.sourceTextures[index].needsUpdate = true;
    }
    for (let layer = firstLayer; layer < lastLayer; layer++)
      this.dirtyLayers.add(layer);
    this.uploadCharged = true;
    this.needsUpdate = true;
  }

  private getStorageIndex(index: number) {
    this.assertLive();
    this.ensureIndices();
    this.checkVisibleRange(index, 1);
    return this.sourceIndices[index];
  }

  override getSourceIndex(index: number) {
    return this.sourceIds[this.getStorageIndex(index)];
  }

  private checkVisibleRange(start: number, count: number) {
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      start + count > this.numSplats
    )
      throw new Error("Invalid visible Splat range");
  }

  override getNumSh() {
    return this.numSh;
  }

  private get textureByteLength() {
    return (
      this.sourceArrays.reduce((bytes, array) => bytes + array.byteLength, 0) +
      this.sourceIndices.byteLength +
      this.opacities.byteLength
    );
  }

  override getByteLength() {
    return (
      this.textureByteLength +
      this.sourceIds.byteLength +
      this.centerOnlyBounds.byteLength +
      this.bounds.byteLength +
      this.spatialBoundsBytes +
      this.visibleIndices.byteLength
    );
  }

  get residentBytes() {
    return this.getByteLength() + this.textureByteLength;
  }

  get initialUploadBytes() {
    return (
      getSplatTextureBytes(this.maxSplats, this.numSh) +
      this.opacities.byteLength
    );
  }

  private center(source: number, axis: number) {
    const second = this.sourceArrays[1];
    const base = source * 4;
    return second[base + 1] >>> 16 === 0xfc00 && second[base + 2] === 0xfc00fc00
      ? Number.NaN
      : this.sourceCenters[base + axis];
  }

  override copySortCenters(
    target: Float32Array,
    targetStart: number,
    count: number,
  ) {
    this.assertLive();
    this.ensureIndices();
    this.checkVisibleRange(0, count);
    if (
      !Number.isSafeInteger(targetStart) ||
      targetStart < 0 ||
      targetStart + count * 3 > target.length
    )
      throw new Error("Invalid sort center target range");
    for (let index = 0; index < count; index++)
      for (let axis = 0; axis < 3; axis++)
        target[targetStart + index * 3 + axis] = this.center(
          this.sourceIndices[index],
          axis,
        );
  }

  protected releaseSpatialBounds(start: number) {
    const chunk = this.spatialChunks.get(start);
    if (chunk) {
      this.spatialBoundsBytes -= chunk.bounds.byteLength;
      this.spatialChunks.delete(start);
    }
  }

  override forEachRaycastRange(
    query: SplatRaycastQuery,
    callback: RaycastRangeCallback,
  ) {
    this.assertLive();
    this.ensureIndices();
    let rangeStart = -1;
    let rangeEnd = -1;
    for (const [start, { count, bounds }] of this.spatialChunks) {
      query.forEachRange(bounds, count, (base, length) => {
        for (
          let source = start + base;
          source < start + base + length;
          source++
        ) {
          const index = this.visibleIndices[source];
          // Validate against the current cut so hidden slots need no clearing.
          if (index >= this.numSplats || this.sourceIndices[index] !== source)
            continue;
          if (index !== rangeEnd) {
            if (rangeStart >= 0) callback(rangeStart, rangeEnd - rangeStart);
            rangeStart = index;
          }
          rangeEnd = index + 1;
        }
      });
    }
    if (rangeStart >= 0) callback(rangeStart, rangeEnd - rangeStart);
  }

  override copySplatRecords(
    firstTarget: Uint32Array,
    secondTarget: Uint32Array,
    sourceStart: number,
    count: number,
  ) {
    this.assertLive();
    this.ensureIndices();
    this.checkVisibleRange(sourceStart, count);
    if (firstTarget.length < count * 4 || secondTarget.length < count * 4)
      throw new Error("Splat record target is too small");
    for (let index = 0; index < count; index++) {
      const source = this.sourceIndices[sourceStart + index] * 4;
      for (let word = 0; word < 4; word++) {
        firstTarget[index * 4 + word] = this.sourceArrays[0][source + word];
        secondTarget[index * 4 + word] = this.sourceArrays[1][source + word];
      }
    }
  }

  override getSplat(index: number): DecodedSplatWithSh;
  override getSplat(index: number, includeSh: true): DecodedSplatWithSh;
  override getSplat(index: number, includeSh: false): DecodedSplat;
  override getSplat(index: number, includeSh: boolean): DecodedSplat;
  override getSplat(index: number, includeSh = true) {
    const source = this.getStorageIndex(index);
    const splat = decodeSplat(
      [this.sourceArrays[0], this.sourceArrays[1]],
      source,
    );
    if (!includeSh) return splat;
    const rgb = [0, 0, 0];
    const sh = Array.from(
      { length: [0, 3, 8, 15][this.numSh] },
      (_, coefficient) => {
        const word =
          this.sourceArrays[2 + (coefficient >> 2)][
            source * 4 + (coefficient & 3)
          ];
        decodeShRgbToArray(word, rgb);
        return new THREE.Color(rgb[0], rgb[1], rgb[2]);
      },
    );
    return { ...splat, sh };
  }

  override forEachCenter(
    callback: (index: number, x: number, y: number, z: number) => void,
  ) {
    this.assertLive();
    this.ensureIndices();
    for (let index = 0; index < this.numSplats; index++) {
      const source = this.sourceIndices[index];
      callback(
        index,
        this.center(source, 0),
        this.center(source, 1),
        this.center(source, 2),
      );
    }
  }

  override forEachSplat(callback: Parameters<Splats["forEachSplat"]>[0]) {
    this.assertLive();
    this.ensureIndices();
    for (let index = 0; index < this.numSplats; index++) {
      const splat = this.getSplat(index, false);
      callback(
        index,
        splat.center,
        splat.scales,
        splat.quaternion,
        splat.opacity,
        splat.color,
      );
    }
  }

  override takeData(): SplatResult & { sourceIds: Uint32Array } {
    this.assertLive();
    this.ensureIndices();
    const count = this.numSplats;
    const sourceIds = new Uint32Array(count);
    for (let i = 0; i < count; i++)
      sourceIds[i] = this.sourceIds[this.sourceIndices[i]];
    const arrays = this.sourceArrays.map((source) => {
      const target = new Uint32Array(count * 4);
      for (let index = 0; index < count; index++) {
        const offset = this.sourceIndices[index] * 4;
        for (let word = 0; word < 4; word++)
          target[index * 4 + word] = source[offset + word];
      }
      return target;
    });
    const data = {
      numSplats: count,
      splatArrays: [arrays[0], arrays[1]],
      sourceIds,
      extra: Object.fromEntries(
        arrays.slice(2).map((array, index) => [SH_KEYS[index], array]),
      ),
    } satisfies SplatResult;
    this.dispose();
    return data;
  }

  override setTextureUniforms(uniforms: Record<string, THREE.IUniform>) {
    this.assertLive();
    this.ensureIndices();
    uniforms.sourceSplats.value = this.sourceTextures[0];
    uniforms.sourceSplats2.value = this.sourceTextures[1];
    uniforms.sh1Texture.value = this.sourceTextures[2] ?? Splats.emptyTexture;
    uniforms.sh2Texture.value = this.sourceTextures[3] ?? Splats.emptyTexture;
    uniforms.sh3TextureA.value = this.sourceTextures[4] ?? Splats.emptyTexture;
    uniforms.sh3TextureB.value = this.sourceTextures[5] ?? Splats.emptyTexture;
    uniforms.sourceLayerBits.value = Math.log2(this.layerSize);
    uniforms.sourceLayerMask.value = this.layerSize - 1;
    uniforms.sourceBlockBits.value = this.blockBits;
    uniforms.sourceBlocks.value = this.opacities.texture;
    uniforms.sourceOpacities.value = this.opacities.opacityTexture;
    uniforms.sourceIndexed.value = true;
    uniforms.sourceIndices.value = this.indexTexture;
    this.needsUpdate = false;
  }

  override dispose() {
    if (this.disposed) return;
    super.dispose();
    for (const texture of this.sourceTextures) texture.dispose();
    if (this.indexTexture !== Splats.emptyTexture) this.indexTexture.dispose();
    this.opacities.dispose();
    this.sourceArrays = [];
    this.sourceTextures = [];
    this.sourceCenters = new Float32Array(0);
    this.sourceIndices = new Uint32Array(0);
    this.visibleIndices = new Uint32Array(0);
    this.indexTexture = Splats.emptyTexture;
    this.dirtyLayers.clear();
    this.spatialChunks.clear();
    this.spatialBoundsBytes = 0;
    this.disposed = true;
  }
}
