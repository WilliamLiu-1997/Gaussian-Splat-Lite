import { retryDelay } from "../../runtime/retry.js";
/** Inputs are supplied only through a nonempty sources list. */
export function streamSources(options) {
  const { sources } = options;
  if (!Array.isArray(sources) || !sources.length)
    throw new Error("sources must be a nonempty array");
  return sources;
}
/** Validate an input's model-to-group transform. */
export function checkStreamTransform(transform) {
  if (
    !transform?.isMatrix4 ||
    !transform.elements.every(Number.isFinite) ||
    transform.determinant() === 0
  )
    throw new Error("source.transform must be a finite, invertible Matrix4");
  return transform;
}
export function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}
export function streamSettings(options) {
  const splatBudget = positiveInteger(
    options.splatBudget ?? 3_000_000,
    "splatBudget",
  );
  const maxSh = options.maxSh ?? 3;
  if (!Number.isInteger(maxSh) || maxSh < 0 || maxSh > 3)
    throw new Error("maxSh must be an integer between 0 and 3");
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
    maxSh,
    cooldownMs,
    fadeDurationMs,
    maxConcurrentLoads,
  };
}
/** Format errors are permanent; transient failures retry with capped backoff. */
export function streamRetryAt(error, failures) {
  const failure = error;
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
export function notifyStreamChange(options) {
  try {
    options.onChange?.();
  } catch (error) {
    console.error("Stream onChange failed", error);
  }
}
export function notifyStreamError(options, error, url) {
  try {
    if (options.onError) options.onError(error, url);
    else console.error("Streaming load failed", url, error);
  } catch (callbackError) {
    console.error("Stream onError failed", callbackError);
  }
}
