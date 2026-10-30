import type * as THREE from "three";
import type { StreamSchedulerOptions, StreamStats } from "../streamOptions.js";
import type {
  SogStreamLoaderOptions,
  SogStreamSourceOptions,
} from "./SogStreamLoader.js";
import type { SogBudgetMode } from "./sogLod.js";
export type SogStreamSchedulerOptions = SogStreamLoaderOptions &
  StreamSchedulerOptions & {
    /** Defaults to "target". "limit" caps detail at the configured distance bands. */
    splatBudgetMode?: SogBudgetMode;
    /** Default base LOD distance in world units; defaults to 100. In "target" mode it only sets inputs' relative detail. Must be finite and positive. */
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
/** An input's settings that can change after creation. */
export type SogStreamSourceSettings = Required<
  Pick<SogStreamSourceOptions, "transform" | "environment">
> &
  Pick<SogStreamSourceOptions, "lodBaseDistance" | "lodMultiplier">;
/** Camera-driven Streamed SOG loading with per-chunk sources and region fades. */
export declare class SogStreamScheduler {
  readonly group: THREE.Group;
  private readonly uploads;
  readonly initialized: Promise<this>;
  readonly firstRenderable: Promise<this>;
  readonly cooldownMs: number;
  readonly fadeDurationMs: number;
  readonly maxConcurrentLoads: number;
  private _splatBudget;
  private readonly _maxSh;
  private _splatBudgetMode;
  private _lodBaseDistance;
  private _lodMultiplier;
  private _lodBehindPenalty;
  private _lodDistanceShrink;
  private readonly sourceSettings;
  private sourceLodVersion;
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
  private environments;
  private leaves;
  private wanted;
  private readonly fades;
  private shown;
  private disposed;
  private resolveFirst;
  private rejectFirst;
  constructor(options: SogStreamSchedulerOptions);
  /** An input's current settings; inputs keep their creation order. */
  getSourceSettings(index: number): SogStreamSourceSettings;
  /**
   * Change an input's settings; omitted keys keep their values, and undefined
   * LOD settings follow the scheduler defaults. Loaded data is kept.
   */
  setSourceSettings(
    index: number,
    settings: Partial<SogStreamSourceSettings>,
  ): void;
  private sourceSetting;
  /** Visible-point budget, including the environment. Reassign to reselect LODs. */
  get splatBudget(): number;
  set splatBudget(value: number);
  /** Maximum decoded and stored SH degree (0–3), fixed at construction. */
  get maxSh(): number;
  /** Fill the budget, or limit detail to the configured distance bands. */
  get splatBudgetMode(): SogBudgetMode;
  set splatBudgetMode(value: SogBudgetMode);
  /** Default base LOD distance in world units for inputs without their own. */
  get lodBaseDistance(): number;
  set lodBaseDistance(value: number);
  /** Default distance multiplier between LOD levels, in both budget modes. */
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
  /** Environment chunks of the inputs that enable theirs. */
  private updateEnvironments;
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
