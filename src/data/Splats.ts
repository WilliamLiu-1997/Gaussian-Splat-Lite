import * as THREE from "three";

import type { SplatPostDecodeProgram } from "../loaders/postDecode";
import { toHalf } from "../utils/numeric";
import type { SplatFileType } from "./defines";
import { encodeQuatOctXy1010R12, encodeSplatOpacity } from "./splatCodec";
import { getTextureSize } from "./textureLayout";
import { decodeSplat } from "./unpack";

type SplatShTextures = {
  sh1?: THREE.DataArrayTexture;
  sh2?: THREE.DataArrayTexture;
  sh3a?: THREE.DataArrayTexture;
  sh3b?: THREE.DataArrayTexture;
};

type SplatShArrays = (Uint32Array | undefined)[];

const SH_COUNTS = [0, 3, 8, 15] as const;
const SH_KEYS = ["sh1", "sh2", "sh3a", "sh3b"] as const;
const SH_ARRAY_COUNTS = [0, 1, 2, 4] as const;

type DecodedSplat = ReturnType<typeof decodeSplat>;
export type SplatInput = {
  center: THREE.Vector3;
  scales: THREE.Vector3;
  quaternion: THREE.Quaternion;
  opacity: number;
  color: THREE.Color;
  /** SH0/1/2/3 use 0, 3, 8, or 15 RGB coefficients respectively. */
  sh?: readonly THREE.Color[];
};

type DecodedSplatWithSh = DecodedSplat & { sh: THREE.Color[] };

export type SplatsOptions = {
  url?: string;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  stream?: ReadableStream;
  /** Optional stream byte-length estimate used for progress reporting. */
  streamLength?: number;
  /** Declarative per-splat transform executed in the decode worker. */
  postDecode?: SplatPostDecodeProgram;
  maxSplats?: number;
  construct?: (splats: Splats) => Promise<void> | void;
  onProgress?: (event: ProgressEvent) => void;
};

type SplatsInitializationOptions = SplatsOptions & {
  splatArrays?: [Uint32Array, Uint32Array];
  sortCenters?: Float32Array;
  numSplats?: number;
  extra?: Record<string, unknown>;
};

type SplatsState = {
  maxSplats: number;
  numSplats: number;
  splatArrays: [Uint32Array, Uint32Array];
  sortCenters: Float32Array;
  extra: Record<string, unknown>;
  sortCentersDirty: boolean;
};

function getInitializationInputs(
  options: SplatsInitializationOptions,
): string[] {
  const inputs: string[] = [];
  if (options.url !== undefined) inputs.push("url");
  if (options.fileBytes !== undefined) inputs.push("fileBytes");
  if (options.stream !== undefined) inputs.push("stream");
  if (options.splatArrays !== undefined) inputs.push("splatArrays");
  if (options.construct !== undefined) inputs.push("construct");
  return inputs;
}

function validateInitializationInputs(options: SplatsInitializationOptions) {
  const inputs = getInitializationInputs(options);
  if (inputs.length > 1) {
    throw new Error(
      `Splats initialization inputs are mutually exclusive; provide only one of url, fileBytes, stream, splatArrays, or construct (received: ${inputs.join(", ")})`,
    );
  }
}

function hasFileInput(options: SplatsOptions) {
  return (
    options.url !== undefined ||
    options.fileBytes !== undefined ||
    options.stream !== undefined
  );
}

