import type { Group } from "three";
import type { ReorderedSplatResult } from "../../../data/defines.js";
import type { RegionStreamBatch } from "../RegionStreamBatch.js";
type Entry = {
  batch: RegionStreamBatch;
  free: { start: number; size: number }[];
};
export type LccRegion = {
  entry: Entry;
  batch: RegionStreamBatch;
  start: number;
  size: number;
  opacity: number;
};
export declare class LccRegionPool {
  private readonly group;
  private readonly capacity;
  readonly entries: Set<Entry>;
  constructor(group: Group, capacity: number);
  allocate(data: ReorderedSplatResult): LccRegion;
  release(region: LccRegion): void;
  dispose(): void;
}
export {};
