import { Worker } from "node:worker_threads";
import { syncFiles } from "./rad/writeback.js";

// Keep signal handling responsive while the conversion runs synchronous code.
// The worker observes cancellation and unwinds its existing catch/finally blocks.
// Cleanup finishes submitted writeback before closing files and exiting.
export async function start(url, options) {
  const cancelled = new Int32Array(new SharedArrayBuffer(4));
  let progressLine = "";
  const endProgress = () => {
    if (progressLine) process.stdout.write("\n");
    progressLine = "";
  };
  const print = ({ method, args }) => {
    if (method === "writeback") return syncFiles(...args, cancelled);
    if (method === "progress") {
      const [line, done] = args;
      if (process.stdout.isTTY) {
        const width = process.stdout.columns;
        const text = !done && width ? line.slice(0, width - 1) : line;
        process.stdout.write(`\r\x1b[2K${text}${done ? "\n" : ""}`);
        progressLine = done ? "" : text;
      } else console.log(line);
    } else {
      // Insert logs above the live progress instead of leaving a stale row.
      if (progressLine) process.stdout.write("\r\x1b[2K");
      console[method](...args);
      if (progressLine) process.stdout.write(progressLine);
    }
  };
  const interrupt = (signal) => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (Atomics.compareExchange(cancelled, 0, 0, code) === 0) {
      endProgress();
      console.error(
        `${signal}: cancelling conversion; waiting for active disk I/O before cleanup...`,
      );
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const code = await new Promise((resolve, reject) => {
      const worker = new Worker(url, {
        workerData: { options, cancelled },
      });
      worker.on("message", print);
      worker.once("error", reject);
      worker.once("exit", resolve);
    });
    process.exitCode = Atomics.load(cancelled, 0) || code;
  } finally {
    endProgress();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
