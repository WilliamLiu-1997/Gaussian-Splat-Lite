import {
  type SceneStreamOptions,
  SceneStreamScheduler,
} from "../scene-stream/SceneStreamScheduler.js";
export type Lcc2StreamSchedulerOptions = SceneStreamOptions & {
  /** Default: replace. Verifies 0.0.3 payload-level totals against reversed lodSplats.
   * leaves bypasses replacement-profile validation and streams spatial leaves only.
   * Array-valued node data is unsupported in both modes. */
  refinement?: "replace" | "leaves";
  /** Per-payload-level replacement distances in scene units, coarse-to-fine descending.
   * Missing levels do not refine. Omit to refine as far as the splat budget permits. */
  lodDistances?: number[];
  /** Relative distance-band margin in [0, 1). Default: 0.15.
   * Enter at distance <= band * (1 - margin); retain through band * (1 + margin). */
  lodHysteresis?: number;
};
/** LCC2 0.0.3 coarse-first replacement with atomic composite branch cuts.
 * Source decoding and atomic replacement overlap use shared CPU/GPU admission.
 * Preflight uses DecompressionStream for gzip SPZ and deflated SOG metadata.
 * Record IDs remain file-relative. No reserved basis transform is applied. */
export declare class Lcc2StreamScheduler extends SceneStreamScheduler {
  constructor(options: Lcc2StreamSchedulerOptions);
}
