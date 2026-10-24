import type * as THREE from "three";
import type { RegionStreamBatch } from "../RegionStreamBatch.js";
export type LccPoolEntry = {
  batch: RegionStreamBatch;
  numSh: number;
  /** Free Splat ranges, sorted by start. */
  free: { start: number; size: number }[];
};
export type LccRegionAllocation = {
  entry: LccPoolEntry;
  start: number;
  size: number;
};
/**
 * Node regions packed into shared batches. Each batch stores one SH degree,
 * the degree its data decoded with, so SH0 scenes allocate only base records.
 */
export declare class LccRegionPool {
  private readonly group;
  private readonly batchSplats;
  readonly entries: Set<LccPoolEntry>;
  constructor(group: THREE.Group, batchSplats: number);
  /** First fit in an existing batch of the same degree, else a new batch. */
  allocate(count: number, numSh: number, name: string): LccRegionAllocation;
  private take;
  /** Releasing a batch's last region disposes the batch. */
  release(allocation: LccRegionAllocation): void;
  setLayers(mask: number): void;
  dispose(): void;
}
