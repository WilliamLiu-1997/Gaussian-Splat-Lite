/** Exponential backoff for temporary streaming failures. */
export function retryDelay(failures) {
  return Math.min(30_000, 1000 * 2 ** failures);
}
/** Wake on-demand render loops at the next retry, without polling idle scenes. */
export class RetryTimer {
  constructor(wake) {
    this.wake = wake;
    this.deadline = Number.POSITIVE_INFINITY;
  }
  update(deadlines) {
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
