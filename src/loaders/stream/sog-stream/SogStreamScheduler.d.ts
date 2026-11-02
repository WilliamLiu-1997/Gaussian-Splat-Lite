import {
  ChunkStreamScheduler,
  type ChunkStreamSchedulerOptions,
  type ChunkStreamSourceSettings,
  type ChunkStreamStats,
} from "../chunk-stream/ChunkStreamScheduler.js";
export type SogStreamSchedulerOptions = ChunkStreamSchedulerOptions;
export type SogStreamSourceSettings = ChunkStreamSourceSettings;
export type SogStreamStats = ChunkStreamStats;
export declare class SogStreamScheduler extends ChunkStreamScheduler {
  constructor(options?: SogStreamSchedulerOptions);
  protected selectRegions(): { selected: unknown[]; refinements: unknown[] };
}

export type { ChunkStreamSourceOptions as SogStreamSourceOptions } from "../chunk-stream/ChunkStreamLoader.js";
