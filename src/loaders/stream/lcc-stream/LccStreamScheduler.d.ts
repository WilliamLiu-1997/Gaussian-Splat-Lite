import type * as THREE from "three";
import type { StreamSchedulerOptions, StreamStats } from "../streamOptions.js";
import type { LccStreamLoaderOptions } from "./LccStreamLoader.js";
import type { LccInfo } from "./lccIndex.js";
import type { LccBudgetMode } from "./lccSelection.js";
export type LccStreamSchedulerOptions = LccStreamLoaderOptions &
  StreamSchedulerOptions & {
    /** Defaults to "target". "limit" caps detail at the configured distance bands. */
    splatBudgetMode?: LccBudgetMode;
    /** Base LOD distance in world units for "limit" mode; defaults to 100. Must be finite and positive. */
    lodBaseDistance?: number;
    /** Distance multiplier between LOD levels in both modes; defaults to 2. Must be finite and at least 1. */
    lodMultiplier?: number;
    /** Load the scene's environment Splats when it has them; defaults to true. */
    environment?: boolean;
  };
export type LccStreamStats = StreamStats & {
  visibleRegions: number;
};
/** Camera-driven XGRIDS LCC and LCC2 streaming with per-node fades. */
export declare class LccStreamScheduler {
  readonly group: THREE.Group;
  readonly initialized: Promise<this>;
  readonly firstRenderable: Promise<this>;
  readonly cooldownMs: number;
  readonly fadeDurationMs: number;
  readonly maxConcurrentLoads: number;
  private _splatBudget;
  private _splatBudgetMode;
  private _lodBaseDistance;
  private _lodMultiplier;
  private readonly options;
  private readonly loader;
  private readonly abort;
  private readonly streamCameras;
  private readonly pool;
  private readonly showEnvironment;
  private table?;
  private environment?;
  private view?;
  private disposed;
  private shown;
  private selecting;
  private lastRequestedKey;
  private boundsVersion;
  private boundsUpdates;
  private readonly nodes;
  private readonly shownNodes;
  private shownBelow?;
  private readonly arrivals;
  private readonly fades;
  private cut;
  private target;
  private above;
  private readonly units;
  private wanted;
  private wantedNodes;
  private dirty;
  private readonly retryTimer;
  private resolveFirst;
  private rejectFirst;
  constructor(options: LccStreamSchedulerOptions);
  /** Splat budget, including the environment. Reassign to reselect detail. */
  get splatBudget(): number;
  set splatBudget(value: number);
  /** Fill the budget, or limit detail to the configured distance bands. */
  get splatBudgetMode(): LccBudgetMode;
  set splatBudgetMode(value: LccBudgetMode);
  /** Base LOD distance in world units for limit mode. Higher retains more detail. */
  get lodBaseDistance(): number;
  set lodBaseDistance(value: number);
  /** Distance multiplier between LOD levels; affects both budget modes. */
  get lodMultiplier(): number;
  set lodMultiplier(value: number);
  /** Scene metadata from the manifest; available after initialized resolves. */
  get info(): LccInfo | undefined;
  get stats(): LccStreamStats;
  /** Group-local scene bounds from the manifest; available after initialized resolves. */
  getBoundingBox(): THREE.Box3;
  private initialize;
  /** Cameras that select detail, in registration order. */
  get cameras(): readonly THREE.Camera[];
  hasCamera(camera: THREE.Camera): boolean;
  /**
   * Select detail for this camera on each update. Detail follows distance, so
   * it needs no resolution. For WebXR register renderer.xr.getCamera(): each
   * node follows the nearest eye that sees it. Returns whether the camera was
   * newly added.
   */
  setCamera(camera: THREE.Camera): boolean;
  /** Stop selecting detail for this camera. Returns whether it was registered. */
  deleteCamera(camera: THREE.Camera): boolean;
  /** Call before rendering. Returns whether the displayed data changed. */
  update(): boolean;
  private requestSelection;
  private setCut;
  private allStates;
  private state;
  private count;
  private ready;
  private isShown;
  private rootOf;
  private cover;
  private coverShown;
  private resolve;
  private setShown;
  private chooseLoads;
  private unit;
  private unitFor;
  private unitUrl;
  private pump;
  private retryDeadlines;
  private load;
  private extract;
  private arrive;
  private writeArrivals;
  private fadeRegion;
  private updateFades;
  private releaseRegion;
  private releaseUnused;
  private changed;
  private failed;
  private rejectFirstIfUnavailable;
  dispose(): void;
}
