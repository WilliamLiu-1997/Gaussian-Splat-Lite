import { Buffer } from "@jspm/core/nodelibs/buffer";
import { decoderUrl } from "./wasm.js";
export { Buffer };
export { deflateSync as deflateRawSync } from "fflate";
export const decoderSource = () => decoderUrl;
export const availableParallelism = () => navigator.hardwareConcurrency || 1;
export const tmpdir = () => "/tmp";
export const randomBytes = (size) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(size)));
export const getSystemErrorName = String;

export const reportProgress = (
  line,
  done,
  _singleLine,
  end,
  label,
  percent,
  phasePercent,
) => {
  const progress = { line, label, percent, done: done && end };
  if (phasePercent !== undefined) progress.phasePercent = phasePercent;
  self.postMessage({ progress });
};

export const workerOverhead = 32 * 1024 ** 2;
