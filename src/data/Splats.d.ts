import type * as THREE from "three";
import type {
  SplatFileResolver,
  SplatProgressEvent,
} from "../loaders/loadTypes.js";
import type { SplatPostDecodeProgram } from "../loaders/postDecode/program.js";
import type {
  ReorderedSplatResult,
  SplatFileType,
  SplatResult,
} from "./defines.js";
import type { RaycastRangeCallback, SplatRaycastQuery } from "./raycast.js";
import type { decodeSplat } from "./unpack.js";
type DecodedSplat = ReturnType<typeof decodeSplat>;
type DecodedSplatWithSh = DecodedSplat & {
  sh: THREE.Color[];
};
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
  onProgress?: (event: SplatProgressEvent) => void;
};
/** An encoded splat source with two 16-byte texture records per splat. */
export declare class Splats {
  maxSplats: number;
  numSplats: number;
  private splatArrays;
  private sortCenters?;
  protected sourceIds: Uint32Array;
  protected centerOnlyBounds: Float32Array;
  protected bounds: Float32Array;
  private spatialBounds;
  private extra;
  initialized: Promise<Splats>;
  isInitialized: boolean;
  needsUpdate: boolean;
  private textures;
  private shTextures;
  private loadController?;
  constructor(options?: SplatsOptions);
  initialize(options?: SplatsOptions): Promise<Splats>;
  private commitState;
  /** @internal Adopt a loader result with precomputed bounds. */
  initializeDecoded(data: ReorderedSplatResult): void;
  private asyncInitialize;
  dispose(): void;
  private disposeTextures;
  getNumSplats(): number;
  /** @internal Copy cached local bounds into the target box. */
  getBoundingBox(centersOnly?: boolean, target?: THREE.Box3): THREE.Box3;
  getNumSh(): 1 | 2 | 0 | 3;
  /** Current retained bytes for encoded Splat, sort-center, and SH arrays. */
  getByteLength(): number;
  /** @internal Consume owned arrays for transfer to a streaming worker. */
  takeData(): SplatResult & {
    sourceIds: Uint32Array;
  };
  /** Original source ID, retained across reordering and range extraction. */
  getSourceIndex(index: number): number;
  getSplat(index: number): DecodedSplatWithSh;
  getSplat(index: number, includeSh: true): DecodedSplatWithSh;
  getSplat(index: number, includeSh: false): DecodedSplat;
  getSplat(index: number, includeSh: boolean): DecodedSplat;
  /** @internal Consecutive visible records surviving spatial block picking. */
  forEachRaycastRange(
    query: SplatRaycastQuery,
    callback: RaycastRangeCallback,
  ): void;
  copySplatRecords(
    firstTarget: Uint32Array,
    secondTarget: Uint32Array,
    sourceStart: number,
    count: number,
  ): void;
  copySortCenters(
    target: Float32Array,
    targetStart: number,
    count: number,
  ): void;
  private getSortCenters;
  forEachCenter(
    callback: (index: number, x: number, y: number, z: number) => void,
  ): void;
  forEachSplat(
    callback: (
      index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color,
    ) => void,
  ): void;
  setTextureUniforms(uniforms: Record<string, THREE.IUniform>): void;
  private getSplatTextures;
  private disposeMainTextures;
  private getShTextures;
  private ensureShTexture;
  static emptyTexture: THREE.DataArrayTexture;
}
export {};
