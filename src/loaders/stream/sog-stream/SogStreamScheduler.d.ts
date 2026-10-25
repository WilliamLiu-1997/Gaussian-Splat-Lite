import type * as THREE from "three";
import type { StreamSchedulerOptions, StreamStats } from "../streamOptions.js";
import type { SogStreamLoaderOptions } from "./SogStreamLoader.js";
import type { SogBudgetMode } from "./sogLod.js";
export type SogStreamSchedulerOptions = SogStreamLoaderOptions &
  StreamSchedulerOptions & {
    /** Load and display the manifest's environment; defaults to true. Set only at construction. */
    loadEnvironment?: boolean;
    /** Defaults to "target". "limit" caps detail at the configured distance bands. */
    splatBudgetMode?: SogBudgetMode;
    /** Base LOD distance in world units for "limit" mode; defaults to 100. Must be finite and positive. */
    lodBaseDistance?: number;
    /** Distance multiplier between LOD levels in both modes; defaults to 2. Must be finite and at least 1. */
    lodMultiplier?: number;
    /** Effective distance multiplier directly behind a camera; defaults to 4. Must be finite and at least 1. */
    lodBehindPenalty?: number;
    /** Shrinks oversized regions toward their median size for LOD distance only; defaults to 0.75. Must be between 0 and 1. */
    lodDistanceShrink?: number;
  };
export type SogStreamStats = StreamStats & {
  visibleRegions: number;
};
/** Camera-driven Streamed SOG loading with per-chunk sources and region fades. */
export declare class SogStreamScheduler {
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
  private _lodBehindPenalty;
  private _lodDistanceShrink;
  private readonly options;
  private readonly loader;
  private readonly abort;
  private readonly streamCameras;
  private manifest?;
  private readonly lodLeaves;
  private view?;
  private lastRequestedKey;
  private selecting;
  private refinementStopped;
  private selection;
  private chunks;
  /** Chunks with a batch, cached source or in-flight load. */
  private readonly activeChunks;
  private environment?;
  private leaves;
  private wanted;
  private readonly fades;
  private shown;
  private disposed;
  private resolveFirst;
  private rejectFirst;
  constructor(options: SogStreamSchedulerOptions);
  /** Visible-point budget, including the environment. Reassign to reselect LODs. */
  get splatBudget(): number;
  set splatBudget(value: number);
  /** Fill the budget, or limit detail to the configured distance bands. */
  get splatBudgetMode(): SogBudgetMode;
  set splatBudgetMode(value: SogBudgetMode);
  /** Base LOD distance in world units for limit mode. Higher retains more detail. */
  get lodBaseDistance(): number;
  set lodBaseDistance(value: number);
  /** Distance multiplier between LOD levels; affects both budget modes. */
  get lodMultiplier(): number;
  set lodMultiplier(value: number);
  /** Effective distance multiplier directly behind a camera; 1 disables it. */
  get lodBehindPenalty(): number;
  set lodBehindPenalty(value: number);
  /** Fraction of excess region size removed when measuring LOD distance. */
  get lodDistanceShrink(): number;
  set lodDistanceShrink(value: number);
  get stats(): SogStreamStats;
  /** Group-local bounds from the index; available after initialized resolves. */
  getBoundingBox(): THREE.Box3;
  private initialize;
  /** Cameras that select detail, in registration order. */
  get cameras(): readonly THREE.Camera[];
  hasCamera(camera: THREE.Camera): boolean;
  /**
   * Select detail for this camera on each update. Detail follows distance,
   * so it needs no resolution. For WebXR register renderer.xr.getCamera(): it
   * selects the greatest detail needed by any eye. Returns whether the camera was
   * newly added.
   */
  setCamera(camera: THREE.Camera): boolean;
  /** Stop selecting detail for this camera. Returns whether it was registered. */
  deleteCamera(camera: THREE.Camera): boolean;
  /**
   * Call before rendering. Returns whether the displayed data changed. Each
   * leaf uses the smallest effective distance across registered cameras.
   */
  update(): boolean;
  private requestSelection;
  private updateRequests;
  private selectRegions;
  private leafState;
  private chunkFor;
  private applySelection;
  private updateRegionVisibility;
  private attachPendingRegions;
  private queueExtractions;
  private addBatchRange;
  private fadeRegion;
  private updateFades;
  private extract;
  private releaseUnused;
  private pump;
  private load;
  private pruneChunk;
  private releaseRegion;
  private changed;
  private failed;
  private readonly retryTimer;
  private rejectFirstIfUnavailable;
  private stopRefinement;
  dispose(): void;
}
