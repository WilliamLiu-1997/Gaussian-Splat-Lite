/** Exponential backoff for temporary streaming failures. */
export function retryDelay(failures: number) {
  return Math.min(30_000, 1000 * 2 ** failures);
}

/** Wake on-demand render loops at the next retry, without polling idle scenes. */
export class RetryTimer {
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = Number.POSITIVE_INFINITY;

  constructor(private readonly wake: () => void) {}

  update(deadlines: Iterable<number>) {
    const now = performance.now();
    let next = Number.POSITIVE_INFINITY;
    for (const at of deadlines) if (at > now) next = Math.min(next, at);
    if (next === this.deadline) return;
    this.dispose();
    this.deadline = next;
    if (Number.isFinite(next))
      this.timer = setTimeout(() => {
        this.dispose();
        this.wake();
      }, next - now);
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = Number.POSITIVE_INFINITY;
  }
}
