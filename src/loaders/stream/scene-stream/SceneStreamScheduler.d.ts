import type * as THREE from "three";
import type { LccDecodeContext } from "../../lcc/lccManifest.js";
import type { RadResourceState } from "../../rad/RadSource.js";
import type { SceneStreamLoader } from "./SceneStreamLoader.js";

export interface SceneStreamOptions {
  url: string;
  /** For local LCC folders, getFileSize can report environment.bin bytes.
   * null means known absent; undefined falls back to a bounded optional-404 fetch.
   * URL resolution failures are never treated as an absent environment. */
  manager?: THREE.LoadingManager & {
    getFileSize?: (url: string) => number | null | undefined;
  };
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  splatBudget?: number;
  /** Owned binary-buffer admission budget, including capped WASM capacity. Default: 2 GiB.
   * Branch cuts prepare one file at a time and publish only when complete.
   * Headers requiring larger whole-file decodes are re-admitted before allocation.
   * JS object overhead and renderer-owned buffers are not included. */
  maxResidentCpuBytes?: number;
  /** Batch textures and index/opacity storage, including reserved coarse coverage and atomic replacement overlap. Default: 1 GiB. */
  maxResidentGpuBytes?: number;
  onChange?: () => void;
  onError?: (error: unknown, url: string) => void;
}
export interface SceneStreamStats {
  visibleSplats: number;
  visibleRegions: number;
  /** Highest SH degree actually present in resident render batches. */
  shDegree: 0 | 1 | 2 | 3 | 4;
  visibleMeshes: number;
  residentMeshes: number;
  residentChunks: number;
  residentBytes: number;
  /** Outstanding source reservations and unpublished backing pages, including CPU and GPU. */
  pendingBytes: number;
  /** Ready source-cache buffers; excludes render pages and decoder temporaries. */
  cachedBytes: number;
  failedNodes: number;
  loadingChunks: number;
  loadProgress: number;
  pendingLoads: number;
  cachedSources: number;
  /** Owned binary-buffer reservations, including admitted decoder and WASM envelopes.
   * This is not a process-memory measurement. */
  residentCpuBytes: number;
  residentGpuBytes: number;
  cpuBudgetEnforced: boolean;
  downloadedBytes: number;
  peakWasmMemoryBytes: number;
  disposed: boolean;
}
export interface SceneSource {
  key: string;
  url: string;
  codec: "lcc" | "ply" | "spz" | "sog";
  count: number;
  shDegree: 0 | 1 | 2 | 3 | 4;
  sourceOffset: number;
  inputBytes?: number;
  offset?: number;
  byteLength?: number;
  shUrl?: string;
  resourceState?: RadResourceState;
  shResourceState?: RadResourceState;
  shOffset?: number;
  shByteLength?: number;
  wholeFile?: boolean;
  context?: LccDecodeContext;
}
export interface SceneRepresentation {
  id: string;
  level?: number;
  count: number;
  ranges: {
    source: SceneSource;
    start: number;
    count: number;
    node?: unknown;
  }[];
}
export interface SceneUnit {
  id: string;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  representations: SceneRepresentation[];
}
export interface SceneModel {
  units: SceneUnit[];
  environment?: SceneRepresentation;
  boundingBox: SceneUnit["boundingBox"];
  metadataBytes: number;
  /** Complete coarse coverage, excluding the environment; absent for spatial leaf streaming. */
  coarseCount?: number;
}
export interface SceneAdapter {
  name: string;
  read(options: SceneStreamOptions, signal: AbortSignal): Promise<SceneModel>;
  select(
    units: SceneUnit[],
    budget: number,
    scores: Map<string, number>,
    shown: Map<string, unknown>,
  ): Map<string, SceneRepresentation>;
}
/** Internal shared lifecycle, not a scene format parser or selector. */
export declare class SceneStreamScheduler {
  readonly group: THREE.Group;
  readonly initialized: Promise<this>;
  /** Resolves without cameras or workers for a valid empty scene. */
  readonly firstRenderable: Promise<this>;
  constructor(
    options: SceneStreamOptions,
    adapter: SceneAdapter,
    dependencies?: {
      loader?: SceneStreamLoader;
      createBatch?: (...args: never[]) => unknown;
    },
  );
  get splatBudget(): number;
  set splatBudget(value: number);
  get cameras(): readonly THREE.Camera[];
  setCamera(camera: THREE.Camera): boolean;
  hasCamera(camera: THREE.Camera): boolean;
  deleteCamera(camera: THREE.Camera): boolean;
  getBoundingBox(): THREE.Box3;
  get stats(): SceneStreamStats;
  update(): boolean;
  dispose(): void;
}
