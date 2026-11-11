import {
  ChunkStreamScheduler,
  type ChunkStreamSchedulerOptions,
} from "./ChunkStreamScheduler.js";

/** Applies hierarchical LOD selections while retaining complete coverage. */
export declare class LodTreeScheduler extends ChunkStreamScheduler {
  private drawn;
  constructor(options: ChunkStreamSchedulerOptions, format: "sog" | "lcc2");
  protected isRangeVisible(range: { node: number }): boolean;
  protected selectRegions(): unknown[];
  dispose(): void;
}
