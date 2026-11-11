import type { ChunkStreamSourceOptions } from "../chunk-stream/ChunkStreamLoader.js";
import type {
  ChunkStreamSchedulerOptions,
  ChunkStreamSourceSettings,
  ChunkStreamStats,
} from "../chunk-stream/ChunkStreamScheduler.js";
import { LodTreeScheduler } from "../chunk-stream/LodTreeScheduler.js";
export type Lcc2StreamSchedulerOptions = ChunkStreamSchedulerOptions;
export type Lcc2StreamSourceOptions = ChunkStreamSourceOptions;
export type Lcc2StreamSourceSettings = ChunkStreamSourceSettings;
export type Lcc2StreamStats = ChunkStreamStats;
/** Streams LCC2 splat files while retaining complete parent/child coverage. */
export declare class Lcc2StreamScheduler extends LodTreeScheduler {
  /** Creates an empty scheduler; add .lcc2 inputs with addSource(). */
  constructor(options?: Lcc2StreamSchedulerOptions);
}
