import type * as THREE from "three";
/** Source blocks hold group IDs; a small float32 table holds their opacities. */
export declare class SplatOpacityTable {
  private blocks;
  private readonly blockSize;
  private readonly blocksPerLayer;
  private readonly blockTexture;
  private dirtyLayers;
  private dirty;
  private values;
  private valueTexture;
  private valuesDirty;
  private readonly ranges;
  private readonly freeGroups;
  private nextGroup;
  constructor(capacity: number, layerSize: number, blockBits: number);
  private createTexture;
  private createValueTexture;
  /** CPU arrays and GPU storage each occupy this many bytes. */
  get byteLength(): number;
  getOpacity(source: number): number;
  setGroupOpacity(group: number, opacity: number): boolean;
  private releaseBlock;
  /** Validated ranges retain their group while only its coefficient changes. */
  setOpacity(start: number, count: number, opacity: number): boolean;
  copyBlocks(): Uint32Array<ArrayBuffer>;
  /** Adopt a prepared RAD table, retaining any uploads still pending. */
  commitBlocks(blocks: Uint32Array, dirtyLayers: Uint8Array): void;
  get texture(): THREE.DataArrayTexture;
  get opacityTexture(): THREE.DataArrayTexture;
  dispose(): void;
}
