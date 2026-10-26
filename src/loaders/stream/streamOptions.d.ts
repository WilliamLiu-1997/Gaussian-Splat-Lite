import type { LoadingManager } from "three";
import type { SplatRequestOptions } from "../loadTypes.js";
export type StreamRequestOptions = SplatRequestOptions & {
  manager?: LoadingManager;
};
/** Single-input options remain shorthand for a one-element source list. */
export declare function streamSources<T>(
  options: T & { sources?: readonly T[] },
): T[];
export type StreamSchedulerOptions = {
  /** Initial Splat budget; update scheduler.splatBudget to change it at runtime. */
  splatBudget?: number;
  /** Maximum decoded and stored SH degree, 0–3. Defaults to 3; fixed at construction. */
  maxSh?: number;
  /** Milliseconds to retain unused data after fade-out; defaults to 2000. */
  cooldownMs?: number;
  fadeDurationMs?: number;
  /** Maximum simultaneous downloads/decodes; defaults to 4. */
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
  /** Estimated CPU cache, excluding pending copies and worker heap overhead. */
  residentCpuBytes: number;
  /** Estimated GPU storage for resident streaming data; excludes renderer buffers. */
  residentGpuBytes: number;
  /** Sum of residentCpuBytes and residentGpuBytes. */
  residentBytes: number;
  /** Estimated in-flight or ready copies awaiting publication into source storage. */
  pendingBytes: number;
  loadingChunks: number;
  /** Ready share of the current view's requested detail, from 0 to 1. Changes with the view. */
  loadProgress: number;
  downloadedBytes: number;
  peakWasmMemoryBytes: number;
};
export declare function positiveInteger(value: number, name: string): number;
export declare function streamSettings(options: StreamSchedulerOptions): {
  splatBudget: number;
  maxSh: number;
  cooldownMs: number;
  fadeDurationMs: number;
  maxConcurrentLoads: number;
};
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