function createSplatsState(options: SplatsInitializationOptions): SplatsState {
  if (options.splatArrays !== undefined) {
    const [first, second] = options.splatArrays;
    if (first.length !== second.length) {
      throw new Error("splatArrays must have the same length");
    }
    if (first.length % 4 !== 0) {
      throw new Error("splatArrays must contain complete four-word records");
    }

    const inputCapacity = first.length / 4;
    const numSplats = options.numSplats ?? inputCapacity;
    if (
      !Number.isSafeInteger(numSplats) ||
      numSplats < 0 ||
      numSplats > inputCapacity
    ) {
      throw new Error("numSplats must be an integer within splatArrays");
    }
    if (
      options.sortCenters !== undefined &&
      options.sortCenters.length < numSplats * 3
    ) {
      throw new Error("sortCenters is smaller than numSplats");
    }

    const maxSplats =
      inputCapacity === 0 ? 0 : getTextureSize(inputCapacity).maxSplats;
    let splatArrays = options.splatArrays;
    if (maxSplats !== inputCapacity) {
      splatArrays = [
        new Uint32Array(maxSplats * 4),
        new Uint32Array(maxSplats * 4),
      ];
      splatArrays[0].set(first);
      splatArrays[1].set(second);
    }
    return {
      maxSplats,
      numSplats,
      splatArrays,
      sortCenters: options.sortCenters ?? new Float32Array(0),
      extra: options.extra ?? {},
      sortCentersDirty: options.sortCenters === undefined,
    };
  }

  return {
    maxSplats: options.maxSplats ?? 0,
    numSplats: 0,
    splatArrays: [new Uint32Array(0), new Uint32Array(0)],
    sortCenters: new Float32Array(0),
    extra: options.extra ?? {},
    sortCentersDirty: false,
  };
}

/** A mutable splat source with two 16-byte texture records per splat. */
export class Splats {
  maxSplats = 0;
  numSplats = 0;
  private splatArrays: [Uint32Array, Uint32Array] = [
    new Uint32Array(0),
    new Uint32Array(0),
  ];
  private sortCenters: Float32Array = new Float32Array(0);
  private extra: Record<string, unknown> = {};

  initialized: Promise<Splats>;
  isInitialized = false;

  private textures: [THREE.DataArrayTexture, THREE.DataArrayTexture];
  private shTextures: SplatShTextures = {};
  private updateNeeded = true;
  private sortCentersDirty = false;
  private initializationVersion = 0;

  constructor(options: SplatsOptions = {}) {
    this.textures = [Splats.emptyTexture, Splats.emptyTexture];
    this.initialized = Promise.resolve(this);
    this.initialize(options);
  }

  initialize(options: SplatsOptions = {}): Promise<Splats> {
    const initializationOptions = options as SplatsInitializationOptions;
    validateInitializationInputs(initializationOptions);
    const isAsync = hasFileInput(options) || options.construct !== undefined;
    const state = createSplatsState(
      isAsync ? { maxSplats: options.maxSplats } : initializationOptions,
    );
    const version = ++this.initializationVersion;

    this.isInitialized = false;
    this.commitState(state);

    if (isAsync) {
      // Defer construction so initialize() can publish the new promise before a
      // user callback has an opportunity to re-enter initialize().
      this.initialized = Promise.resolve()
        .then(() =>
          version === this.initializationVersion
            ? this.asyncInitialize(options)
            : undefined,
        )
        .then((initialized) => {
          if (!initialized) return this;
          try {
            if (version === this.initializationVersion) {
              this.commitState(initialized.captureState());
              this.isInitialized = true;
            }
          } finally {
            initialized.dispose();
          }
          return this;
        });
    } else {
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
    }

    return this.initialized;
  }

  private commitState(state: SplatsState) {
    this.disposeTextures();
    this.maxSplats = state.maxSplats;
    this.numSplats = state.numSplats;
    this.splatArrays = state.splatArrays;
    this.sortCenters = state.sortCenters;
    this.extra = state.extra;
    this.sortCentersDirty = state.sortCentersDirty;
    this.updateNeeded = true;
  }

  private captureState(): SplatsState {
    return {
      maxSplats: this.maxSplats,
      numSplats: this.numSplats,
      splatArrays: this.splatArrays,
      sortCenters: this.sortCenters,
      extra: this.extra,
      sortCentersDirty: this.sortCentersDirty,
    };
  }

