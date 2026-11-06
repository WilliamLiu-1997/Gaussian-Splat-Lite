import { RadDecoder, decode_rad_header } from "gaussian-splat-rs";
import { SH_KEYS } from "../data/splatData.js";
import { getTextureSize } from "../data/textureLayout.js";
import { linkedAbortController } from "../runtime/abort.js";
import { wasmCall, wasmFree } from "../runtime/wasmCall.js";
import { RadSource } from "./rad/RadSource.js";
import { collectRadHeader, getRadChunkSpan } from "./rad/radFormat.js";
export { isRadPrefix } from "./rad/radFormat.js";
import { collectBytes, prefetchOrdered } from "./source.js";
const TEXTURE_KEYS = ["splat0", "splat1", ...SH_KEYS, "shLabels"];
/** Rust validates each page's ranges; check ownership and cycles across pages. */
function validateRadTree(start, count) {
  const owners = new Uint8Array(start.length);
  for (let node = 0; node < start.length; node++) {
    const end = start[node] + count[node];
    for (let child = start[node]; child < end; child++) {
      if (owners[child]) throw new Error("RAD: a child has multiple parents");
      owners[child] = 1;
    }
  }
  const queue = new Uint32Array(start.length);
  let next = 0;
  let end = 0;
  for (let node = 0; node < start.length; node++)
    if (!owners[node]) queue[end++] = node;
  while (next < end) {
    const node = queue[next++];
    for (let child = start[node]; child < start[node] + count[node]; child++)
      queue[end++] = child;
  }
  if (end !== start.length) throw new Error("RAD: tree contains a cycle");
}
function createRadOutput(numSplats, mapAttributes) {
  const capacity = getTextureSize(numSplats).maxSplats;
  return {
    numSplats: 0,
    splat0: new Uint32Array(capacity * 4),
    splat1: new Uint32Array(capacity * 4),
    sortCenters: new Float32Array(numSplats * 3),
    sourceIds: mapAttributes ? new Uint32Array(numSplats) : undefined,
  };
}
/** Copy one chunk without retaining its arrays across reads. */
function copyRadChunk(result, chunk, offset) {
  let output = offset;
  const { sortCenters: centers, childCount } = chunk;
  for (const key of TEXTURE_KEYS) {
    const source = chunk[key];
    if (!source?.length) continue;
    const stride = key === "shLabels" ? 1 : 4;
    result[key] ??= new Uint32Array((result.splat0.length / 4) * stride);
    const target = result[key];
    if (!childCount) {
      target.set(source.subarray(0, chunk.numSplats * stride), output * stride);
      continue;
    }
    let out = output;
    for (let i = 0; i < chunk.numSplats; i++) {
      if (childCount[i]) continue;
      for (let word = 0; word < stride; word++)
        target[out * stride + word] = source[i * stride + word];
      out++;
    }
  }
  if (!childCount) {
    if (result.sourceIds)
      for (let i = 0; i < chunk.numSplats; i++)
        result.sourceIds[output + i] = chunk.base + i;
    result.sortCenters.set(
      centers.subarray(0, chunk.numSplats * 3),
      output * 3,
    );
    return output + chunk.numSplats;
  }
  for (let i = 0; i < chunk.numSplats; i++) {
    if (childCount[i]) continue;
    if (result.sourceIds) result.sourceIds[output] = chunk.base + i;
    result.sortCenters[output * 3] = centers[i * 3];
    result.sortCenters[output * 3 + 1] = centers[i * 3 + 1];
    result.sortCenters[output * 3 + 2] = centers[i * 3 + 2];
    output++;
  }
  return output;
}
/** Replace oversized buffers; subarray views would retain the full allocation. */
function trimRadOutput(result, numSplats) {
  const capacity = getTextureSize(numSplats).maxSplats;
  result.numSplats = numSplats;
  for (const key of TEXTURE_KEYS) {
    const array = result[key];
    const stride = key === "shLabels" ? 1 : 4;
    if (array && array.length !== capacity * stride)
      result[key] = array.slice(0, capacity * stride);
  }
  if (result.sortCenters.length !== numSplats * 3)
    result.sortCenters = result.sortCenters.slice(0, numSplats * 3);
  if (result.sourceIds && result.sourceIds.length !== numSplats)
    result.sourceIds = result.sourceIds.slice(0, numSplats);
  return result;
}
/** Complete-file RAD decode with validated chunk coverage and LOD trees. */
export async function loadRad(args) {
  const request = linkedAbortController(args.signal);
  const { signal } = request;
  let source;
  let decoder;
  let parsedHeader;
  const validateHeader = (bytes) => {
    const header = wasmCall(() => decode_rad_header(bytes));
    if (!header) throw new Error("RAD: truncated header");
    parsedHeader = header;
    return header;
  };
  let { file, fileBytes } = args;
  let loaded = 0;
  let total = fileBytes?.byteLength ?? file?.size ?? 0;
  const report = (bytes) =>
    args.sendStatus({
      loaded: loaded + bytes,
      total: loaded + bytes > total ? 0 : total,
    });
  try {
    signal.throwIfAborted();
    if (args.readChunk) {
      const buffered = await collectBytes(
        args.readChunk,
        Number.POSITIVE_INFINITY,
        (bytes) => {
          loaded += bytes;
          report(0);
        },
        signal,
        collectRadHeader(validateHeader),
      );
      file = new Blob(buffered.chunks);
      fileBytes = undefined;
    } else if (file || fileBytes) {
      loaded = total;
      report(0);
    }
    source = new RadSource(
      {
        url: file || fileBytes ? undefined : args.url,
        file,
        fileBytes,
        baseUrl: args.baseUrl,
        requestHeader: args.requestHeader,
        withCredentials: args.withCredentials,
        resolveFile: args.resolveFile,
        resolveAsset: args.resolveAsset,
        onProgress: report,
        validateHeader,
      },
      true,
    );
    const header =
      parsedHeader ?? validateHeader(await source.readHeader(signal));
    if (args.url && !file && !fileBytes) {
      total =
        header.chunksStart +
        header.meta.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      report(source.stats.downloadedBytes);
    }
    decoder = wasmCall(
      () =>
        new RadDecoder(
          JSON.stringify(header.meta),
          Math.min(header.meta.maxSh ?? 0, args.maxSh ?? 3),
        ),
    );
    const activeDecoder = decoder;
    const tree = header.meta.lodTree
      ? {
          start: new Uint32Array(header.meta.count),
          count: new Uint16Array(header.meta.count),
        }
      : undefined;
    // Only postDecode attributes need original node IDs after leaf filtering.
    const result = createRadOutput(
      header.meta.count,
      tree && args.postDecode?.attributes.length > 0,
    );
    let chunkIndex = 0;
    const input = source;
    // Decode in file order: page zero carries the shared SH palette. Bounded reads
    // of later pages overlap decoding, for both random-access and buffered inputs.
    for await (const bytes of prefetchOrdered(
      header.meta.chunks.length,
      4,
      (index) => input.readChunk(header, index, signal),
      signal,
    )) {
      signal.throwIfAborted();
      const chunk = wasmCall(() => activeDecoder.decode_chunk(bytes));
      if (chunk.shPalette) {
        result.shDegree = chunk.shDegree;
        result.shPalette = chunk.shPalette;
      }
      const expected = getRadChunkSpan(header.meta, chunkIndex++);
      // Rust matches the count to its directory entry; verify the requested page.
      if (chunk.base !== expected.base)
        throw new Error(
          "RAD: decoded chunk does not match its directory entry",
        );
      if (tree) {
        tree.start.set(chunk.childStart, chunk.base);
        tree.count.set(chunk.childCount, chunk.base);
      }
      result.numSplats = copyRadChunk(result, chunk, result.numSplats);
    }
    args.sendStatus({
      loaded: loaded + source.stats.downloadedBytes,
      total: loaded + source.stats.downloadedBytes,
    });
    if (tree) validateRadTree(tree.start, tree.count);
    return trimRadOutput(result, result.numSplats);
  } finally {
    request.controller.abort();
    source?.dispose();
    wasmFree(decoder);
    request.cleanup();
  }
}
