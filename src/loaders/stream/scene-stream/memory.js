import { sogBatchTextureLayout } from "../../../data/SogRegionSplats.js";
import { getTextureSize } from "../../../data/textureLayout.js";

import { checkSourceCount, sourceLimits } from "./limits.js";
export {
  MAX_SOURCE_SPLATS,
  MAX_INPUT_BYTES,
  WASM32_BYTES,
  checkSourceCount,
  sourceLimits,
} from "./limits.js";

export function byteBudget(value, name) {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (
    value !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(value) || value < 0)
  )
    throw new Error(`${name} must be a nonnegative safe integer or Infinity`);
  return value;
}

/** Upper envelopes for owned binary buffers, not JS object/renderer overhead. */
export function regionMemory(count, shDegree) {
  checkSourceCount(count);
  return batchMemory(count, shDegree);
}

/** Rounded render capacity may exceed a single decoder's point-count limit. */
export function batchMemory(count, shDegree) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 2 ** 32)
    throw new Error("Invalid scene batch capacity");
  const arrays = [2, 3, 4, 6, 8][shDegree];
  if (!arrays) throw new Error("Invalid scene SH degree");
  const { capacity } = sogBatchTextureLayout(count);
  const indices =
    getTextureSize(Math.max(1, Math.ceil(count / 4)), 1).maxSplats * 16;
  const spatial = Math.ceil(count / 256) * 24;
  const gpu = capacity * arrays * 16 + indices + capacity * 4;
  // Packed arrays, source/visible IDs, index/opacity tables, bounds and an extraction copy.
  // Each 64-record slot can own separate full/center bounds and spatial-bound copies.
  const regionBounds = Math.ceil(capacity / 64) * 96;
  const cpu =
    gpu +
    capacity * 8 +
    spatial * 2 +
    count * (arrays * 16 + 4) +
    regionBounds +
    65536;
  return { cpu, gpu };
}

/** Owned binary buffers only: transport/sidecars, canonical copies, maps, and capped WASM capacity. */
export function sourceMemory(source) {
  const limits = sourceLimits(source);
  return (
    limits.maxWasmBytes +
    limits.maxInputBytes * 4 +
    limits.outputBytes * 2 +
    limits.maxPoints * 16 +
    8 * 1024 * 1024
  );
}

export class SceneMemory {
  constructor(cpu, gpu) {
    this.maxCpu = byteBudget(cpu, "maxResidentCpuBytes");
    this.maxGpu = byteBudget(gpu, "maxResidentGpuBytes");
    this.cpu = 0;
    this.gpu = 0;
  }
  reserve(cpu, gpu = 0) {
    if (
      cpu === Number.POSITIVE_INFINITY &&
      this.maxCpu !== Number.POSITIVE_INFINITY
    )
      throw new Error(
        "Finite maxResidentCpuBytes cannot bound this whole-file decoder, including WASM and decompression",
      );
    if (this.cpu + cpu > this.maxCpu || this.gpu + gpu > this.maxGpu)
      return undefined;
    // Unbounded decoders are explicitly unaccounted, rather than Infinity - Infinity on release.
    const accounted = Number.isFinite(cpu) ? cpu : 0;
    this.cpu += accounted;
    this.gpu += gpu;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.cpu -= accounted;
      this.gpu -= gpu;
    };
  }
}