  private async asyncInitialize(options: SplatsOptions): Promise<Splats> {
    if (hasFileInput(options)) {
      const { SplatLoader } = await import("../loaders/SplatLoader");
      return new SplatLoader().loadInternalAsync({
        url: options.url,
        fileBytes: options.fileBytes,
        fileType: options.fileType,
        fileName: options.fileName,
        stream: options.stream,
        streamLength: options.streamLength,
        postDecode: options.postDecode,
        onProgress: options.onProgress,
      });
    }

    const initialized = new Splats({ maxSplats: options.maxSplats });
    try {
      await options.construct?.(initialized);
      return initialized;
    } catch (error) {
      initialized.dispose();
      throw error;
    }
  }

  dispose() {
    this.initializationVersion += 1;
    this.isInitialized = false;
    this.commitState(createSplatsState({}));
  }

  private disposeTextures() {
    for (const texture of this.textures ?? []) {
      if (texture !== Splats.emptyTexture) {
        texture.dispose();
      }
    }
    this.textures = [Splats.emptyTexture, Splats.emptyTexture];
    for (const texture of Object.values(this.shTextures ?? {})) {
      texture?.dispose();
    }
    this.shTextures = {};
  }

  getNumSplats() {
    return this.numSplats;
  }

  getNumSh() {
    return !this.extra.sh1
      ? 0
      : !this.extra.sh2
        ? 1
        : !this.extra.sh3a || !this.extra.sh3b
          ? 2
          : 3;
  }

  /** Current retained bytes for encoded Splat, sort-center, and SH arrays. */
  getByteLength() {
    let byteLength =
      this.splatArrays[0].byteLength +
      this.splatArrays[1].byteLength +
      this.sortCenters.byteLength;

    for (const value of Object.values(this.extra)) {
      if (ArrayBuffer.isView(value)) {
        byteLength += value.byteLength;
      }
    }

    return byteLength;
  }

  get needsUpdate() {
    return this.updateNeeded;
  }

  set needsUpdate(value: boolean) {
    this.updateNeeded = value;
    if (value) this.sortCentersDirty = true;
  }

  private ensureSortCenterCapacity(capacity: number) {
    const requiredValues = capacity * 3;
    if (this.sortCenters.length >= requiredValues) return;

    const sortCenters = new Float32Array(requiredValues);
    sortCenters.set(this.sortCenters);
    this.sortCenters = sortCenters;
  }

  private ensureShCapacity(degree: number, capacity: number) {
    const numArrays = SH_ARRAY_COUNTS[degree] ?? 0;
    const requiredValues = capacity * 4;
    for (let index = 0; index < numArrays; index += 1) {
      const key = SH_KEYS[index];
      const current = this.extra[key];
      if (current instanceof Uint32Array && current.length >= requiredValues) {
        continue;
      }
      const data = new Uint32Array(requiredValues);
      if (current instanceof Uint32Array) data.set(current);
      this.extra[key] = data;
    }
  }

  private ensureSplats(numSplats: number): [Uint32Array, Uint32Array] {
    const currentCapacity = this.splatArrays[0].length / 4;
    const targetSize =
      numSplats <= this.maxSplats
        ? this.maxSplats
        : Math.max(numSplats, 2 * this.maxSplats);
    if (targetSize > currentCapacity) {
      this.maxSplats = getTextureSize(Math.max(1, targetSize)).maxSplats;
      const first = new Uint32Array(this.maxSplats * 4);
      const second = new Uint32Array(this.maxSplats * 4);
      first.set(this.splatArrays[0]);
      second.set(this.splatArrays[1]);
      this.splatArrays = [first, second];
      this.updateNeeded = true;
    }
    const capacity = this.splatArrays[0].length / 4;
    this.ensureSortCenterCapacity(capacity);
    this.ensureShCapacity(this.getNumSh(), capacity);
    return this.splatArrays;
  }

  private prepareSplatEncoding(numSplats: number, shDegree: number) {
    const arrays = this.ensureSplats(numSplats);
    this.ensureShCapacity(shDegree, arrays[0].length / 4);
    return {
      arrays,
      splatCenters: new Float32Array(
        arrays[0].buffer,
        arrays[0].byteOffset,
        arrays[0].length,
      ),
      sortCenters: this.getSortCenters(),
      shArrays: shDegree === 0 ? undefined : getSplatShArrays(this.extra),
    };
  }

