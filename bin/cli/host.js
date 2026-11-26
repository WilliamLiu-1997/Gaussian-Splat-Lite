import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
export { Buffer } from "node:buffer";
export { randomBytes } from "node:crypto";
export { availableParallelism, tmpdir } from "node:os";
export { getSystemErrorName } from "node:util";
export { deflateRawSync } from "node:zlib";
export const decoderSource = () =>
  readFileSync(new URL("../decoder/decoder_bg.wasm", import.meta.url));

export function reportProgress(line, done, singleLine, end) {
  if (parentPort)
    parentPort.postMessage({
      method: "progress",
      args: [line, done && end],
      singleLine: singleLine,
    });
  else if (singleLine && process.stdout.isTTY)
    process.stdout.write(`\r\x1b[2K${line}${done ? "\n" : ""}`);
  else if (done || !singleLine) console.log(line);
}

export const workerOverhead = 0;
