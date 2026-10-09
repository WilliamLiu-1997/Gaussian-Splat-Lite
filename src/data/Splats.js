import * as THREE from "three";
import {
  SPLAT_BLOCKS_DISABLED,
  SPLAT_BOUNDS_BLOCK_SIZE,
  SPLAT_TEX_WIDTH_BITS,
} from "./defines.js";
import { decodeShRgbToArray } from "./splatCodec.js";
import {
  SH_KEYS,
  getSplatByteLength,
  getSplatShDegree,
  resetSplatBounds,
} from "./splatData.js";
import { getTextureSize } from "./textureLayout.js";
import { decodeSplat } from "./unpack.js";
const SH_COUNTS = [0, 3, 8, 15];
function validateInitializationInputs(options) {
  if ("splatArrays" in options)
    throw new Error(
      "splatArrays initialization is not supported; use url, file, or fileBytes",
    );
  const inputs = [];
  if (options.url !== undefined) inputs.push("url");
  if (options.file !== undefined) inputs.push("file");
  if (options.fileBytes !== undefined) inputs.push("fileBytes");
  if (inputs.length > 1) {
    throw new Error(
      `Splats initialization inputs are mutually exclusive; provide only one of url, file, or fileBytes (received: ${inputs.join(", ")})`,
    );
  }
  return inputs.length > 0;
}
function createDecodedState(data) {
  const [first, second] = data.splatArrays;
  if (first.length !== second.length) {
    throw new Error("splatArrays must have the same length");
  }
  if (first.length % 4 !== 0) {
    throw new Error("splatArrays must contain complete four-word records");
  }
  const inputCapacity = first.length / 4;
  const numSplats = data.numSplats;
  if (
    !Number.isSafeInteger(numSplats) ||
    numSplats < 0 ||
    numSplats > inputCapacity
  ) {
    throw new Error("numSplats must be an integer within splatArrays");
  }
  if (
    data.sortCenters !== undefined &&
    data.sortCenters.length < numSplats * 3
  ) {
    throw new Error("sortCenters is smaller than numSplats");
  }
  if (data.sourceIds.length < numSplats)
    throw new Error("sourceIds is smaller than numSplats");
  if (data.centerOnlyBoundingBox?.length !== 6)
    throw new Error("Decoded center bounds must contain six values");
  if (data.boundingBox?.length !== 6)
    throw new Error("Decoded bounds must contain six values");
  if (
    data.spatialBounds?.length !==
    Math.ceil(numSplats / SPLAT_BOUNDS_BLOCK_SIZE) * 6
  )
    throw new Error("Incorrect spatial bounds block length");
  const maxSplats = getTextureSize(inputCapacity).maxSplats;
  let splatArrays = data.splatArrays;
  if (maxSplats !== inputCapacity) {
    splatArrays = [
      new Uint32Array(maxSplats * 4),
      new Uint32Array(maxSplats * 4),
    ];
    splatArrays[0].set(first);
    splatArrays[1].set(second);
  }
  return { ...data, maxSplats, splatArrays };
}
function createEmptyState() {
  const bounds = new Float32Array(6);
  resetSplatBounds(bounds);
  return {
    maxSplats: 0,
    numSplats: 0,
    splatArrays: [new Uint32Array(0), new Uint32Array(0)],
    sourceIds: new Uint32Array(0),
    spatialBounds: new Float32Array(0),
    centerOnlyBoundingBox: bounds,
    boundingBox: bounds.slice(),
    extra: {},
  };
}
/** An encoded splat source with two 16-byte texture records per splat. */
export class Splats {
  constructor(options = {}) {
    this.maxSplats = 0;
    this.numSplats = 0;
    this.splatArrays = [new Uint32Array(0), new Uint32Array(0)];
    this.extra = {};
    this.isInitialized = false;
    this.needsUpdate = true;
    this.shTextures = {};
    this.textures = [Splats.emptyTexture, Splats.emptyTexture];
    this.initialized = Promise.resolve(this);
    this.initialize(options);
  }
  initialize(options = {}) {
    const isAsync = validateInitializationInputs(options);
    const state = createEmptyState();
    this.loadController?.abort();
    const controller = isAsync ? new AbortController() : undefined;
    this.loadController = controller;
    this.isInitialized = false;
    this.commitState(state);
    if (controller) {
      // Publish the readiness promise before starting the file load.
      this.initialized = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return this.asyncInitialize(options, controller.signal);
        })
        .then((state) => {
          if (this.loadController === controller) {
            this.commitState(state);
            this.isInitialized = true;
          }
          return this;
        })
        .finally(() => {
          if (this.loadController === controller)
            this.loadController = undefined;
        });
      // Disposing may cancel a load whose readiness promise was not observed.
      void this.initialized.catch(() => {});
    } else {
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
    }
    return this.initialized;
  }
  commitState(state) {
    this.disposeTextures();
    this.maxSplats = state.maxSplats;
    this.numSplats = state.numSplats;
    this.splatArrays = state.splatArrays;
    this.sortCenters = state.sortCenters;
    this.sourceIds = state.sourceIds;
    this.centerOnlyBounds = state.centerOnlyBoundingBox;
    this.bounds = state.boundingBox;
    this.spatialBounds = state.spatialBounds;
    this.extra = state.extra;
    this.needsUpdate = true;
  }
  /** @internal Adopt a loader result with precomputed bounds. */
  initializeDecoded(data) {
    const state = createDecodedState(data);
    this.initialize();
    this.commitState(state);
  }
  async asyncInitialize(options, signal) {
    const { loadSplatData } = await import("../loaders/loadSplatData.js");
    const decoded = await loadSplatData({ ...options, signal });
    return createDecodedState(decoded);
  }
  dispose() {
    this.loadController?.abort();
    this.loadController = undefined;
    this.isInitialized = false;
    this.commitState(createEmptyState());
  }
  disposeTextures() {
    this.disposeMainTextures();
    for (const texture of Object.values(this.shTextures)) {
      texture?.dispose();
    }
    this.shTextures = {};
  }
  getNumSplats() {
    return this.numSplats;
  }
  /** @internal Copy cached local bounds into the target box. */
  getBoundingBox(centersOnly = true, target = new THREE.Box3()) {
    if (!this.isInitialized) throw new Error("Splats is not initialized");
    const bounds = centersOnly ? this.centerOnlyBounds : this.bounds;
    target.min.fromArray(bounds, 0);
    target.max.fromArray(bounds, 3);
    return target;
  }
  getNumSh() {
    return getSplatShDegree(this.extra);
  }
  /** Current retained bytes for encoded Splat, sort-center, and SH arrays. */
  getByteLength() {
    return getSplatByteLength({
      splatArrays: this.splatArrays,
      sortCenters: this.sortCenters,
      sourceIds: this.sourceIds,
      centerOnlyBoundingBox: this.centerOnlyBounds,
      boundingBox: this.bounds,
      spatialBounds: this.spatialBounds,
      extra: this.extra,
    });
  }
  /** @internal Consume owned arrays for transfer to a streaming worker. */
  takeData() {
    if (!this.isInitialized) throw new Error("Splats is not initialized");
    const data = {
      numSplats: this.numSplats,
      splatArrays: this.splatArrays,
      sortCenters: this.sortCenters,
      sourceIds: this.sourceIds,
      centerOnlyBoundingBox: this.centerOnlyBounds,
      boundingBox: this.bounds,
      spatialBounds: this.spatialBounds,
      extra: this.extra,
    };
    this.dispose();
    return data;
  }
  /** Original source ID, retained across reordering and range extraction. */
  getSourceIndex(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.numSplats)
      throw new Error("Invalid splat index");
    return this.sourceIds[index];
  }
  getSplat(index, includeSh = true) {
    if (index < 0 || index >= this.numSplats) {
      throw new Error("Invalid splat index");
    }
    const splat = decodeSplat(this.splatArrays, index);
    return includeSh
      ? { ...splat, sh: decodeSplatSh(this.extra, index, this.getNumSh()) }
      : splat;
  }
  /** @internal Consecutive visible records surviving spatial block picking. */
  forEachRaycastRange(query, callback) {
    query.forEachRange(this.spatialBounds, this.numSplats, callback);
  }
  copySplatRecords(firstTarget, secondTarget, sourceStart, count) {
    const wordStart = sourceStart * 4;
    const wordEnd = wordStart + count * 4;
    firstTarget.set(this.splatArrays[0].subarray(wordStart, wordEnd));
    secondTarget.set(this.splatArrays[1].subarray(wordStart, wordEnd));
  }
  copySortCenters(target, targetStart, count) {
    if (count > this.numSplats || targetStart + count * 3 > target.length) {
      throw new Error("Invalid sort center copy range");
    }
    target.set(this.getSortCenters().subarray(0, count * 3), targetStart);
  }
  getSortCenters() {
    if (this.sortCenters) return this.sortCenters;
    const centers = new Float32Array(this.numSplats * 3);
    const [splatA, splatB] = this.splatArrays;
    const centerView = new Float32Array(
      splatA.buffer,
      splatA.byteOffset,
      splatA.length,
    );
    for (let index = 0; index < this.numSplats; index += 1) {
      const i3 = index * 3;
      const i4 = index * 4;
      const disabled =
        splatB[i4 + 1] >>> 16 === 0xfc00 && splatB[i4 + 2] === 0xfc00fc00;
      centers[i3] = disabled ? Number.NaN : centerView[i4];
      centers[i3 + 1] = disabled ? Number.NaN : centerView[i4 + 1];
      centers[i3 + 2] = disabled ? Number.NaN : centerView[i4 + 2];
    }
    this.sortCenters = centers;
    return centers;
  }
  forEachCenter(callback) {
    const centers = this.getSortCenters();
    for (let index = 0; index < this.numSplats; index += 1) {
      const i3 = index * 3;
      callback(index, centers[i3], centers[i3 + 1], centers[i3 + 2]);
    }
  }
  forEachSplat(callback) {
    let splat;
    for (let index = 0; index < this.numSplats; index += 1) {
      splat = decodeSplat(this.splatArrays, index, splat);
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
  setTextureUniforms(uniforms) {
    const [splats, splats2] = this.getSplatTextures();
    const sh = this.getShTextures();
    const height = splats.image.height;
    const layerBits = SPLAT_TEX_WIDTH_BITS + Math.ceil(Math.log2(height));
    uniforms.sourceLayerBits.value = layerBits;
    uniforms.sourceLayerMask.value = 2 ** layerBits - 1;
    uniforms.sourceBlockBits.value = SPLAT_BLOCKS_DISABLED;
    uniforms.sourceBlocks.value = Splats.emptyTexture;
    uniforms.sourceOpacities.value = Splats.emptyTexture;
    uniforms.sourceIndexed.value = false;
    uniforms.sourceIndices.value = Splats.emptyTexture;
    uniforms.sourceSplats.value = splats;
    uniforms.sourceSplats2.value = splats2;
    uniforms.sh1Texture.value = sh.sh1 ?? Splats.emptyTexture;
    uniforms.sh2Texture.value = sh.sh2 ?? Splats.emptyTexture;
    uniforms.sh3TextureA.value = sh.sh3a ?? Splats.emptyTexture;
    uniforms.sh3TextureB.value = sh.sh3b ?? Splats.emptyTexture;
    this.needsUpdate = false;
  }
  getSplatTextures() {
    if (this.maxSplats === 0 || this.splatArrays[0].length === 0) {
      return [Splats.emptyTexture, Splats.emptyTexture];
    }
    if (this.textures[0] === Splats.emptyTexture) {
      const { width, height, depth } = getTextureSize(this.maxSplats);
      this.textures = [
        newUintArrayTexture(this.splatArrays[0], width, height, depth),
        newUintArrayTexture(this.splatArrays[1], width, height, depth),
      ];
    } else if (this.needsUpdate) {
      this.textures[0].needsUpdate = true;
      this.textures[1].needsUpdate = true;
    }
    return this.textures;
  }
  disposeMainTextures() {
    for (const texture of this.textures) {
      if (texture !== Splats.emptyTexture) {
        texture.dispose();
      }
    }
    this.textures = [Splats.emptyTexture, Splats.emptyTexture];
  }
  getShTextures() {
    for (const key of SH_KEYS) {
      this.shTextures[key] = this.ensureShTexture(key, this.shTextures[key]);
    }
    return this.shTextures;
  }
  ensureShTexture(key, current) {
    if (current) {
      if (this.needsUpdate) current.needsUpdate = true;
      return current;
    }
    const data = this.extra[key];
    if (!data) return undefined;
    const { width, height, depth, maxSplats } = getTextureSize(
      Math.max(1, data.length / 4),
    );
    let padded = data;
    if (data.length < maxSplats * 4) {
      padded = new Uint32Array(maxSplats * 4);
      padded.set(data);
      this.extra[key] = padded;
    }
    return newUintArrayTexture(padded, width, height, depth);
  }
  static {
    Splats.emptyTexture = newUintArrayTexture(new Uint32Array(4), 1, 1, 1);
  }
}
function newUintArrayTexture(data, width, height, depth) {
  const texture = new THREE.DataArrayTexture(data, width, height, depth);
  texture.format = THREE.RGBAIntegerFormat;
  texture.type = THREE.UnsignedIntType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
function decodeSplatSh(extra, index, degree) {
  const count = SH_COUNTS[degree];
  const result = new Array(count);
  const rgb = [0, 0, 0];
  const base = index * 4;
  for (let coefficient = 0; coefficient < count; coefficient += 1) {
    const data = extra[SH_KEYS[coefficient >> 2]];
    const word = data?.[base + (coefficient & 3)] ?? 0;
    decodeShRgbToArray(word, rgb);
    result[coefficient] = new THREE.Color(rgb[0], rgb[1], rgb[2]);
  }
  return result;
}
