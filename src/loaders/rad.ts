import { RadDecoder, decode_rad_header } from "gaussian-splat-rs";
import { SH_KEYS, getSplatTextureBytes } from "../data/splatData";
import { getTextureSize } from "../data/textureLayout";
import { linkedAbortController } from "../runtime/abort";
import type { SplatSourceArgs as LoadRadArgs } from "./loadTypes";
import type { PostDecodeSplatData } from "./postDecode/protocol";
import { RadSource } from "./rad/RadSource";
import {
  RAD_FULL_LOAD_LIMIT,
  type RadChunkData,
  type RadDecodedChunk,
  type RadHeader,
  type RadMeta,
  collectRadHeader,
  getRadChunkSpan,
  unpackRadChunk,
} from "./rad/radFormat";
export { isRadPrefix } from "./rad/radFormat";

import { collectBytes, prefetchOrdered } from "./source";

const MAX_FULL_LOAD_BYTES = RAD_FULL_LOAD_LIMIT;

/** Bound ordinary loading's retained typed arrays before decoding any pages.
 * Paging can address much larger datasets because it never assembles this set. */
function validateRadFullLoadBudget(meta: RadMeta) {
  if (
    !Number.isSafeInteger(meta.count) ||
    meta.count < 0 ||
    meta.count > 0xffff_ffff
  )
    throw new Error("RAD: invalid global splat count");
  const degree = meta.maxSh ?? 0;
  const capacity = meta.count ? getTextureSize(meta.count).maxSplats : 0;
  let workingBytes = getSplatTextureBytes(capacity, degree) + meta.count * 12;
  // Global child arrays plus ownership and traversal arrays used for validation.
  if (meta.lodTree) workingBytes += meta.count * 11;
  const check = () => {
    if (
      !Number.isSafeInteger(workingBytes) ||
      workingBytes > MAX_FULL_LOAD_BYTES
    )
      throw new Error(
        "RAD: ordinary loading exceeds the 2 GiB decoded working-set limit; use RadStreamScheduler for this dataset",
      );
  };
  check();
  let expectedBase = 0;
  for (let index = 0; index < meta.chunks.length; index++) {
    const { base, count } = getRadChunkSpan(meta, index);
    if (
      !Number.isSafeInteger(base) ||
      !Number.isSafeInteger(count) ||
      base !== expectedBase ||
      count <= 0 ||
      base + count > meta.count
    )
      throw new Error("RAD: invalid chunk coverage");
    const chunkCapacity = getTextureSize(count).maxSplats;
    workingBytes +=
      getSplatTextureBytes(chunkCapacity, degree) + chunkCapacity * 12;
    if (meta.lodTree) workingBytes += count * 10;
    check();
    expectedBase += count;
  }
  if (expectedBase !== meta.count)
    throw new Error("RAD: incomplete chunk coverage");
  return workingBytes;
}

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

/** Ordinary loading returns leaves in original file order, never parent/child duplicates. */
function assembleRadChunks(
  header: RadHeader,
  chunks: readonly RadChunkData[],
): PostDecodeSplatData {
  const { meta } = header;
  if (chunks.length !== meta.chunks.length)
    throw new Error("RAD: incomplete chunk set");
  validateRadFullLoadBudget(meta);
  let leafCount = 0;
  const childStart = meta.lodTree ? new Uint32Array(meta.count) : undefined;
  const childCount = meta.lodTree ? new Uint16Array(meta.count) : undefined;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const expected = getRadChunkSpan(meta, index);
    if (chunk.base !== expected.base || chunk.numSplats !== expected.count)
      throw new Error("RAD: decoded chunk does not match its directory entry");
    if (meta.lodTree) {
      if (
        chunk.childStart?.length !== chunk.numSplats ||
        chunk.childCount?.length !== chunk.numSplats
      )
        throw new Error("RAD: LOD chunk is missing child arrays");
      childStart?.set(chunk.childStart, chunk.base);
      childCount?.set(chunk.childCount, chunk.base);
      for (const count of chunk.childCount) if (!count) leafCount++;
    } else leafCount += chunk.numSplats;
  }
  if (childStart && childCount) validateRadTree(childStart, childCount);
  const capacity = leafCount ? getTextureSize(leafCount).maxSplats : 0;
  const result: PostDecodeSplatData = {
    numSplats: leafCount,
    splat0: new Uint32Array(capacity * 4),
    splat1: new Uint32Array(capacity * 4),
    sortCenters: new Float32Array(leafCount * 3),
  };
  for (const key of SH_KEYS) {
    if (chunks.some((chunk) => chunk.extra[key]?.length))
      result[key] = new Uint32Array(capacity * 4);
  }
  let output = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.numSplats; index++) {
      if (meta.lodTree && chunk.childCount?.[index]) continue;
      for (let word = 0; word < 4; word++) {
        result.splat0[output * 4 + word] =
          chunk.splatArrays[0][index * 4 + word];
        result.splat1[output * 4 + word] =
          chunk.splatArrays[1][index * 4 + word];
        for (const key of SH_KEYS) {
          const target = result[key];
          if (target)
            target[output * 4 + word] =
              chunk.extra[key]?.[index * 4 + word] ?? 0;
        }
      }
      const centers = chunk.sortCenters;
      if (!centers) throw new Error("RAD: decoded centers are missing");
      for (let axis = 0; axis < 3; axis++)
        result.sortCenters[output * 3 + axis] = centers[index * 3 + axis];
      output++;
    }
  }
  return result;
}

/** Complete-file RAD decode with 2 GiB limits for encoded input and estimated
 * retained typed arrays. Larger datasets use the paged loading path. */
export async function loadRad(args: LoadRadArgs) {
  const request = linkedAbortController(args.signal);
  const { signal } = request;
  let source: RadSource | undefined;
  let decoder: RadDecoder | undefined;
  let parsedHeader: RadHeader | undefined;
  const validateHeader = (bytes: Uint8Array) => {
    const header = decode_rad_header(bytes) as RadHeader | undefined;
    if (!header) throw new Error("RAD: truncated header");
    validateRadFullLoadBudget(header.meta);
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
    if (total > MAX_FULL_LOAD_BYTES)
      throw new Error(
        "RAD: ordinary encoded input exceeds 2 GiB; use RadStreamScheduler",
      );
    if (args.readChunk) {
      const buffered = await collectBytes(
        args.readChunk,
        MAX_FULL_LOAD_BYTES,
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
    const chunks: RadChunkData[] = [];
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
      chunks.push(
        unpackRadChunk(decoder.decode_chunk(bytes) as RadDecodedChunk),
      );
    }
    args.sendStatus({
      loaded: loaded + source.stats.downloadedBytes,
      total: loaded + source.stats.downloadedBytes,
    });
    return assembleRadChunks(header, chunks);
  } finally {
    request.controller.abort();
    source?.dispose();
    decoder?.free();
    request.cleanup();
  }
}
