import type {
  SceneModel,
  SceneRepresentation,
  SceneUnit,
} from "../scene-stream/SceneStreamScheduler.js";
import type { LccStreamSchedulerOptions } from "./LccStreamScheduler.js";
/** Unit/LOD representations keep atomic counts and memoize bounded decode ranges on first access. */
export declare function readLccScene(
  options: LccStreamSchedulerOptions,
  signal: AbortSignal,
): Promise<SceneModel & { coarseCount: number }>;
export declare function selectLccUnits(
  units: SceneUnit[],
  budget: number,
  scores: Map<string, number>,
  shown?: Map<string, unknown>,
  options?: Pick<LccStreamSchedulerOptions, "lodDistances" | "lodHysteresis">,
): Map<string, SceneRepresentation>;
