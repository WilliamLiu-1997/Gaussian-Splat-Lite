import * as THREE from "three";

import { SPLAT_TEX_WIDTH, type SplatFileType } from "./defines";
import type { SplatPostDecodeProgram } from "./postDecode";
import { decodeSplat, encodeSplat, getTextureSize } from "./utils";

type SplatShTextures = {
  sh1?: THREE.DataArrayTexture;
  sh2?: THREE.DataArrayTexture;
  sh3a?: THREE.DataArrayTexture;
  sh3b?: THREE.DataArrayTexture;
};

const SH_COUNTS = [0, 3, 8, 15] as const;
const SH_KEYS = ["sh1", "sh2", "sh3a", "sh3b"] as const;

type DecodedSplat = ReturnType<typeof decodeSplat>;
type DecodedSplatWithSh = DecodedSplat & { sh: THREE.Color[] };

export type SplatsOptions = {
  url?: string;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  stream?: ReadableStream;
  /** Exact number of bytes yielded by stream; also used for allocation validation. */
  streamLength?: number;
  /** Declarative per-splat transform executed in the decode worker. */
  postDecode?: SplatPostDecodeProgram;
  maxSplats?: number;
  splatArrays?: [Uint32Array, Uint32Array];
  sortCenters?: Float32Array;
  numSplats?: number;
  construct?: (splats: Splats) => Promise<void> | void;
  onProgress?: (event: ProgressEvent) => void;
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

function getInitializationInputs(options: SplatsOptions): string[] {
  const inputs: string[] = [];
  if (options.url !== undefined) inputs.push("url");
  if (options.fileBytes !== undefined) inputs.push("fileBytes");
  if (options.stream !== undefined) inputs.push("stream");
  if (options.splatArrays !== undefined) inputs.push("splatArrays");
  if (options.construct !== undefined) inputs.push("construct");
  return inputs;
}

function validateInitializationInputs(options: SplatsOptions) {
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

function createSplatsState(options: SplatsOptions): SplatsState {
  if (options.splatArrays !== undefined) {
    const capacity = Math.floor(
      Math.min(options.splatArrays[0].length, options.splatArrays[1].length) /
        4,
    );
    const maxSplats = Math.floor(capacity / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    const numSplats = Math.min(maxSplats, options.numSplats ?? maxSplats);
    if (
      options.sortCenters !== undefined &&
      options.sortCenters.length < numSplats * 3
    ) {
      throw new Error("sortCenters is smaller than numSplats");
    }
    return {
      maxSplats,
      numSplats,
      splatArrays: options.splatArrays,
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
  splatArrays: [Uint32Array, Uint32Array] = [
    new Uint32Array(0),
    new Uint32Array(0),
  ];
  sortCenters: Float32Array = new Float32Array(0);
  extra: Record<string, unknown> = {};

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
    validateInitializationInputs(options);
    const isAsync = hasFileInput(options) || options.construct !== undefined;
    const state = createSplatsState(
      isAsync ? { maxSplats: options.maxSplats } : options,
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
      const { SplatLoader } = await import("./SplatLoader");
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

  ensureSplats(numSplats: number): [Uint32Array, Uint32Array] {
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
    this.ensureSortCenterCapacity(this.splatArrays[0].length / 4);
    return this.splatArrays;
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

  setSplat(
    index: number,
    center: THREE.Vector3,
    scales: THREE.Vector3,
    quaternion: THREE.Quaternion,
    opacity: number,
    color: THREE.Color,
  ) {
    const arrays = this.ensureSplats(index + 1);
    const sortCenters = this.getSortCenters();
    encodeSplat(
      arrays,
      index,
      center.x,
      center.y,
      center.z,
      scales.x,
      scales.y,
      scales.z,
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
      opacity,
      color.r,
      color.g,
      color.b,
    );
    const i3 = index * 3;
    const disabled = scales.x === 0 && scales.y === 0 && scales.z === 0;
    sortCenters[i3] = disabled ? Number.NaN : center.x;
    sortCenters[i3 + 1] = disabled ? Number.NaN : center.y;
    sortCenters[i3 + 2] = disabled ? Number.NaN : center.z;
    this.numSplats = Math.max(this.numSplats, index + 1);
    this.updateNeeded = true;
  }

  pushSplat(
    center: THREE.Vector3,
    scales: THREE.Vector3,
    quaternion: THREE.Quaternion,
    opacity: number,
    color: THREE.Color,
  ) {
    this.setSplat(this.numSplats, center, scales, quaternion, opacity, color);
  }

  removeSplat(index: number) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.numSplats) {
      throw new Error("Invalid splat index");
    }

    const recordCount = this.numSplats;
    const sortCenters = this.getSortCenters();
    const target = index * 4;
    const end = recordCount * 4;
    const removeRecord = (data: Uint32Array) => {
      data.copyWithin(target, target + 4, end);
      data.fill(0, end - 4, end);
    };
    for (const data of this.splatArrays) {
      removeRecord(data);
    }
    for (const key of ["sh1", "sh2", "sh3a", "sh3b"] as const) {
      const data = this.extra[key];
      if (data instanceof Uint32Array) {
        removeRecord(data);
      }
    }
    const centerTarget = index * 3;
    const centerEnd = recordCount * 3;
    sortCenters.copyWithin(centerTarget, centerTarget + 3, centerEnd);
    sortCenters.fill(0, centerEnd - 3, centerEnd);

    this.numSplats -= 1;
    this.updateNeeded = true;
  }

  getSortCenters() {
    if (this.sortCentersDirty) this.rebuildSortCenters();
    return this.sortCenters;
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

  getSplatTextures() {
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

  getShTextures(): SplatShTextures {
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

  static emptyTexture = newUintArrayTexture(null, 1, 1, 1);
}

function newUintArrayTexture(
  data: Uint32Array | null,
  width: number,
  height: number,
  depth: number,
) {
  const texture = new THREE.DataArrayTexture(
    data as Uint32Array<ArrayBuffer>,
    width,
    height,
    depth,
  );
  texture.format = THREE.RGBAIntegerFormat;
  texture.type = THREE.UnsignedIntType;
  texture.internalFormat = "RGBA32UI";
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
