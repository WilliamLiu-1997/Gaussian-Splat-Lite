/** Reject promptly on cancellation while still observing the underlying task. */
export declare function abortable<T>(
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T>;
/** Link lifetime and per-request cancellation without retaining completed listeners. */
export declare function linkedAbortController(
  ...signals: (AbortSignal | undefined)[]
): {
  controller: AbortController;
  signal: AbortSignal;
  cleanup(): void;
};
