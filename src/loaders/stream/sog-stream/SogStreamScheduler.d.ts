import type * as THREE from "three";
import type { StreamSchedulerOptions, StreamStats } from "../streamOptions.js";
import type { SogStreamLoaderOptions } from "./SogStreamLoader.js";
export type SogStreamSchedulerOptions = SogStreamLoaderOptions &
  StreamSchedulerOptions;
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
  private readonly options;
  private readonly loader;
  private readonly abort;
  private readonly streamCameras;
  private manifest?;
  private readonly lodLeaves;
  private view?;
  private lastRequestedKey;
  private selecting;
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
  /** Visible-point target, including the environment. Reassign to reselect LODs. */
  get splatBudget(): number;
  set splatBudget(value: number);
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
   * selects the greatest detail needed by any eye that sees the region. Returns whether the camera was
   * newly added.
   */
  setCamera(camera: THREE.Camera): boolean;
  /** Stop selecting detail for this camera. Returns whether it was registered. */
  deleteCamera(camera: THREE.Camera): boolean;
  /**
   * Call before rendering. Returns whether the displayed data changed. Each
   * leaf uses the distance of the nearest registered camera that sees it.
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
  dispose(): void;
}
