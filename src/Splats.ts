import * as THREE from "three";

import { SplatLoader } from "./SplatLoader";
import type { SplatShTextures, SplatSource } from "./SplatSource";
import { SPLAT_TEX_WIDTH, type SplatFileType } from "./defines";
import { decodeSplat, encodeSplat, getTextureSize } from "./utils";

export type SplatsOptions = {
  url?: string;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  stream?: ReadableStream;
  /** Exact number of bytes yielded by stream; also used for allocation validation. */
  streamLength?: number;
  maxSplats?: number;
  splatArrays?: [Uint32Array, Uint32Array];
  numSplats?: number;
  construct?: (splats: Splats) => Promise<void> | void;
  onProgress?: (event: ProgressEvent) => void;
  extra?: Record<string, unknown>;
};

/** A mutable splat source with two 16-byte texture records per splat. */
export class Splats implements SplatSource {
  maxSplats = 0;
  numSplats = 0;
  splatArrays: [Uint32Array, Uint32Array] = [
    new Uint32Array(0),
    new Uint32Array(0),
  ];
  extra: Record<string, unknown> = {};

  initialized: Promise<Splats>;
  isInitialized = false;
  needsUpdate = true;

  private textures: [THREE.DataArrayTexture, THREE.DataArrayTexture];
  private shTextures: SplatShTextures = {};

  constructor(options: SplatsOptions = {}) {
    this.textures = [Splats.emptyTexture, Splats.emptyTexture];
    this.initialized = Promise.resolve(this);
    this.reinitialize(options);
  }

  reinitialize(options: SplatsOptions) {
    this.isInitialized = false;
    this.disposeTextures();
    this.extra = {};
    this.maxSplats = options.maxSplats ?? 0;
    this.needsUpdate = true;

    if (
      options.url ||
      options.fileBytes ||
      options.stream ||
      options.construct
    ) {
      this.initialized = this.asyncInitialize(options).then(() => {
        this.isInitialized = true;
        return this;
      });
    } else {
      this.initialize(options);
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
    }
  }

  initialize(options: SplatsOptions) {
    this.disposeTextures();
    this.extra = options.extra ?? {};
    if (options.splatArrays) {
      this.splatArrays = options.splatArrays;
      this.maxSplats = Math.floor(
        Math.min(this.splatArrays[0].length, this.splatArrays[1].length) / 4,
      );
      this.maxSplats =
        Math.floor(this.maxSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      this.numSplats = Math.min(
        this.maxSplats,
        options.numSplats ?? this.maxSplats,
      );
    } else {
      this.maxSplats = options.maxSplats ?? 0;
      this.numSplats = 0;
      this.splatArrays = [new Uint32Array(0), new Uint32Array(0)];
    }
    this.needsUpdate = true;
  }

  private async asyncInitialize(options: SplatsOptions) {
    const loader = new SplatLoader();
    if (options.fileBytes || options.url || options.stream) {
      await loader.loadInternalAsync({
        splats: this,
        url: options.url,
        fileBytes: options.fileBytes,
        fileType: options.fileType,
        fileName: options.fileName,
        stream: options.stream,
        streamLength: options.streamLength,
        onProgress: options.onProgress,
      });
    }

    const maybePromise = options.construct?.(this);
    if (maybePromise instanceof Promise) {
      await maybePromise;
    }
  }

  dispose() {
    this.disposeTextures();
    this.splatArrays = [new Uint32Array(0), new Uint32Array(0)];
    this.extra = {};
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
      this.needsUpdate = true;
    }
    return this.splatArrays;
  }

  getSplat(index: number) {
    if (index < 0 || index >= this.numSplats) {
      throw new Error("Invalid splat index");
    }
    return decodeSplat(this.splatArrays, index);
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
    this.numSplats = Math.max(this.numSplats, index + 1);
    this.needsUpdate = true;
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

  forEachCenter(
    callback: (index: number, x: number, y: number, z: number) => void,
  ) {
    const [splatA, splatB] = this.splatArrays;
    const centerView = new Float32Array(
      splatA.buffer,
      splatA.byteOffset,
      splatA.length,
    );
    for (let index = 0; index < this.numSplats; index += 1) {
      const i4 = index * 4;
      const scaleX = splatB[i4 + 1] >>> 16;
      const scaleY = splatB[i4 + 2] & 0xffff;
      const scaleZ = splatB[i4 + 2] >>> 16;
      if (scaleX === 0xfc00 && scaleY === 0xfc00 && scaleZ === 0xfc00) {
        callback(index, Number.NaN, Number.NaN, Number.NaN);
        continue;
      }
      callback(index, centerView[i4], centerView[i4 + 1], centerView[i4 + 2]);
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
