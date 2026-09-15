import * as THREE from "three";

import type { SplatFileResolver } from "../loaders/loadTypes";
import type { SplatPostDecodeProgram } from "../loaders/postDecode/program";
import {
  type ReorderedSplatResult,
  SPLAT_BLOCKS_DISABLED,
  SPLAT_BOUNDS_BLOCK_SIZE,
  SPLAT_TEX_HEIGHT_BITS,
  SPLAT_TEX_WIDTH_BITS,
  type SplatExtra,
  type SplatFileType,
  type SplatResult,
} from "./defines";
import type { RaycastRangeCallback, SplatRaycastQuery } from "./raycast";
import { decodeShRgbToArray } from "./splatCodec";
import {
  SH_KEYS,
  getSplatByteLength,
  getSplatShDegree,
  resetSplatBounds,
} from "./splatData";
import { getTextureSize } from "./textureLayout";
import { decodeSplat } from "./unpack";

type SplatShTextures = {
  sh1?: THREE.DataArrayTexture;
  sh2?: THREE.DataArrayTexture;
  sh3a?: THREE.DataArrayTexture;
  sh3b?: THREE.DataArrayTexture;
};

const SH_COUNTS = [0, 3, 8, 15] as const;

type DecodedSplat = ReturnType<typeof decodeSplat>;
type DecodedSplatWithSh = DecodedSplat & { sh: THREE.Color[] };

export type SplatsOptions = {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  /** Resolve external SOG images or RAD chunks by metadata filename. */
  resolveFile?: SplatFileResolver;
  /** Declarative per-splat transform executed in the decode worker. */
  postDecode?: SplatPostDecodeProgram;
  onProgress?: (event: ProgressEvent) => void;
};

type SplatsState = ReorderedSplatResult & {
  maxSplats: number;
};

function validateInitializationInputs(options: SplatsOptions) {
  if ("splatArrays" in options)
    throw new Error(
      "splatArrays initialization is not supported; use url, file, or fileBytes",
    );
  const inputs: string[] = [];
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

function createDecodedState(data: ReorderedSplatResult): SplatsState {
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

function createEmptyState(): SplatsState {
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
  maxSplats = 0;
  numSplats = 0;
  private splatArrays: [Uint32Array, Uint32Array] = [
    new Uint32Array(0),
    new Uint32Array(0),
  ];
  private sortCenters?: Float32Array;
  protected sourceIds!: Uint32Array;
  protected centerOnlyBounds!: Float32Array;
  protected bounds!: Float32Array;
  private spatialBounds!: Float32Array;
  private extra: SplatExtra = {};

  initialized: Promise<Splats>;
  isInitialized = false;
  needsUpdate = true;

  private textures: [THREE.DataArrayTexture, THREE.DataArrayTexture];
  private shTextures: SplatShTextures = {};
  private loadController?: AbortController;

  constructor(options: SplatsOptions = {}) {
    this.textures = [Splats.emptyTexture, Splats.emptyTexture];
    this.initialized = Promise.resolve(this);
    this.initialize(options);
  }

  initialize(options: SplatsOptions = {}): Promise<Splats> {
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

  private commitState(state: SplatsState) {
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
  initializeDecoded(data: ReorderedSplatResult) {
    const state = createDecodedState(data);
    this.initialize();
    this.commitState(state);
  }

  private async asyncInitialize(
    options: SplatsOptions,
    signal: AbortSignal,
  ): Promise<SplatsState> {
    const { loadSplatData } = await import("../loaders/loadSplatData");
    const decoded = await loadSplatData({ ...options, signal });
    return createDecodedState(decoded);
  }

  dispose() {
    this.loadController?.abort();
    this.loadController = undefined;
    this.isInitialized = false;
    this.commitState(createEmptyState());
  }

  private disposeTextures() {
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
  getBoundingBox(centersOnly = true, target = new THREE.Box3()): THREE.Box3 {
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
  takeData(): SplatResult & { sourceIds: Uint32Array } {
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
    } satisfies SplatResult;
    this.dispose();
    return data;
  }

  /** Original source ID, retained across reordering and range extraction. */
  getSourceIndex(index: number) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.numSplats)
      throw new Error("Invalid splat index");
    return this.sourceIds[index];
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

  /** @internal Consecutive visible records surviving spatial block picking. */
  forEachRaycastRange(
    query: SplatRaycastQuery,
    callback: RaycastRangeCallback,
  ) {
    query.forEachRange(this.spatialBounds, this.numSplats, callback);
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

  copySortCenters(target: Float32Array, targetStart: number, count: number) {
    if (count > this.numSplats || targetStart + count * 3 > target.length) {
      throw new Error("Invalid sort center copy range");
    }
    target.set(this.getSortCenters().subarray(0, count * 3), targetStart);
  }

  private getSortCenters() {
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
    uniforms.sourceLayerBits.value =
      SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;
    uniforms.sourceLayerMask.value =
      (1 << (SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS)) - 1;
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

  private getSplatTextures() {
    if (this.maxSplats === 0 || this.splatArrays[0].length === 0) {
      return [Splats.emptyTexture, Splats.emptyTexture] as const;
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

  private disposeMainTextures() {
    for (const texture of this.textures) {
      if (texture !== Splats.emptyTexture) {
        texture.dispose();
      }
    }
    this.textures = [Splats.emptyTexture, Splats.emptyTexture];
  }

  private getShTextures(): SplatShTextures {
    for (const key of SH_KEYS) {
      this.shTextures[key] = this.ensureShTexture(key, this.shTextures[key]);
    }
    return this.shTextures;
  }

  private ensureShTexture(
    key: (typeof SH_KEYS)[number],
    current?: THREE.DataArrayTexture,
  ) {
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

function decodeSplatSh(extra: SplatExtra, index: number, degree: number) {
  const count = SH_COUNTS[degree];
  const result = new Array<THREE.Color>(count);
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
