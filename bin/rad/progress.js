import { parentPort } from "node:worker_threads";

let inline = false;

// Call update at batch boundaries, not for every splat. A completed stage is
// the only place that reports 100%; rounding cannot finish a stage early.
export class Progress {
  // Keep synchronous setup steps on the same line as the stage that follows.
  static inline(run) {
    inline = true;
    try {
      return run();
    } finally {
      inline = false;
    }
  }

  constructor(label, total, detail = "", singleLine = false, interval = 500) {
    this.label = label;
    this.total = total;
    this.singleLine = singleLine;
    this.interval = interval;
    this.started = performance.now();
    this.updated = this.started;
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
    const seconds = ((performance.now() - this.started) / 1000).toFixed(1);
    const line = `${this.label}: ${percent.toFixed(1)}%${detail ? `, ${detail}` : ""} (${seconds}s)`;
    if (parentPort)
      parentPort.postMessage({
        method: "progress",
        args: [line, done && !inline],
        singleLine: this.singleLine,
      });
    else if (this.singleLine && process.stdout.isTTY)
      process.stdout.write(`\r\x1b[2K${line}${done ? "\n" : ""}`);
    else if (done || !this.singleLine) console.log(line);
  }
}
