import type { LccFileType } from "../../lcc/lccManifest.js";
import {
  type SceneStreamOptions,
  SceneStreamScheduler,
} from "../scene-stream/SceneStreamScheduler.js";
export type LccStreamSchedulerOptions = SceneStreamOptions & {
  /** Explicit compatibility override for manifests missing fileType; conflicts reject. */
  fileType?: LccFileType;
  /** Exact paths, relative to the manifest URL or absolute. No case-insensitive lookup.
   * Defaults try lowercase names, then Index.bin/Data.bin/Shcoef.bin/Environment.bin on 404.
   * Local getFileSize selects exact existing names; null means known absent.
   * Remote name probes require Range support; environment size needs an exposed
   * Content-Range total or getFileSize. Resolver errors always propagate. */
  companionPaths?: {
    index?: string;
    data?: string;
    shcoef?: string;
    environment?: string;
  };
  /** Replacement distances per available Unit alternative, coarse-to-fine descending.
   * Missing bands do not refine. Omit to refine as far as the splat budget permits. */
  lodDistances?: number[];
  /** Relative distance-band margin in [0, 1). Default: 0.15.
   * Enter at distance <= band * (1 - margin); retain through band * (1 + margin). */
  lodHysteresis?: number;
};
/** LCC 5.0 Portable/Quality streaming. One alternative per Unit, coarse first.
 * Failed upgrades retain the previous representation. No basis transform is applied. */
export declare class LccStreamScheduler extends SceneStreamScheduler {
  constructor(options: LccStreamSchedulerOptions);
}
