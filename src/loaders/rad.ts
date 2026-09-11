import { RadDecoder, decode_rad_header } from "gaussian-splat-rs";
import { SH_KEYS } from "../data/splatData";
import { getTextureSize } from "../data/textureLayout";
import { linkedAbortController } from "../runtime/abort";
import type { SplatSourceArgs as LoadRadArgs } from "./loadTypes";
import type { PostDecodeSplatData } from "./postDecode/protocol";
import { RadSource } from "./rad/RadSource";
import {
  type RadDecodedChunk,
  type RadHeader,
  collectRadHeader,
  getRadChunkSpan,
} from "./rad/radFormat";
export { isRadPrefix } from "./rad/radFormat";

import { collectBytes, prefetchOrdered } from "./source";

const TEXTURE_KEYS = ["splat0", "splat1", ...SH_KEYS] as const;

/** Check the complete directed forest, including references across RADC pages. */
function validateRadTree(start: Uint32Array, count: Uint16Array) {
  if (start.length !== count.length)
    throw new Error("RAD: invalid tree arrays");
  const owners = new Uint8Array(start.length);
  for (let node = 0; node < start.length; node++) {
    const end = start[node] + count[node];
    if (count[node] && end > start.length)
      throw new Error("RAD: child range is out of bounds");
    for (let child = start[node]; child < end; child++) {
      if (child === node) throw new Error("RAD: node references itself");
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

function createRadOutput(numSplats: number): PostDecodeSplatData {
  const capacity = numSplats ? getTextureSize(numSplats).maxSplats : 0;
  return {
    numSplats,
    splat0: new Uint32Array(capacity * 4),
    splat1: new Uint32Array(capacity * 4),
    sortCenters: new Float32Array(numSplats * 3),
  };
}

/** Copy one chunk without retaining its arrays across reads. */
function copyRadChunk(
  result: PostDecodeSplatData,
  chunk: RadDecodedChunk,
  offset: number,
) {
  let output = offset;
  const { sortCenters: centers, childCount } = chunk;
  if (!centers) throw new Error("RAD: decoded centers are missing");
  for (const key of TEXTURE_KEYS) {
    const source = chunk[key];
    if (!source?.length) continue;
    result[key] ??= new Uint32Array(result.splat0.length);
    const target = result[key];
    if (!childCount) {
      target.set(source.subarray(0, chunk.numSplats * 4), output * 4);
      continue;
    }
    let out = output;
    for (let i = 0; i < chunk.numSplats; i++) {
      if (childCount[i]) continue;
      target[out * 4] = source[i * 4];
      target[out * 4 + 1] = source[i * 4 + 1];
      target[out * 4 + 2] = source[i * 4 + 2];
      target[out * 4 + 3] = source[i * 4 + 3];
      out++;
    }
  }
  if (!childCount) {
    result.sortCenters.set(
      centers.subarray(0, chunk.numSplats * 3),
      output * 3,
    );
    return output + chunk.numSplats;
  }
  for (let i = 0; i < chunk.numSplats; i++) {
    if (childCount[i]) continue;
    result.sortCenters[output * 3] = centers[i * 3];
    result.sortCenters[output * 3 + 1] = centers[i * 3 + 1];
    result.sortCenters[output * 3 + 2] = centers[i * 3 + 2];
    output++;
  }
  return output;
}

/** Replace oversized buffers; subarray views would retain the full allocation. */
function trimRadOutput(result: PostDecodeSplatData, numSplats: number) {
  const capacity = numSplats ? getTextureSize(numSplats).maxSplats : 0;
  result.numSplats = numSplats;
  for (const key of TEXTURE_KEYS) {
    const array = result[key];
    if (array && array.length !== capacity * 4)
      result[key] = array.slice(0, capacity * 4);
  }
  if (result.sortCenters.length !== numSplats * 3)
    result.sortCenters = result.sortCenters.slice(0, numSplats * 3);
  return result;
}

/** Complete-file RAD decode with validated chunk coverage and LOD trees. */
export async function loadRad(args: LoadRadArgs) {
  const request = linkedAbortController(args.signal);
  const { signal } = request;
  let source: RadSource | undefined;
  let decoder: RadDecoder | undefined;
  let parsedHeader: RadHeader | undefined;
  const validateHeader = (bytes: Uint8Array) => {
    const header = decode_rad_header(bytes) as RadHeader | undefined;
    if (!header) throw new Error("RAD: truncated header");
    parsedHeader = header;
  };
  let { file, fileBytes } = args;
  let loaded = 0;
  let total = fileBytes?.byteLength ?? file?.size ?? 0;
  const report = (bytes: number) =>
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
      file = new Blob(buffered.chunks as BlobPart[]);
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
    if (!parsedHeader) validateHeader(await source.readHeader(signal));
    const header = parsedHeader as RadHeader;
    if (args.url && !file && !fileBytes) {
      total =
        header.chunksStart +
        header.meta.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      report(source.stats.downloadedBytes);
    }
    decoder = new RadDecoder(
      JSON.stringify(header.meta),
      header.meta.maxSh ?? 0,
    );
    const tree = header.meta.lodTree
      ? {
          start: new Uint32Array(header.meta.count),
          count: new Uint16Array(header.meta.count),
        }
      : undefined;
    const result = createRadOutput(header.meta.count);
    let outputCount = 0;
    let chunkIndex = 0;
    const input = source;
    // Decode in file order to seed SH codebooks from page zero. Bounded reads of
    // later pages overlap decoding, for both random-access and buffered inputs.
    for await (const bytes of prefetchOrdered(
      header.meta.chunks.length,
      4,
      (index) => input.readChunk(header, index, signal),
      signal,
    )) {
      signal.throwIfAborted();
      const chunk = decoder.decode_chunk(bytes) as RadDecodedChunk;
      const expected = getRadChunkSpan(header.meta, chunkIndex++);
      if (chunk.base !== expected.base || chunk.numSplats !== expected.count)
        throw new Error(
          "RAD: decoded chunk does not match its directory entry",
        );
      if (tree) {
        if (
          chunk.childStart?.length !== chunk.numSplats ||
          chunk.childCount?.length !== chunk.numSplats
        )
          throw new Error("RAD: LOD chunk is missing child arrays");
        tree.start.set(chunk.childStart, chunk.base);
        tree.count.set(chunk.childCount, chunk.base);
      }
      outputCount = copyRadChunk(result, chunk, outputCount);
    }
    args.sendStatus({
      loaded: loaded + source.stats.downloadedBytes,
      total: loaded + source.stats.downloadedBytes,
    });
    if (tree) validateRadTree(tree.start, tree.count);
    return trimRadOutput(result, outputCount);
  } finally {
    request.controller.abort();
    source?.dispose();
    decoder?.free();
    request.cleanup();
  }
}
