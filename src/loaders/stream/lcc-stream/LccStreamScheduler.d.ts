import type * as THREE from "three";
import type { StreamResolutionSource } from "../StreamCameras.js";
import type { StreamSchedulerOptions, StreamStats } from "../streamOptions.js";
import type { LccStreamLoaderOptions } from "./LccStreamLoader.js";
import type { LccInfo } from "./lccIndex.js";
import type { LccBudgetMode } from "./lccSelection.js";
export type LccStreamSchedulerOptions = LccStreamLoaderOptions &
  StreamSchedulerOptions & {
    /** Defaults to "target", which fills the budget. "limit" stops at the XGRIDS detail rules. */
    splatBudgetMode?: LccBudgetMode;
    /** LCC Unit distance between LOD bands, in model units. Default: 20. */
    lodStepDistance?: number;
    /** LCC2 projected node error threshold, in CSS pixels. Default: 40. */
    maxScreenSpaceError?: number;
    /** Load optional environment splats. Default: true. */
    environment?: boolean;
  };
export type LccStreamStats = StreamStats & { visibleNodes: number };
/** LCC Unit LODs and LCC2 spatial trees, with complete replacements and fades. */
export declare class LccStreamScheduler {
  readonly group: THREE.Group;
  readonly initialized: Promise<this>;
  readonly firstRenderable: Promise<this>;
  readonly cooldownMs: number;
  readonly fadeDurationMs: number;
  readonly maxConcurrentLoads: number;
  constructor(options: LccStreamSchedulerOptions);
  get splatBudget(): number;
  set splatBudget(value: number);
  /** Fill the budget, or limit detail to the XGRIDS distance bands and error threshold. */
  get splatBudgetMode(): LccBudgetMode;
  set splatBudgetMode(value: LccBudgetMode);
  get lodStepDistance(): number;
  set lodStepDistance(value: number);
  get maxScreenSpaceError(): number;
  set maxScreenSpaceError(value: number);
  get info(): LccInfo | undefined;
  get cameras(): readonly THREE.Camera[];
  hasCamera(camera: THREE.Camera): boolean;
  setCamera(camera: THREE.Camera): boolean;
  deleteCamera(camera: THREE.Camera): boolean;
  setResolution(
    camera: THREE.Camera,
    xOrVec: number | THREE.Vector2,
    y?: number,
  ): boolean;
  setResolutionFromRenderer(
    camera: THREE.Camera,
    renderer: StreamResolutionSource,
  ): boolean;
  getBoundingBox(): THREE.Box3;
  get stats(): LccStreamStats;
  update(): boolean;
  dispose(): void;
}
