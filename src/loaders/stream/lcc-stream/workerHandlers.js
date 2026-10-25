import {
  getSplatByteLength,
  getSplatShDegree,
} from "../../../data/splatData.js";
import { extractSplatRange } from "../../../data/splatRange.js";
import { reorderSplats } from "../../morton.js";
import {
  checkRange,
  joinBytes,
  readResponse,
  requestOptions,
} from "../../source.js";
import { parseLcc2Index, parseLccIndex, parseLccJson } from "./lccIndex.js";
import { LccSelection } from "./lccSelection.js";

/** Strict byte ranges prevent an ignored Range response from downloading an entire LCC scene. */
async function read(
  request,
  signal,
  progress,
  resources,
  offset,
  length,
  optional = false,
) {
  const options = requestOptions(request, request.url, request.baseUrl);
  if (length !== undefined) {
    checkRange(offset, length);
    if (!length) return new Uint8Array();
    options.headers.set("Range", `bytes=${offset}-${offset + length - 1}`);
  }
  const response = await fetch(request.url, { ...options, signal });
  if (optional && response.status === 404) {
    await response.body?.cancel();
    return new Uint8Array();
  }
  if (response.ok && length !== undefined) {
    const range = response.headers.get("Content-Range");
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range ?? "");
    const total = match && match[3] !== "*" ? Number(match[3]) : undefined;
    const encoding = response.headers.get("Content-Encoding");
    if (
      response.status !== 206 ||
      (encoding && encoding.toLowerCase() !== "identity") ||
      (range &&
        (!match ||
          Number(match[1]) !== offset ||
          Number(match[2]) !== offset + length - 1 ||
          (total !== undefined &&
            (!Number.isSafeInteger(total) || total < offset + length))))
    ) {
      await response.body?.cancel();
      throw new Error("LCC: server must honor HTTP byte-range requests");
    }
    const etag = response.headers.get("ETag");
    resources.push({
      url: request.baseUrl,
      etag: etag && !etag.startsWith("W/") ? etag : undefined,
      lastModified: response.headers.get("Last-Modified") ?? undefined,
      total,
    });
  }
  const { chunks, size } = await readResponse(
    response,
    length ?? Number.POSITIVE_INFINITY,
    progress,
    signal,
  );
  if (length !== undefined && size !== length)
    throw new Error("LCC: truncated byte range");
  return joinBytes(chunks, size);
}
export function createLccStreamHandlers(decodeSplats, decodeRecords) {
  const files = new Map();
  const loads = new Map();
  let meta;
  let selection;
  const initializeIndex = (index) => {
    selection = new LccSelection(index);
    meta = undefined;
    let retainedIndexBytes = 0;
    for (const value of Object.values(index))
      if (ArrayBuffer.isView(value)) retainedIndexBytes += value.byteLength;
    // Selection owns the full index. Transfer only the scheduler's arrays,
    // copying them so the worker can continue selecting after the transfer.
    return {
      format: index.format,
      levels: index.levels,
      maxLod: index.maxLod,
      parents: index.parents.slice(),
      level: index.level.slice(),
      firstChild: index.firstChild.slice(),
      childCount: index.childCount.slice(),
      counts: index.counts.slice(),
      chunk: index.chunk.slice(),
      start: index.start.slice(),
      chunks: index.chunks,
      sceneBounds: index.sceneBounds,
      info: index.info,
      environment: index.environment,
      hasSh: index.hasSh,
      ranges: index.ranges?.slice(),
      environmentRanges: index.environmentRanges?.slice(),
      shUrl: index.shUrl,
      empty: selection.empty,
      retainedIndexBytes,
    };
  };
  return {
    parseLccManifest({ bytes, baseUrl }) {
      meta = parseLccJson(new TextDecoder().decode(bytes));
      if (meta.root) return initializeIndex(parseLcc2Index(meta, baseUrl));
    },
    parseLccIndex({ bytes, baseUrl }) {
      return initializeIndex(parseLccIndex(meta, bytes, baseUrl));
    },
    selectLcc(request) {
      return selection.select(request);
    },
    async loadLccChunk({ id, request, chunk, hasSh, ranges, sh }, options) {
      const controller = new AbortController();
      loads.set(id, controller);
      const resources = [];
      let loaded = 0;
      let last = Number.NEGATIVE_INFINITY;
      const progress = (bytes) => {
        loaded += bytes;
        const now = performance.now();
        if (now - last >= 50) {
          options.sendStatus({ loaded });
          last = now;
        }
      };
      try {
        let data;
        if (chunk.type) {
          data = await decodeSplats(
            { ...request, fileType: chunk.type, signal: controller.signal },
            options,
          );
        } else {
          const [base, coefficients] = await Promise.all([
            read(
              request,
              controller.signal,
              progress,
              resources,
              chunk.offset,
              chunk.size,
              chunk.environment,
            ),
            hasSh && !chunk.environment
              ? read(
                  sh,
                  controller.signal,
                  progress,
                  resources,
                  chunk.offset * 2,
                  chunk.size * 2,
                )
              : undefined,
          ]);
          controller.signal.throwIfAborted();
          data = decodeRecords(
            base,
            coefficients,
            !!(chunk.environment && hasSh),
            ranges,
          );
        }
        controller.signal.throwIfAborted();
        if (chunk.count >= 0 && data.numSplats < chunk.count)
          throw new Error(
            "LCC: decoded file is shorter than its indexed ranges",
          );
        data.sortCenters = undefined;
        files.set(id, data);
        return {
          numSplats: data.numSplats,
          numSh: getSplatShDegree(data.extra),
          byteLength: getSplatByteLength(data),
          resources,
        };
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        if (!chunk.type) options.sendStatus({ loaded });
        loads.delete(id);
      }
    },
    extractLccNodes({ id, ranges }) {
      const source = files.get(id);
      if (!source) throw new Error("LCC: decoded file is no longer cached");
      return ranges.map(({ start, count }) => {
        const data = extractSplatRange(source, start, count);
        reorderSplats(data);
        return data;
      });
    },
    releaseLccChunk({ id }) {
      loads.get(id)?.abort();
      files.delete(id);
    },
  };
}
