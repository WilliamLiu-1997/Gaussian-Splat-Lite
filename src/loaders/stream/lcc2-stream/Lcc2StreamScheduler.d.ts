import type { ChunkStreamSourceOptions } from "../chunk-stream/ChunkStreamLoader.js";
import {
  ChunkStreamScheduler,
  type ChunkStreamSchedulerOptions,
  type ChunkStreamSourceSettings,
  type ChunkStreamStats,
} from "../chunk-stream/ChunkStreamScheduler.js";
export type Lcc2StreamSchedulerOptions = Omit<
  ChunkStreamSchedulerOptions,
  "lodDistanceShrink"
> & {
  /** Shrinks oversized regions for LOD distance only; defaults to 0. Must be between 0 and 1. */
  lodDistanceShrink?: number;
};
export type Lcc2StreamSourceOptions = ChunkStreamSourceOptions;
export type Lcc2StreamSourceSettings = ChunkStreamSourceSettings;
export type Lcc2StreamStats = ChunkStreamStats;
/** Streams LCC2 splat files while retaining complete parent/child coverage. */
export declare class Lcc2StreamScheduler extends ChunkStreamScheduler {
  private drawn;
  /** Creates an empty scheduler; add .lcc2 inputs with addSource(). Distance shrink defaults to 0. */
  constructor(options?: Lcc2StreamSchedulerOptions);
  protected isRangeVisible(range: { leaf: number }): boolean;
  protected selectRegions(): { selected: unknown[]; refinements: unknown[] };
  dispose(): void;
}
