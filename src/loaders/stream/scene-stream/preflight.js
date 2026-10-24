import { abortable } from "../../../runtime/abort.js";
import { readZip } from "../../sog/sogZip.js";
import { checkRange, joinBytes, readResponse } from "../../source.js";
import {
  MAX_INPUT_BYTES,
  MAX_SOURCE_SPLATS,
  checkSourceCount,
} from "./limits.js";

// Bound each deflate input step: one highly compressed Blob chunk could queue tens of MiB before the first read.
function inflateStream(bytes, format) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + 1024);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }).pipeThrough(new DecompressionStream(format));
}

function admittedCount(count, limits) {
  checkSourceCount(count);
  if (limits?.maxPoints !== undefined && count > limits.maxPoints)
    throw new Error(
      `Source header requires ${count} points; admitted maxPoints is ${limits.maxPoints}`,
    );
  return count;
}

function spzHeader(bytes, gzip, declaredCount, limits) {
  if (bytes.length < (gzip ? 16 : 32)) throw new Error("Truncated SPZ header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x5053474e)
    throw new Error("Invalid SPZ header");
  const version = view.getUint32(4, true);
  if (gzip ? version < 1 || version > 3 : version !== 4)
    throw new Error("Unsupported SPZ container/version");
  const count = admittedCount(view.getUint32(8, true), limits);
  if (count < declaredCount)
    throw new Error("Scene record interval exceeds source header count");
  const degree = bytes[12];
  if (degree > 4 || bytes[13] >= 32)
    throw new Error("Invalid SPZ SH degree or fractional bits");
  const stride =
    (version === 1 ? 6 : 9) +
    1 +
    3 +
    3 +
    (version >= 3 ? 4 : 3) +
    3 * degree * (degree + 2);
  return { count, recordBytes: 16 + count * stride };
}

/** Drain, but do not retain, gzip output: headers and forged ISIZE footers cannot bound extensions. */
async function preflightGzip(bytes, declaredCount, signal, limits) {
  const reader = inflateStream(bytes, "gzip").getReader();
  const prefix = new Uint8Array(16);
  let size = 0;
  let header;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      if (size < prefix.length)
        prefix.set(next.value.subarray(0, prefix.length - size), size);
      size += next.value.length;
      if (!header && size >= prefix.length)
        header = spzHeader(prefix, true, declaredCount, limits);
      // Legacy extension semantics are not interpreted. Bound their inflated tail to 1 MiB.
      if (size > (header ? header.recordBytes + 1024 * 1024 : prefix.length))
        throw new Error(
          "SPZ inflated output exceeds record bytes plus 1 MiB extension limit",
        );
    }
    if (!header || size < header.recordBytes)
      throw new Error("Truncated SPZ record data");
    return header.count;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Reject oversized source headers and inflated data before the ordinary decoder allocates output. */
export async function preflightScenePayload(
  bytes,
  codec,
  declaredCount,
  signal,
  limits,
) {
  signal?.throwIfAborted();
  checkSourceCount(declaredCount);
  if (bytes.byteLength > (limits?.maxInputBytes ?? MAX_INPUT_BYTES))
    throw new Error("Scene input exceeds its byte limit");
  if (codec === "sog") {
    const limit = 1024 * 1024;
    let metadata = bytes;
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const zip = await readZip({
        size: bytes.length,
        read: async (offset, length) => {
          signal?.throwIfAborted();
          checkRange(offset, length, bytes.length);
          return bytes.subarray(offset, offset + length);
        },
      });
      if (zip.meta.size > limit || zip.meta.compressedSize > limit)
        throw new Error("SOG scene metadata exceeds 1 MiB");
      const compressed = joinBytes(
        await zip.read(zip.meta),
        zip.meta.compressedSize,
      );
      if (zip.meta.method === 8) {
        const stream = inflateStream(compressed, "deflate-raw");
        const result = await readResponse(
          new Response(stream),
          zip.meta.size,
          () => {},
          signal,
        );
        metadata = joinBytes(result.chunks, result.size);
      } else metadata = compressed;
      if (metadata.length !== zip.meta.size)
        throw new Error("SOG scene metadata length mismatch");
    }
    if (metadata.length > limit)
      throw new Error("SOG scene metadata exceeds 1 MiB");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(metadata)
        .replace(/^\uFEFF+/, ""),
    );
    const count = admittedCount(
      value.version === 2 ? value.count : value.means?.shape?.[0],
      limits,
    );
    if (count < declaredCount)
      throw new Error("Scene record interval exceeds source header count");
    return count;
  }
  if (codec === "spz")
    return bytes[0] === 0x1f && bytes[1] === 0x8b
      ? preflightGzip(bytes, declaredCount, signal, limits)
      : spzHeader(bytes, false, declaredCount, limits).count;
  if (codec !== "ply")
    throw new Error(`Unsupported scene payload codec ${codec}`);
  const header = new TextDecoder().decode(bytes.subarray(0, 65536));
  const end = /^end_header\r?$/m.exec(header)?.index;
  if (end === undefined)
    throw new Error("PLY scene header exceeds 64 KiB or has no vertex count");
  let vertexCount;
  const names = new Set();
  // Match the native parser's trimmed tokens, including an earlier indented terminator.
  for (const line of header.slice(0, end).split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] === "end_header") break;
    if (fields[0] !== "element") continue;
    if (fields.length !== 3 || !/^\+?\d+$/.test(fields[2]))
      throw new Error("Invalid PLY scene element declaration");
    const value = Number(fields[2]);
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SOURCE_SPLATS)
      throw new Error("PLY scene element exceeds source count limit");
    if (names.has(fields[1])) throw new Error("Duplicate PLY scene element");
    names.add(fields[1]);
    if (fields[1] === "vertex") vertexCount = value;
  }
  if (vertexCount === undefined)
    throw new Error("PLY scene header has no vertex count");
  const count = admittedCount(vertexCount, limits);
  if (count < declaredCount)
    throw new Error("Scene record interval exceeds source header count");
  return count;
}

/** The codecs write fixed record slots, including transparent/invalid records; only complete maps may change their order. */
export function validateSceneDecodedSource(data, expectedCount) {
  checkSourceCount(data.numSplats);
  if (data.numSplats !== expectedCount)
    throw new Error("Decoded source count disagrees with scene ranges");
  if (data.sourceIds === undefined) return;
  if (
    !(data.sourceIds instanceof Uint32Array) ||
    data.sourceIds.length < expectedCount
  )
    throw new Error("Source IDs must form a complete source permutation");
  const seen = new Uint8Array(expectedCount);
  for (let index = 0; index < expectedCount; index++) {
    const id = data.sourceIds[index];
    if (id >= expectedCount || seen[id])
      throw new Error("Source IDs must form a complete source permutation");
    seen[id] = 1;
  }
}
