import * as THREE from "three";
import { SplatOpacityTable } from "./SplatOpacityTable.js";
import { Splats } from "./Splats.js";
import {
  getBlindLayerUpdates,
  getBlindTextureLayout,
  getBlindUploadBytes,
} from "./blindData.js";
import { getBlindLayoutKey } from "./blindFields.js";
import { SPLAT_BOUNDS_BLOCK_SIZE, SPLAT_TEX_WIDTH } from "./defines.js";
import { decodeShRgbToArray } from "./splatCodec.js";
import {
  SH_ARRAY_COUNTS,
  SH_KEYS,
  createSplatTextureArrays,
  getSplatTextureCount,
} from "./splatData.js";
import { disposeDataTexture, getTextureSize } from "./textureLayout.js";
import { decodeSplat } from "./unpack.js";
function makeTexture(
  data,
  width,
  height,
  depth,
  format = THREE.RGBAIntegerFormat,
) {
  const texture = new THREE.DataArrayTexture(data, width, height, depth);
  texture.format = format;
  texture.type = THREE.UnsignedIntType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}
/** Fixed packed storage with one visible-index contract for rendering and CPU reads.
 * Fades affect display only: records returned to picking retain their source opacity. */
export class IndexedSplats extends Splats {
  constructor({
    capacity,
    layerSize,
    numSh,
    blockBits,
    packedOpacityGroups = false,
    storage,
    deferAllocation = false,
    indexedSh = false,
    palette,
    blindFields = [],
  }) {
    // RAD and SOG supply aligned power-of-two layers.
    if (capacity > 0x1_0000_0000)
      throw new Error("Indexed Splat capacity exceeds 32-bit addressing");
    super();
    this.sourceIndices = new Uint32Array(0);
    this.indexTexture = Splats.emptyTexture;
    this.disposed = false;
    /** Owner's pending-upload queue; written layers wait there for the renderer. */
    this.uploadQueue = undefined;
    this.spatialBoundsBytes = 0;
    // A view draws its own indices from another source's packed records,
    // opacity groups and spatial bounds; that source writes and owns them.
    this.storage = storage;
    this.palette = palette;
    if (storage) {
      this.spatialChunks = storage.spatialChunks;
      this.maxSplats = storage.maxSplats;
      this.layerSize = storage.layerSize;
      this.numSh = storage.numSh;
      this.indexedSh = storage.indexedSh;
      this.blockBits = storage.blockBits;
      this.opacities = storage.opacities;
      this.sourceArrays = storage.sourceArrays;
      this.sourceCenters = storage.sourceCenters;
      this.sourceTextures = storage.sourceTextures;
      this.extra.blind = storage.extra.blind;
      this.blindTexture = storage.blindTexture;
      this.blindFieldGroups = storage.blindFields;
      this.needsUpdate = true;
      return;
    }
    this.spatialChunks = new Map();
    this.maxSplats = capacity;
    this.layerSize = layerSize;
    this.numSh = numSh;
    this.indexedSh = indexedSh;
    this.blockBits = blockBits;
    this.opacities = new SplatOpacityTable(
      capacity,
      layerSize,
      blockBits,
      packedOpacityGroups,
    );
    this.sourceArrays = [];
    this.sourceTextures = [];
    if (!deferAllocation)
      for (const array of createSplatTextureArrays(capacity, numSh, indexedSh))
        this.allocateTexture(array);
    // Streamed regions must match the batch's Blind layout.
    this.blindFieldGroups = blindFields;
    if (blindFields.length) {
      const layout = getBlindTextureLayout(
        capacity,
        blindFields.length,
        layerSize,
      );
      const packed = new Uint32Array(layout.maxSplats);
      this.extra.blind = blindFields.map((fields, index) => ({
        fields,
        data: packed.subarray(index * capacity, (index + 1) * capacity),
      }));
      this.blindTexture = makeTexture(
        packed,
        layout.width,
        layout.height,
        layout.depth,
        THREE.RedIntegerFormat,
      );
    }
    this.blindLayout = getBlindLayoutKey(this.extra.blind);
  }
  /** Create one packed texture from its array, which may come from a worker. */
  allocateTexture(array) {
    const texture = makeTexture(
      array,
      SPLAT_TEX_WIDTH,
      this.layerSize / SPLAT_TEX_WIDTH,
      this.maxSplats / this.layerSize,
      this.indexedSh && this.sourceArrays.length === 2
        ? THREE.RedIntegerFormat
        : THREE.RGBAIntegerFormat,
    );
    this.sourceArrays.push(array);
    this.sourceTextures.push(texture);
    if (this.sourceArrays.length === 1)
      this.sourceCenters = new Float32Array(array.buffer);
    return texture;
  }
  assertLive() {
    if (this.disposed) throw new Error("Streaming Splat source is disposed");
  }
  initialize(options = {}) {
    // Splats calls initialize once during super(); fixed storage is installed next.
    if (this.sourceArrays !== undefined)
      throw new Error("Streaming sources cannot be reinitialized");
    return super.initialize(options);
  }
  /** Range-based sources can materialize their visible map lazily. */
  ensureIndices() {}
  /** Reserve index storage and mark it for upload; fill the first count entries synchronously. */
  prepareIndices(count, maxCapacity = Number.POSITIVE_INFINITY) {
    this.assertLive();
    if (
      count > this.sourceIndices.length ||
      count < this.sourceIndices.length / 4 ||
      this.sourceIndices.length > maxCapacity
    ) {
      const layout = getTextureSize(Math.max(1, Math.ceil(count / 4)), 1);
      const capacity = layout.maxSplats * 4;
      if (capacity !== this.sourceIndices.length) {
        if (this.indexTexture !== Splats.emptyTexture)
          disposeDataTexture(this.indexTexture);
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
  /** Copies packed records. Input buffers remain caller-owned for both formats. */
  writeRecords(start, data, allocation, numSh = this.numSh) {
    this.assertLive();
    if (this.storage) throw new Error("Write records through a view's storage");
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
    if (!Number.isInteger(numSh) || numSh < 0 || numSh > this.numSh)
      throw new Error("Invalid streaming Splat SH degree");
    if (!!data.extra.shDegree !== this.indexedSh)
      throw new Error("Streaming SH storage representation mismatch");
    if (getBlindLayoutKey(data.extra.blind) !== this.blindLayout)
      throw new Error("Streaming blind field layout mismatch");
    const arrays = [
      ...data.splatArrays,
      ...(this.indexedSh
        ? [data.extra.shLabels]
        : SH_KEYS.slice(0, SH_ARRAY_COUNTS[numSh]).map(
            (key) => data.extra[key],
          )),
    ];
    if (
      arrays.length !== getSplatTextureCount(numSh, this.indexedSh) ||
      arrays.some(
        (array, index) =>
          count > 0 &&
          (!(array instanceof Uint32Array) ||
            array.length < count * (this.indexedSh && index === 2 ? 1 : 4)),
      )
    )
      throw new Error("Incomplete packed Splat or SH records");
    if (
      data.spatialBounds?.length !==
      Math.ceil(count / SPLAT_BOUNDS_BLOCK_SIZE) * 6
    )
      throw new Error("Incorrect spatial bounds block length");
    for (const { data: array } of data.extra.blind ?? []) {
      if (!(array instanceof Uint32Array) || array.length < count)
        throw new Error("Incomplete blind records");
    }
    this.releaseSpatialBounds(start);
    // Packed data remains caller-owned, as do its spatial bounds.
    const bounds = data.spatialBounds.slice();
    this.spatialChunks.set(start, { count, bounds });
    this.spatialBoundsBytes += bounds.byteLength;
    const firstLayer = Math.floor(start / this.layerSize);
    const lastLayer = Math.ceil((start + allocation) / this.layerSize);
    for (let index = 0; index < this.sourceArrays.length; index++) {
      const target = this.sourceArrays[index];
      const source = arrays[index];
      const stride = target.length / this.maxSplats;
      if (source)
        target.set(source.subarray(0, count * stride), start * stride);
      // A lower-SH page may reuse a slot previously occupied by higher SH.
      target.fill(
        0,
        (start + (source ? count : 0)) * stride,
        (start + allocation) * stride,
      );
      for (let layer = firstLayer; layer < lastLayer; layer++)
        this.sourceTextures[index].addLayerUpdate(layer);
      this.sourceTextures[index].needsUpdate = true;
    }
    const blindTexture = this.blindTexture;
    this.extra.blind?.forEach((group, index) => {
      group.data.set(data.extra.blind[index].data.subarray(0, count), start);
      group.data.fill(0, start + count, start + allocation);
    });
    if (blindTexture) {
      const { width, height } = blindTexture.image;
      for (const layer of getBlindLayerUpdates(
        this.maxSplats,
        this.extra.blind.length,
        start,
        allocation,
        width * height,
      ))
        blindTexture.addLayerUpdate(layer);
      blindTexture.needsUpdate = true;
    }
    this.needsUpdate = true;
    this.uploadQueue?.add(this);
  }
  /** Remaining dirty layers; successful uploads clear them in the renderer. */
  get pendingUploadBytes() {
    let bytes = 0;
    for (const texture of [...this.sourceTextures, this.blindTexture])
      if (texture)
        bytes +=
          (texture.layerUpdates.size * texture.image.data.byteLength) /
          texture.image.depth;
    return bytes;
  }
  /** Additional upload bytes for layers in [firstLayer, lastLayer). */
  getUploadBytes(firstLayer, lastLayer) {
    let bytes = 0;
    for (const texture of this.sourceTextures)
      for (let layer = firstLayer; layer < lastLayer; layer++)
        if (!texture.layerUpdates.has(layer))
          bytes += texture.image.data.byteLength / texture.image.depth;
    return (
      bytes +
      getBlindUploadBytes(
        this.maxSplats,
        this.blindFieldGroups.length,
        this.layerSize,
        firstLayer,
        lastLayer,
        this.blindTexture?.layerUpdates,
      )
    );
  }
  /** Upload written layers now, including storage not yet in the scene. */
  uploadPending(renderer) {
    for (const texture of [...this.sourceTextures, this.blindTexture])
      if (texture?.layerUpdates.size) renderer.initTexture(texture);
  }
  getStorageIndex(index) {
    this.assertLive();
    this.ensureIndices();
    this.checkVisibleRange(index, 1);
    return this.sourceIndices[index];
  }
  checkVisibleRange(start, count) {
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      start + count > this.numSplats
    )
      throw new Error("Invalid visible Splat range");
  }
  getNumSh() {
    return this.numSh;
  }
  /** Estimated GPU storage for packed records, render indices and opacity tables. */
  get textureByteLength() {
    let bytes = this.sourceIndices.byteLength;
    // A view's records and opacity groups count toward its storage.
    if (!this.storage) {
      for (const array of this.sourceArrays) bytes += array.byteLength;
      bytes += this.blindTexture?.image.data.byteLength ?? 0;
      bytes += this.opacities.byteLength + (this.palette?.byteLength ?? 0);
    }
    return bytes;
  }
  getByteLength() {
    return (
      this.textureByteLength +
      this.centerOnlyBounds.byteLength +
      this.bounds.byteLength +
      this.spatialBoundsBytes
    );
  }
  center(source, axis) {
    const second = this.sourceArrays[1];
    const base = source * 4;
    return second[base + 1] >>> 16 === 0xfc00 && second[base + 2] === 0xfc00fc00
      ? Number.NaN
      : this.sourceCenters[base + axis];
  }
  copySortCenters(target, targetStart, count) {
    this.assertLive();
    this.ensureIndices();
    this.checkVisibleRange(0, count);
    if (
      !Number.isSafeInteger(targetStart) ||
      targetStart < 0 ||
      targetStart + count * 3 > target.length
    )
      throw new Error("Invalid sort center target range");
    const centers = this.sourceCenters;
    const second = this.sourceArrays[1];
    const indices = this.sourceIndices;
    for (let index = 0; index < count; index++) {
      const source = indices[index] * 4;
      const offset = targetStart + index * 3;
      const removed =
        second[source + 1] >>> 16 === 0xfc00 &&
        second[source + 2] === 0xfc00fc00;
      target[offset] = removed ? Number.NaN : centers[source];
      target[offset + 1] = removed ? Number.NaN : centers[source + 1];
      target[offset + 2] = removed ? Number.NaN : centers[source + 2];
    }
  }
  releaseSpatialBounds(start) {
    const chunk = this.spatialChunks.get(start);
    if (chunk) {
      this.spatialBoundsBytes -= chunk.bounds.byteLength;
      this.spatialChunks.delete(start);
    }
  }
  copySplatRecords(firstTarget, secondTarget, sourceStart, count) {
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
  getSplat(index, includeSh = true) {
    const source = this.getStorageIndex(index);
    const splat = decodeSplat(
      [this.sourceArrays[0], this.sourceArrays[1]],
      source,
    );
    if (!includeSh) return splat;
    const rgb = [0, 0, 0];
    const sh = Array.from(
      { length: this.numSh * (this.numSh + 2) },
      (_, coefficient) => {
        const word = this.palette
          ? this.palette.word(this.sourceArrays[2][source], coefficient)
          : this.sourceArrays[2 + (coefficient >> 2)][
              source * 4 + (coefficient & 3)
            ];
        decodeShRgbToArray(word, rgb);
        return new THREE.Color(rgb[0], rgb[1], rgb[2]);
      },
    );
    return { ...splat, sh };
  }
  forEachCenter(callback) {
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
  forEachSplat(callback) {
    this.assertLive();
    this.ensureIndices();
    let splat;
    const records = [this.sourceArrays[0], this.sourceArrays[1]];
    for (let index = 0; index < this.numSplats; index++) {
      splat = decodeSplat(records, this.sourceIndices[index], splat);
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
  takeData() {
    this.assertLive();
    this.ensureIndices();
    const count = this.numSplats;
    const gather = (source) => {
      const stride = source.length / this.maxSplats;
      const target = new Uint32Array(count * stride);
      for (let index = 0; index < count; index++) {
        const offset = this.sourceIndices[index] * stride;
        for (let word = 0; word < stride; word++)
          target[index * stride + word] = source[offset + word];
      }
      return target;
    };
    const arrays = this.sourceArrays.map(gather);
    const data = {
      numSplats: count,
      splatArrays: [arrays[0], arrays[1]],
      extra: this.indexedSh
        ? {
            shLabels: arrays[2],
            shDegree: this.numSh,
            // Another view or a cached chunk may still bind this palette.
            shPalette: this.palette?.data.slice(),
          }
        : Object.fromEntries(
            arrays.slice(2).map((array, index) => [SH_KEYS[index], array]),
          ),
    };
    if (this.extra.blind?.length)
      data.extra.blind = this.extra.blind.map(({ fields, data }) => ({
        fields,
        data: gather(data),
      }));
    this.dispose();
    return data;
  }
  setTextureUniforms(uniforms) {
    this.assertLive();
    this.ensureIndices();
    uniforms.sourceSplats.value = this.sourceTextures[0];
    uniforms.sourceSplats2.value = this.sourceTextures[1];
    uniforms.shBlock0Texture.value =
      this.sourceTextures[2] ?? Splats.emptyTexture;
    uniforms.shBlock1Texture.value =
      this.sourceTextures[3] ?? Splats.emptyTexture;
    uniforms.shBlock2Texture.value =
      this.sourceTextures[4] ?? Splats.emptyTexture;
    uniforms.shBlock3Texture.value =
      this.sourceTextures[5] ?? Splats.emptyTexture;
    uniforms.shBlock4Texture.value =
      this.sourceTextures[6] ?? Splats.emptyTexture;
    uniforms.shBlock5Texture.value =
      this.sourceTextures[7] ?? Splats.emptyTexture;
    uniforms.shLabelsTexture.value = this.indexedSh
      ? this.sourceTextures[2]
      : Splats.emptyTexture;
    uniforms.shPaletteStride.value = 0;
    this.palette?.bind(uniforms);
    uniforms.sourceLayerBits.value = Math.log2(this.layerSize);
    uniforms.sourceLayerMask.value = this.layerSize - 1;
    uniforms.sourceBlockBits.value = this.blockBits;
    uniforms.sourcePackedGroups.value = this.opacities.packedGroups;
    uniforms.sourceBlocks.value = this.opacities.texture;
    uniforms.sourceOpacities.value = this.opacities.opacityTexture;
    uniforms.sourceIndexed.value = true;
    uniforms.sourceIndices.value = this.indexTexture;
    this.needsUpdate = false;
  }
  dispose() {
    if (this.disposed) return;
    // Views borrow their input's palette; owners release it through Splats.
    if (this.storage) {
      this.palette = undefined;
      this.blindTexture = undefined;
    }
    super.dispose();
    if (this.indexTexture !== Splats.emptyTexture)
      disposeDataTexture(this.indexTexture);
    if (this.storage) {
      // Shared records, opacity groups and bounds stay with the storage.
      this.storage = undefined;
      this.spatialChunks = new Map();
    } else {
      this.uploadQueue?.delete(this);
      for (const texture of this.sourceTextures) disposeDataTexture(texture);
      this.opacities.dispose();
      this.spatialChunks.clear();
    }
    this.uploadQueue = undefined;
    this.sourceArrays = [];
    this.sourceTextures = [];
    this.sourceCenters = new Float32Array(0);
    this.sourceIndices = new Uint32Array(0);
    this.indexTexture = Splats.emptyTexture;
    this.spatialBoundsBytes = 0;
    this.disposed = true;
  }
}
