import type { SogStreamBatch } from "../sog-stream/SogStreamBatch.js";
import type { SceneRepresentation } from "./SceneStreamScheduler.js";
import type { SceneMemory } from "./memory.js";

export {};

type Range = SceneRepresentation["ranges"][number];
export {};
export interface SceneRangeMetadata {
  unit: string;
  node?: unknown;
  resource: string;
  start: number;
}
export interface SceneBatchSlot {
  start: number;
  size: number;
  count: number;
  published: boolean;
  released: boolean;
  degree?: number;
  metadata?: SceneRangeMetadata;
  page: {
    degree: number;
    capacity: number;
    cpu: number;
    gpu: number;
    batch?: SogStreamBatch;
    slots: Set<SceneBatchSlot>;
  };
}
export declare function sceneBatchMemory(ranges: readonly Range[]): {
  cpu: number;
  gpu: number;
};
/** Scene-only pooling; SOG streaming keeps its existing batch lifecycle. */
export declare class SceneBatchAllocator {
  readonly pages: Set<SceneBatchSlot["page"]>;
  constructor(
    memory: SceneMemory,
    createBatch: (capacity: number, degree: number) => Promise<SogStreamBatch>,
  );
  estimate(ranges: readonly Range[]): { cpu: number; gpu: number };
  reserve(ranges: readonly Range[]): SceneBatchSlot[] | undefined;
  write(
    slot: SceneBatchSlot,
    data: Parameters<SogStreamBatch["writeRegion"]>[1],
    metadata: SceneRangeMetadata,
  ): Promise<void>;
  publish(slot: SceneBatchSlot, layers: number): void;
  release(slot: SceneBatchSlot): void;
  get pendingBytes(): number;
}
