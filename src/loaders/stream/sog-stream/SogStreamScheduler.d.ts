import type {
  ChunkStreamSchedulerOptions,
  ChunkStreamSourceSettings,
  ChunkStreamStats,
} from "../chunk-stream/ChunkStreamScheduler.js";
import { LodTreeScheduler } from "../chunk-stream/LodTreeScheduler.js";
export type SogStreamSchedulerOptions = ChunkStreamSchedulerOptions;
export type SogStreamSourceSettings = ChunkStreamSourceSettings;
export type SogStreamStats = ChunkStreamStats;
export declare class SogStreamScheduler extends LodTreeScheduler {
  constructor(options?: SogStreamSchedulerOptions);
}

export type { ChunkStreamSourceOptions as SogStreamSourceOptions } from "../chunk-stream/ChunkStreamLoader.js";