  getSplat(index: number): DecodedSplatWithSh;
  getSplat(index: number, includeSh: true): DecodedSplatWithSh;
  getSplat(index: number, includeSh: false): DecodedSplat;
  getSplat(index: number, includeSh: boolean): DecodedSplat;
  getSplat(index: number, includeSh = true) {
    if (index < 0 || index >= this.numSplats) {
      throw new Error("Invalid splat index");
    }
    const splat = decodeSplat(this.splatArrays, index);
    return includeSh
      ? { ...splat, sh: decodeSplatSh(this.extra, index, this.getNumSh()) }
      : splat;
  }

  copySplatRecords(
    firstTarget: Uint32Array,
    secondTarget: Uint32Array,
    sourceStart: number,
    count: number,
  ) {
    const wordStart = sourceStart * 4;
    const wordEnd = wordStart + count * 4;
    firstTarget.set(this.splatArrays[0].subarray(wordStart, wordEnd));
    secondTarget.set(this.splatArrays[1].subarray(wordStart, wordEnd));
  }

  setSplats(indices: readonly number[], splats: readonly SplatInput[]) {
    if (indices.length !== splats.length) {
      throw new Error("Splat indices and data must have the same length");
    }
    const count = splats.length;
    if (count === 0) return;

    let shDegree = this.getNumSh();
    let maxIndex = -1;
    for (let offset = 0; offset < count; offset += 1) {
      const index = indices[offset];
      validateSplatIndex(index);
      if (index > maxIndex) maxIndex = index;
      const sh = splats[offset].sh;
      if (sh === undefined) continue;
      const degree = getShDegree(sh);
      if (degree > shDegree) shDegree = degree;
    }

    const { arrays, splatCenters, sortCenters, shArrays } =
      this.prepareSplatEncoding(maxIndex + 1, shDegree);
    for (let offset = 0; offset < count; offset += 1) {
      encodeSplat(
        arrays,
        splatCenters,
        shArrays,
        sortCenters,
        indices[offset],
        splats[offset],
      );
    }
    if (maxIndex >= this.numSplats) this.numSplats = maxIndex + 1;
    this.updateNeeded = true;
  }

  pushSplats(splats: readonly SplatInput[]) {
    const count = splats.length;
    if (count === 0) return;

    const startIndex = this.numSplats;
    const endIndex = startIndex + count;
    validateSplatIndex(endIndex - 1);

    let shDegree = this.getNumSh();
    for (let offset = 0; offset < count; offset += 1) {
      const sh = splats[offset].sh;
      if (sh === undefined) continue;
      const degree = getShDegree(sh);
      if (degree > shDegree) shDegree = degree;
    }

    const { arrays, splatCenters, sortCenters, shArrays } =
      this.prepareSplatEncoding(endIndex, shDegree);
    for (let offset = 0; offset < count; offset += 1) {
      encodeSplat(
        arrays,
        splatCenters,
        shArrays,
        sortCenters,
        startIndex + offset,
        splats[offset],
      );
    }
    this.numSplats = endIndex;
    this.updateNeeded = true;
  }

