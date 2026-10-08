import type { Group, LoadingManager } from "three";
import { retryDelay } from "../../runtime/retry";
import type { SplatMesh } from "../../scene/SplatMesh";
import type { SplatRequestOptions } from "../loadTypes";

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

/** Batches follow their scheduler's layers, like one model. */
export function syncStreamBatch(batch: SplatMesh, group: Group) {
  batch.layers.mask = group.layers.mask;
}

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
  const cooldownMs = options.cooldownMs ?? 2000;
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0)
    throw new Error("cooldownMs must be finite and nonnegative");
  const fadeDurationMs = options.fadeDurationMs ?? 200;
  if (!Number.isFinite(fadeDurationMs) || fadeDurationMs < 0)
    throw new Error("fadeDurationMs must be finite and nonnegative");
  const maxConcurrentLoads = positiveInteger(
    options.maxConcurrentLoads ?? 4,
    "maxConcurrentLoads",
  );
  return {
    splatBudget,
    cooldownMs,
    fadeDurationMs,
    maxConcurrentLoads,
  };
}

/** Bound queued decode/extraction copies independently of per-update publication. */
export function streamPendingLimit(concurrency: number, unitBytes = 0) {
  const pendingBytesPerLoad = 8 * 1024 * 1024;
  return concurrency * Math.max(pendingBytesPerLoad, unitBytes);
}

/** Format errors are permanent; transient failures retry with capped backoff. */
export function streamRetryAt(error: unknown, failures: number) {
  const failure = error as { fatal?: boolean } | undefined;
  if (failure?.fatal) return Number.POSITIVE_INFINITY;
  const message = error instanceof Error ? error.message : String(error);
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  const retryable = status
    ? [408, 425, 429].includes(Number(status)) || Number(status) >= 500
    : error instanceof TypeError ||
      (error instanceof Error && error.name === "NetworkError");
  const workerLost =
    error instanceof Error && error.name === "WorkerTerminatedError";
  return retryable || workerLost
    ? performance.now() + retryDelay(failures)
    : Number.POSITIVE_INFINITY;
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
