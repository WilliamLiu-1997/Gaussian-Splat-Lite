import type {
  SceneModel,
  SceneRepresentation,
  SceneUnit,
} from "../scene-stream/SceneStreamScheduler.js";
import type { Lcc2StreamSchedulerOptions } from "./Lcc2StreamScheduler.js";
export interface Lcc2RefinementNode {
  id: string;
  boundingBox: SceneUnit["boundingBox"];
  /** Advances only across a payload-bearing parent, not every tree edge. */
  payloadLevel: number;
  payload?: Pick<SceneRepresentation, "count" | "ranges">;
  children: Lcc2RefinementNode[];
  /** Undefined means child coverage is incomplete; retain the parent payload. */
  childFrontier?: Lcc2RefinementNode[];
  frontier?: Lcc2RefinementNode[];
}
export interface Lcc2Representation extends SceneRepresentation {
  /** Ordered cut token components; IDs are opaque, never parsed for ancestry. */
  nodeIds: string[];
}
export interface Lcc2SceneUnit extends SceneUnit {
  representations: Lcc2Representation[];
  refinementRoot: Lcc2RefinementNode;
}
export declare function readLcc2Scene(
  options: Lcc2StreamSchedulerOptions,
  signal: AbortSignal,
): Promise<SceneModel & { units: Lcc2SceneUnit[] }>;
export declare function selectLcc2Units(
  units: SceneUnit[],
  budget: number,
  scores: Map<string, number>,
  shown?: Map<string, unknown>,
  options?: Pick<Lcc2StreamSchedulerOptions, "lodDistances" | "lodHysteresis">,
): Map<string, SceneRepresentation>;
