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