  removeSplats(indices: readonly number[]) {
    if (indices.length === 0) return;

    let sortedUnique = true;
    let previousIndex = -1;
    for (const index of indices) {
      validateSplatIndex(index);
      if (index >= this.numSplats) throw new Error("Invalid splat index");
      if (index <= previousIndex) sortedUnique = false;
      previousIndex = index;
    }
    const removedIndices = sortedUnique
      ? indices
      : [...new Set(indices)].sort((left, right) => left - right);

    const recordCount = this.numSplats;
    this.ensureShCapacity(this.getNumSh(), this.splatArrays[0].length / 4);
    const sortCenters = this.getSortCenters();
    const recordArrays = [...this.splatArrays];
    for (const key of SH_KEYS) {
      const sh = this.extra[key];
      if (sh instanceof Uint32Array) recordArrays.push(sh);
    }

    let targetIndex = removedIndices[0];
    let sourceIndex = targetIndex + 1;
    for (let offset = 1; offset < removedIndices.length; offset += 1) {
      const nextRemoved = removedIndices[offset];
      const count = nextRemoved - sourceIndex;
      if (count > 0) {
        copySplatRange(
          recordArrays,
          sortCenters,
          targetIndex,
          sourceIndex,
          count,
        );
        targetIndex += count;
      }
      sourceIndex = nextRemoved + 1;
    }
    const tailCount = recordCount - sourceIndex;
    if (tailCount > 0) {
      copySplatRange(
        recordArrays,
        sortCenters,
        targetIndex,
        sourceIndex,
        tailCount,
      );
      targetIndex += tailCount;
    }
    for (const data of recordArrays) {
      data.fill(0, targetIndex * 4, recordCount * 4);
    }
    sortCenters.fill(0, targetIndex * 3, recordCount * 3);

    this.numSplats = targetIndex;
    this.updateNeeded = true;
  }

  private getSortCenters() {
    if (this.sortCentersDirty) this.rebuildSortCenters();
    return this.sortCenters;
  }

  copySortCenters(target: Float32Array, targetStart: number, count: number) {
    if (count > this.numSplats || targetStart + count * 3 > target.length) {
      throw new Error("Invalid sort center copy range");
    }
    target.set(this.getSortCenters().subarray(0, count * 3), targetStart);
  }

