import { getTextureSize } from "../../../data/textureLayout.js";

export const MAX_SOURCE_SPLATS = 8_000_000;
export const MAX_INPUT_BYTES = 768 * 1024 * 1024;
// Address-space ceiling only; each source admits a smaller enforced capacity.
export const WASM32_BYTES = 2 ** 32;

export function checkSourceCount(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SOURCE_SPLATS)
    throw new Error(
      `Scene source count must be between 1 and ${MAX_SOURCE_SPLATS}`,
    );
  return count;
}

/** Finite decoder contract. Header counts may increase only after a new reservation. */
export function sourceLimits(source) {
  checkSourceCount(source.count);
  const maxPoints = checkSourceCount(source.maxPoints ?? source.count);
  if (maxPoints < source.count)
    throw new Error("source.maxPoints is smaller than its record intervals");
  const maxInputBytes =
    source.maxInputBytes ??
    (source.codec === "lcc"
      ? source.inputBytes
      : Math.min(
          MAX_INPUT_BYTES,
          (source.codec === "sog" ? 8 : 1) * 1024 * 1024 +
            maxPoints * { ply: 384, spz: 128, sog: 64 }[source.codec],
        ));
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes < 0 ||
    maxInputBytes > MAX_INPUT_BYTES
  )
    throw new Error(
      `source.maxInputBytes must be between 0 and ${MAX_INPUT_BYTES}`,
    );
  const capacity = getTextureSize(maxPoints).maxSplats;
  const degree = source.codec === "lcc" ? source.shDegree : 4;
  const arrays = [2, 3, 4, 6, 8][degree];
  if (!arrays) throw new Error("Invalid source SH degree");
  const outputBytes = capacity * (arrays * 16 + 12);
  // SH palettes can contain 960 × 1024 pixels even for a small SOG source.
  const scratchMiB = source.codec === "sog" && source.shDegree !== 0 ? 160 : 32;
  const maxWasmBytes =
    source.maxWasmBytes ??
    Math.ceil(
      (scratchMiB * 1024 * 1024 +
        maxInputBytes * 2 +
        (source.codec === "sog" ? maxPoints * 160 : 0)) /
        65536,
    ) * 65536;
  if (
    !Number.isSafeInteger(maxWasmBytes) ||
    maxWasmBytes < 32 * 1024 * 1024 ||
    maxWasmBytes > WASM32_BYTES - 65536
  )
    throw new Error(
      "source.maxWasmBytes must be between 32 MiB and 4 GiB minus one WASM page",
    );
  return {
    maxPoints,
    maxInputBytes,
    maxWasmBytes,
    maxDecoderBytes: outputBytes + maxWasmBytes,
    outputBytes,
  };
}
