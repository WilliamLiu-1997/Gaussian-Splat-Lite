import type { Group, LoadingManager } from "three";
import type { SplatRequestOptions } from "../loadTypes.js";
export type StreamRequestOptions = SplatRequestOptions & {
  manager?: LoadingManager;
};
export type StreamSchedulerOptions = {
  group?: Group;
  /** Initial Splat budget; update scheduler.splatBudget to change it at runtime. */
  splatBudget?: number;
  /** Milliseconds to retain unused data after fade-out; defaults to 2000. */
  cooldownMs?: number;
  fadeDurationMs?: number;
  /** Active downloads/decodes. Ready copies use a separate bounded byte queue. */
  maxConcurrentLoads?: number;
  onChange?: () => void;
  onError?: (error: unknown, url: string) => void;
};
export type StreamStats = {
  visibleSplats: number;
  visibleMeshes: number;
  residentMeshes: number;
  /** Decoded chunks, including cached chunks that are not currently drawn. */
  residentChunks: number;
  /** Retained CPU and estimated GPU bytes, excluding pending copies and WASM. */
  residentBytes: number;
  /** Reserved or ready copies awaiting publication into source storage. */
  pendingBytes: number;
  loadingChunks: number;
  downloadedBytes: number;
  peakWasmMemoryBytes: number;
};
export declare function positiveInteger(value: number, name: string): number;
export declare function streamSettings(options: StreamSchedulerOptions): {
  splatBudget: number;
  cooldownMs: number;
  fadeDurationMs: number;
  maxConcurrentLoads: number;
};
/** Bound queued decode/extraction copies independently of per-update publication. */
export declare function streamPendingLimit(
  concurrency: number,
  unitBytes?: number,
): number;
/** Format errors are permanent; transient failures retry with capped backoff. */
export declare function streamRetryAt(error: unknown, failures: number): number;
export declare function notifyStreamChange(
  options: StreamSchedulerOptions,
): void;
export declare function notifyStreamError(
  options: StreamSchedulerOptions,
  error: unknown,
  url: string,
): void;