  private rebuildSortCenters() {
    const capacity = this.splatArrays[0].length / 4;
    this.ensureSortCenterCapacity(capacity);
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
        splatB[i4 + 1] >>> 16 === 0xfc00 &&
        (splatB[i4 + 2] & 0xffff) === 0xfc00 &&
        splatB[i4 + 2] >>> 16 === 0xfc00;
      this.sortCenters[i3] = disabled ? Number.NaN : centerView[i4];
      this.sortCenters[i3 + 1] = disabled ? Number.NaN : centerView[i4 + 1];
      this.sortCenters[i3 + 2] = disabled ? Number.NaN : centerView[i4 + 2];
    }
    this.sortCentersDirty = false;
  }

  forEachCenter(
    callback: (index: number, x: number, y: number, z: number) => void,
  ) {
    const centers = this.getSortCenters();
    for (let index = 0; index < this.numSplats; index += 1) {
      const i3 = index * 3;
      callback(index, centers[i3], centers[i3 + 1], centers[i3 + 2]);
    }
  }

  forEachSplat(
    callback: (
      index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color,
    ) => void,
  ) {
    for (let index = 0; index < this.numSplats; index += 1) {
      const splat = decodeSplat(this.splatArrays, index);
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

  setTextureUniforms(uniforms: Record<string, THREE.IUniform>) {
    const [splats, splats2] = this.getSplatTextures();
    const sh = this.getShTextures();
    uniforms.sourceSplats.value = splats;
    uniforms.sourceSplats2.value = splats2;
    uniforms.sh1Texture.value = sh.sh1 ?? Splats.emptyTexture;
    uniforms.sh2Texture.value = sh.sh2 ?? Splats.emptyTexture;
    uniforms.sh3TextureA.value = sh.sh3a ?? Splats.emptyTexture;
    uniforms.sh3TextureB.value = sh.sh3b ?? Splats.emptyTexture;
    this.updateNeeded = false;
  }

  private getSplatTextures() {
    if (this.maxSplats === 0 || this.splatArrays[0].length === 0) {
      return [Splats.emptyTexture, Splats.emptyTexture] as const;
    }

    const { width, height, depth } = getTextureSize(this.maxSplats);
    const textureData = this.textures[0].image.data;
    const incompatible =
      this.textures[0] === Splats.emptyTexture ||
      this.textures[0].image.width !== width ||
      this.textures[0].image.height !== height ||
      this.textures[0].image.depth !== depth ||
      textureData === null ||
      textureData.buffer !== this.splatArrays[0].buffer;
    if (incompatible) {
      this.disposeMainTextures();
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

  private disposeMainTextures() {
    for (const texture of this.textures) {
      if (texture !== Splats.emptyTexture) {
        texture.dispose();
      }
    }
    this.textures = [Splats.emptyTexture, Splats.emptyTexture];
  }

  private getShTextures(): SplatShTextures {
    this.shTextures.sh1 = this.ensureShTexture("sh1", this.shTextures.sh1);
    this.shTextures.sh2 = this.ensureShTexture("sh2", this.shTextures.sh2);
    this.shTextures.sh3a = this.ensureShTexture("sh3a", this.shTextures.sh3a);
    this.shTextures.sh3b = this.ensureShTexture("sh3b", this.shTextures.sh3b);
    return this.shTextures;
  }

  private ensureShTexture(
    key: "sh1" | "sh2" | "sh3a" | "sh3b",
    current?: THREE.DataArrayTexture,
  ) {
    let texture = current;
    const data = this.extra[key] as Uint32Array | undefined;
    if (!data) {
      texture?.dispose();
      return undefined;
    }
    const { width, height, depth, maxSplats } = getTextureSize(
      Math.max(1, data.length / 4),
    );
    let padded = data;
    if (data.length < maxSplats * 4) {
      padded = new Uint32Array(maxSplats * 4);
      padded.set(data);
      this.extra[key] = padded;
    }
    const incompatible =
      texture &&
      (texture.image.width !== width ||
        texture.image.height !== height ||
        texture.image.depth !== depth ||
        texture.image.data === null ||
        texture.image.data.buffer !== padded.buffer);
    if (incompatible) {
      texture?.dispose();
      texture = undefined;
    }
    if (!texture) {
      texture = newUintArrayTexture(padded, width, height, depth);
    } else if (this.needsUpdate) {
      texture.needsUpdate = true;
    }
    return texture;
  }

  static emptyTexture = newUintArrayTexture(new Uint32Array(4), 1, 1, 1);
}

function newUintArrayTexture(
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
  texture.needsUpdate = true;
  return texture;
}

function decodeSplatSh(
  extra: Record<string, unknown>,
  index: number,
  degree: number,
) {
  const count = SH_COUNTS[degree] ?? 0;
  const result = new Array<THREE.Color>(count);
  const base = index * 4;
  for (let coefficient = 0; coefficient < count; coefficient += 1) {
    const data = extra[SH_KEYS[coefficient >> 2]];
    const word =
      data instanceof Uint32Array ? data[base + (coefficient & 3)] : 0;
    result[coefficient] = decodeShColor(word);
  }
  return result;
}

function validateSplatIndex(index: number) {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Invalid splat index");
  }
}

function copySplatRange(
  recordArrays: Uint32Array[],
  sortCenters: Float32Array,
  targetIndex: number,
  sourceIndex: number,
  count: number,
) {
  const target4 = targetIndex * 4;
  const source4 = sourceIndex * 4;
  const count4 = count * 4;
  for (const data of recordArrays) {
    data.copyWithin(target4, source4, source4 + count4);
  }
  const target3 = targetIndex * 3;
  const source3 = sourceIndex * 3;
  sortCenters.copyWithin(target3, source3, source3 + count * 3);
}

function encodeSplat(
  splatArrays: [Uint32Array, Uint32Array],
  splatCenters: Float32Array,
  shArrays: SplatShArrays | undefined,
  sortCenters: Float32Array,
  index: number,
  splat: SplatInput,
) {
  const i4 = index * 4;
  const [splatA, splatB] = splatArrays;
  const { center, scales, quaternion, opacity, color } = splat;
  splatCenters[i4] = center.x;
  splatCenters[i4 + 1] = center.y;
  splatCenters[i4 + 2] = center.z;
  splatA[i4 + 3] = encodeSplatOpacity(opacity);
  splatB[i4] = toHalf(color.r) | (toHalf(color.g) << 16);
  splatB[i4 + 1] = toHalf(color.b) | (toHalf(Math.log(scales.x)) << 16);
  splatB[i4 + 2] =
    toHalf(Math.log(scales.y)) | (toHalf(Math.log(scales.z)) << 16);
  splatB[i4 + 3] = encodeQuatOctXy1010R12(
    quaternion.x,
    quaternion.y,
    quaternion.z,
    quaternion.w,
  );
  if (shArrays) encodeSplatSh(shArrays, index, splat.sh);

  const i3 = index * 3;
  const disabled = scales.x === 0 && scales.y === 0 && scales.z === 0;
  sortCenters[i3] = disabled ? Number.NaN : center.x;
  sortCenters[i3 + 1] = disabled ? Number.NaN : center.y;
  sortCenters[i3 + 2] = disabled ? Number.NaN : center.z;
}

function getShDegree(sh?: readonly THREE.Color[]) {
  const count = sh?.length ?? 0;
  switch (count) {
    case 0:
      return 0;
    case 3:
      return 1;
    case 8:
      return 2;
    case 15:
      return 3;
    default:
      throw new Error("SH must contain 0, 3, 8, or 15 coefficients");
  }
}

function getSplatShArrays(extra: Record<string, unknown>): SplatShArrays {
  const sh1 = extra.sh1;
  const sh2 = extra.sh2;
  const sh3a = extra.sh3a;
  const sh3b = extra.sh3b;
  return [
    sh1 instanceof Uint32Array ? sh1 : undefined,
    sh2 instanceof Uint32Array ? sh2 : undefined,
    sh3a instanceof Uint32Array ? sh3a : undefined,
    sh3b instanceof Uint32Array ? sh3b : undefined,
  ];
}

function encodeSplatSh(
  shArrays: SplatShArrays,
  index: number,
  sh?: readonly THREE.Color[],
) {
  const base = index * 4;
  for (let arrayIndex = 0; arrayIndex < shArrays.length; arrayIndex += 1) {
    const data = shArrays[arrayIndex];
    if (!data) continue;
    data[base] = 0;
    data[base + 1] = 0;
    data[base + 2] = 0;
    data[base + 3] = 0;
  }
  if (!sh) return;

  for (let coefficient = 0; coefficient < sh.length; coefficient += 1) {
    const data = shArrays[coefficient >> 2];
    if (!data) continue;
    data[base + (coefficient & 3)] = encodeShColor(sh[coefficient]);
  }
}

function encodeShColor(color: THREE.Color) {
  const maxAbs = Math.max(
    Math.abs(color.r),
    Math.abs(color.g),
    Math.abs(color.b),
  );
  const exponent = Math.round(
    Math.min(31, Math.max(0, Math.floor(Math.log2(maxAbs)) + 15)),
  );
  const divisor = 2 ** (exponent - 15) / 255;
  const encodedR = Math.round(
    Math.min(255, Math.max(0, Math.abs(color.r) / divisor)),
  );
  const encodedG = Math.round(
    Math.min(255, Math.max(0, Math.abs(color.g) / divisor)),
  );
  const encodedB = Math.round(
    Math.min(255, Math.max(0, Math.abs(color.b) / divisor)),
  );
  const signs =
    (color.r < 0 ? 1 : 0) | (color.g < 0 ? 2 : 0) | (color.b < 0 ? 4 : 0);
  return (
    encodedR |
    (encodedG << 8) |
    (encodedB << 16) |
    (((exponent << 3) | signs) << 24)
  );
}

function decodeShColor(word: number) {
  const exponentAndSigns = word >>> 24;
  const multiplier = 2 ** ((exponentAndSigns >>> 3) - 15) / 255;
  let r = (word & 0xff) * multiplier;
  let g = ((word >>> 8) & 0xff) * multiplier;
  let b = ((word >>> 16) & 0xff) * multiplier;
  if (exponentAndSigns & 1) r = -r;
  if (exponentAndSigns & 2) g = -g;
  if (exponentAndSigns & 4) b = -b;
  return new THREE.Color(r, g, b);
}
