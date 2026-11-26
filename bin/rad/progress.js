import { runTime } from "#gsl/clock";
import { reportProgress } from "#gsl/host";

let inlineStarted;

// Call update at batch boundaries, not for every splat. A completed stage is
// the only place that reports 100%; rounding cannot finish a stage early.
export class Progress {
  // Share a timer and one terminal line across the stages started here.
  static inline(run) {
    inlineStarted = runTime();
    try {
      return run();
    } finally {
      inlineStarted = undefined;
    }
  }

  constructor(label, total, detail = "", singleLine = false, interval = 500) {
    this.label = label;
    this.total = total;
    this.singleLine = singleLine;
    this.interval = interval;
    this.updated = performance.now();
    this.started = inlineStarted ?? runTime();
    this.print(0, false, detail);
  }

  update(completed, detail = "") {
    const now = performance.now();
    if (now - this.updated < this.interval) return;
    this.updated = now;
    const percent = this.total
      ? Math.min(99.9, Math.floor((completed * 1000) / this.total) / 10)
      : 0;
    this.print(percent, false, detail);
  }

  finish(detail = "") {
    this.print(100, true, detail);
  }

  print(percent, done, detail) {
    const seconds = ((runTime() - this.started) / 1000).toFixed(1);
    // Build a custom suffix only when the update is displayed.
    const suffix =
      typeof detail === "function" ? detail() : detail && `, ${detail}`;
    const line = `${this.label}: ${percent.toFixed(1)}%${suffix} (${seconds}s)`;
    reportProgress(
      line,
      done,
      this.singleLine,
      inlineStarted === undefined,
      this.label,
      percent,
      this.phasePercent?.(percent),
    );
  }
}
