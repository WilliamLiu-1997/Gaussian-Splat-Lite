import type * as THREE from "three";
import type { StreamResolutionSource } from "../StreamCameras.js";
import type { StreamSchedulerOptions, StreamStats } from "../streamOptions.js";
import type { RadStreamLoaderOptions } from "./RadStreamLoader.js";
export type RadStreamSchedulerOptions = RadStreamLoaderOptions &
  StreamSchedulerOptions & {
    /** Allowed fractional splat budget overshoot. Default: 0.1; 0 forbids overshoot. */
    splatBudgetTolerance?: number;
    /** Retained CPU byte budget, excluding pending copies and WASM. Default: 2 GiB. */
    maxResidentCpuBytes?: number;
    /** Estimated GPU byte budget for resident streaming data. Default: 1 GiB. */
    maxResidentGpuBytes?: number;
  };
export type RadStreamStats = StreamStats & {
  /** Resident page limit derived from the smaller CPU/GPU allowance. */
  pageBudget: number;
  lodTimeMs: number;
};
/** Camera-driven RAD tree cuts with crossfades, on-demand pages and cooldown. */
export declare class RadStreamScheduler {
  private readonly options;
  readonly group: THREE.Group;
  readonly initialized: Promise<this>;
  readonly firstRenderable: Promise<this>;
  readonly cooldownMs: number;
  readonly fadeDurationMs: number;
  readonly maxConcurrentLoads: number;
  readonly maxResidentCpuBytes: number;
  readonly maxResidentGpuBytes: number;
  private _splatBudget;
  private _splatBudgetTolerance;
  private readonly loader;
  private readonly abort;
  private readonly streamCameras;
  private readonly pages;
  private readonly pools;
  private readonly bounds;
  private readonly matrix;
  private meta?;
  private pageSize;
  private pageBudget;
  private numSh;
  private maxPagePendingBytes;
  private disposed;
  private shown;
  private displayed?;
  private ready?;
  private traversal?;
  private preparation?;
  private wanted;
  private revision;
  private lastRequestedRevision;
  private refinementStopped;
  private lastViewKey;
  private views;
  private lodTimeMs;
  private resolveFirst;
  private rejectFirst;
  constructor(options: RadStreamSchedulerOptions);
  /** Target selected-node budget. Assigning a new value requests LOD selection. */
  get splatBudget(): number;
  set splatBudget(value: number);
  /** Allowed fractional budget overshoot; zero forbids overshoot. */
  get splatBudgetTolerance(): number;
  set splatBudgetTolerance(value: number);
  /** Cameras that select detail, in registration order. */
  get cameras(): readonly THREE.Camera[];
  hasCamera(camera: THREE.Camera): boolean;
  /**
   * Select detail for this camera on each update; set its resolution too. For
   * WebXR register renderer.xr.getCamera(): it selects with its eyes' combined
   * frustum, sized by an eye's viewport. Returns whether the camera was newly
   * added.
   */
  setCamera(camera: THREE.Camera): boolean;
  /** Stop selecting detail for this camera. Returns whether it was registered. */
  deleteCamera(camera: THREE.Camera): boolean;
  /**
   * Set a registered camera's render size in CSS pixels, without the device
   * pixel ratio. Returns whether the camera is registered.
   */
  setResolution(
    camera: THREE.Camera,
    xOrVec: number | THREE.Vector2,
    y?: number,
  ): boolean;
  /** Set a registered camera's resolution from renderer.getSize(). */
  setResolutionFromRenderer(
    camera: THREE.Camera,
    renderer: StreamResolutionSource,
  ): boolean;
  get stats(): RadStreamStats;
  /** Group-local root bounds plus selected Gaussian extents; approximate while streaming. */
  getBoundingBox(): THREE.Box3;
  private initialize;
  /**
   * Call before rendering. Registered cameras share one cut at the greatest
   * detail any of them needs.
   */
  update(): boolean;
  private get selectionBaselineId();
  private requestSelection;
  private selectionPagesReady;
  private prepareSelection;
  private applySelection;
  private invalidatePendingSelection;
  private clearSelectionState;
  /** Worker snapshots and waiting cuts pin pages without renewing cooldown. */
  private isPagePinned;
  private cancelUnusedLoads;
  private updateFade;
  private page;
  private pump;
  private loadPage;
  private setInitialBounds;
  private findSlot;
  private reservePages;
  private uploadPages;
  private releasePage;
  private isPageRequired;
  private releaseUnused;
  private changed;
  private failed;
  private stopRefinement;
  private scheduleRetry;
  private retryDeadlines;
  private readonly retryTimer;
  dispose(): void;
}
