/** Reject promptly on cancellation while still observing the underlying task. */
export function abortable<T>(
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void task.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

/** Link lifetime and per-request cancellation without retaining completed listeners. */
export function linkedAbortController(...signals: (AbortSignal | undefined)[]) {
  const controller = new AbortController();
  const listeners = signals.flatMap((signal) => {
    if (!signal) return [];
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return [{ signal, abort }];
  });
  return {
    controller,
    signal: controller.signal,
    cleanup() {
      for (const { signal, abort } of listeners)
        signal.removeEventListener("abort", abort);
    },
  };
}
