import type { Group, LoadingManager } from "three";
import type { SplatRequestOptions } from "../loadTypes";

export type StreamRequestOptions = SplatRequestOptions & {
  manager?: LoadingManager;
};

export type StreamSchedulerOptions = {
  group?: Group;
  splatBudget?: number;
  cooldownTicks?: number;
  fadeDurationMs?: number;
  /** Active downloads/decodes. Ready copies use a separate bounded byte queue. */
  maxConcurrentLoads?: number;
  /** Source upload allowance per update; an oversized unit may proceed alone. */
  maxUploadBytesPerUpdate?: number;
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

export function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export function streamSettings(options: StreamSchedulerOptions) {
  const splatBudget = positiveInteger(
    options.splatBudget ?? 3_000_000,
    "splatBudget",
  );
  const cooldownTicks = options.cooldownTicks ?? 100;
  if (!Number.isSafeInteger(cooldownTicks) || cooldownTicks < 0)
    throw new Error("cooldownTicks must be a nonnegative safe integer");
  const fadeDurationMs = options.fadeDurationMs ?? 200;
  if (!Number.isFinite(fadeDurationMs) || fadeDurationMs < 0)
    throw new Error("fadeDurationMs must be finite and nonnegative");
  const maxConcurrentLoads = positiveInteger(
    options.maxConcurrentLoads ?? 4,
    "maxConcurrentLoads",
  );
  const maxUploadBytesPerUpdate = positiveInteger(
    options.maxUploadBytesPerUpdate ?? 8 * 1024 * 1024,
    "maxUploadBytesPerUpdate",
  );
  return {
    splatBudget,
    cooldownTicks,
    fadeDurationMs,
    maxConcurrentLoads,
    maxUploadBytesPerUpdate,
  };
}

/** One upload window per possible active load; oversized indivisible units still progress. */
export function streamPendingLimit(
  concurrency: number,
  uploadBytes: number,
  unitBytes = 0,
) {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    concurrency * Math.max(uploadBytes, unitBytes),
  );
}

export function retryDelay(failures: number) {
  return Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
}

export function notifyStreamChange(options: StreamSchedulerOptions) {
  try {
    options.onChange?.();
  } catch (error) {
    console.error("Stream onChange failed", error);
  }
}

export function notifyStreamError(
  options: StreamSchedulerOptions,
  error: unknown,
  url: string,
) {
  try {
    if (options.onError) options.onError(error, url);
    else console.error("Streaming load failed", url, error);
  } catch (callbackError) {
    console.error("Stream onError failed", callbackError);
  }
}
