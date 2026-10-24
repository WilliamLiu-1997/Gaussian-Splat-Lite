import type * as THREE from "three";
import type { SplatOpacityTable } from "./SplatOpacityTable.js";
import { Splats, type SplatsOptions } from "./Splats.js";
import type { ReorderedSplatResult, SplatResult } from "./defines.js";
import type { RaycastRangeCallback, SplatRaycastQuery } from "./raycast.js";
import type { decodeSplat } from "./unpack.js";
type IndexedSplatsOptions = {
  capacity: number;
  layerSize: number;
  numSh: number;
  blockBits: number;
  packedOpacityGroups?: boolean;
};
type DecodedSplat = ReturnType<typeof decodeSplat>;
type DecodedSplatWithSh = DecodedSplat & {
  sh: THREE.Color[];
};
/** Fixed packed storage with one visible-index contract for rendering and CPU reads.
 * Fades affect display only: records returned to picking retain their source opacity. */
export declare abstract class IndexedSplats extends Splats {
  readonly layerSize: number;
  readonly numSh: 0 | 1 | 2 | 3 | 4;
  protected readonly opacities: SplatOpacityTable;
  protected sourceIndices: Uint32Array<ArrayBuffer>;
  protected visibleIndices: Uint32Array;
  private sourceArrays;
  private sourceCenters;
  private sourceTextures;
  private indexTexture;
  private readonly blockBits;
  private disposed;
  private readonly spatialChunks;
  private spatialBoundsBytes;
  constructor({
    capacity,
    layerSize,
    numSh,
    blockBits,
    packedOpacityGroups,
  }: IndexedSplatsOptions);
  protected assertLive(): void;
  initialize(options?: SplatsOptions): Promise<Splats>;
  /** Range-based sources can materialize their visible map lazily. */
  protected ensureIndices(): void;
  /** Each source updates its bounds independently of the visible-index map. */
  protected commitIndices(indices: Uint32Array): void;
  /** Reserve index storage and mark it for upload; fill the first count entries synchronously. */
  protected prepareIndices(count: number): Uint32Array<ArrayBuffer>;
  /** Copies packed records. Input buffers remain caller-owned for both formats. */
  /**
   * Copies packed records. Input buffers remain caller-owned for both formats.
   * A large region can be written in parts, records [from, to) at a time,
   * starting at 0; the last part clears the allocation's padding.
   */
  protected writeRecords(
    start: number,
    data: ReorderedSplatResult,
    allocation: number,
    from?: number,
    to?: number,
  ): void;
  private getStorageIndex;
  getSourceIndex(index: number): number;
  private checkVisibleRange;
  getNumSh(): 0 | 1 | 2 | 3 | 4;
  /** Estimated GPU storage for packed records, render indices and opacity tables. */
  get textureByteLength(): number;
  getByteLength(): number;
  private center;
  copySortCenters(
    target: Float32Array,
    targetStart: number,
    count: number,
  ): void;
  protected releaseSpatialBounds(start: number): void;
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
  getSplat(index: number): DecodedSplatWithSh;
  getSplat(index: number, includeSh: true): DecodedSplatWithSh;
  getSplat(index: number, includeSh: false): DecodedSplat;
  getSplat(index: number, includeSh: boolean): DecodedSplat;
  forEachCenter(
    callback: (index: number, x: number, y: number, z: number) => void,
  ): void;
  forEachSplat(callback: Parameters<Splats["forEachSplat"]>[0]): void;
  takeData(): SplatResult & {
    sourceIds: Uint32Array;
  };
  setTextureUniforms(uniforms: Record<string, THREE.IUniform>): void;
  dispose(): void;
}
export {};
