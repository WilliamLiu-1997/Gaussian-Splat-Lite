import { Worker } from "node:worker_threads";
export const createThread = (options) =>
  new Worker(new URL("./task.js", import.meta.url), options);
export const wakePool = (_workers, control, word) =>
  Atomics.notify(control, word);
