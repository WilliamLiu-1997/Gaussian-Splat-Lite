import { Buffer } from "@jspm/core/nodelibs/buffer";
import decoderUrl from "../../bin/decoder/decoder_bg.wasm?url";
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
) =>
  self.postMessage({
    progress: { line, label, percent, phasePercent, done: done && end },
  });

export const workerOverhead = 32 * 1024 ** 2;
