import { decode_lcc_splats } from "gaussian-splat-rs";
import {
  getSplatByteLength,
  getSplatShDegree,
} from "../../../data/splatData.js";
import { extractSplatRange } from "../../../data/splatRange.js";
import { wasmCall } from "../../../runtime/wasmCall.js";
import { reorderSplats } from "../../morton.js";
import { collectBytes, joinBytes, readResponse } from "../../source.js";
import {
  isLcc2Manifest,
  packLcc2Index,
  packLccIndex,
  parseLccJson,
  parseLccMeta,
} from "./lccIndex.js";
import { LccSelection } from "./lccSelection.js";
const TABLE_ARRAYS = [
  "count",
  "level",
  "parent",
  "firstChild",
  "childCount",
  "location",
  "start",
  "roots",
];
function request({ requestHeader, withCredentials }, range) {
  const headers = new Headers(requestHeader);
  if (range) headers.set("Range", `bytes=${range[0]}-${range[1]}`);
  return {
    headers,
    credentials: withCredentials ? "include" : "same-origin",
  };
}
/** Read exactly `length` bytes; byte ranges must not be re-encoded. */
async function readRange(source, offset, length, signal, progress) {
  if (!length) return new Uint8Array(0);
  // Ranges served from a partial HTTP cache entry can carry the whole
  // resource's Content-Length or end early; the cache adds nothing here.
  const response = await fetch(source.url, {
    ...request(source, [offset, offset + length - 1]),
    cache: "no-store",
    signal,
  });
  const encoding = response.headers.get("Content-Encoding");
  if (
    response.status === 206 &&
    encoding &&
    encoding.toLowerCase() !== "identity"
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("LCC: byte ranges must use identity Content-Encoding");
  }
  if (
    response.status === 200 &&
    (offset !== 0 || Number(response.headers.get("Content-Length")) !== length)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `LCC: ${source.url} ignored a byte-range request; streaming requires Range support`,
    );
  }
  // Content-Range can be hidden from browser JavaScript by CORS.
  const range = response.headers.get("Content-Range");
  const match = range && /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(range);
  if (
    response.status === 206 &&
    range !== null &&
    (!match ||
      Number(match[1]) !== offset ||
      Number(match[2]) !== offset + length - 1)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("LCC: Content-Range does not match the requested bytes");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} loading ${source.url}`);
  }
  // Bound the body itself; proxies may report the whole resource's length.
  const reader = response.body.getReader();
  try {
    const { chunks, size } = await collectBytes(
      async () => {
        const chunk = await reader.read();
        return chunk.done ? undefined : chunk.value;
      },
      length,
      progress,
      signal,
    );
    if (size !== length) {
      // A body cut short is a transport failure, retried like other network errors.
      const error = new Error("LCC: truncated byte-range response");
      error.name = "NetworkError";
      throw error;
    }
    return joinBytes(chunks, size);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
/** A whole file in one request; a body shorter than announced is retried. */
async function readFile(source, signal, progress) {
  const response = await fetch(source.url, { ...request(source), signal });
  const announced = Number(response.headers.get("Content-Length"));
  const encoding = response.headers.get("Content-Encoding");
  const { chunks, size } = await readResponse(
    response,
    Number.POSITIVE_INFINITY,
    progress,
    signal,
  );
  if (
    (!encoding || encoding.toLowerCase() === "identity") &&
    announced > 0 &&
    size < announced
  ) {
    const error = new Error(`LCC2: truncated response for ${source.url}`);
    error.name = "NetworkError";
    throw error;
  }
  return joinBytes(chunks, size);
}
/** Packed output in Morton order, with source IDs offset to the file's numbering. */
function finishSplats(data, sourceBase) {
  reorderSplats(data);
  data.sortCenters = undefined;
  if (sourceBase)
    for (let i = 0; i < data.numSplats; i++) data.sourceIds[i] += sourceBase;
  return data;
}
function decodeRecords(base, sh, interleaved, ranges) {
  const decoded = wasmCall(() =>
    decode_lcc_splats(base, sh, interleaved, ranges),
  );
  return {
    numSplats: decoded.numSplats,
    splatArrays: [decoded.splat0, decoded.splat1],
    sortCenters: decoded.sortCenters,
    extra: {
      shBlock0: decoded.shBlock0,
      shBlock1: decoded.shBlock1,
      shBlock2: decoded.shBlock2,
      shBlock3: decoded.shBlock3,
    },
  };
}
/** Cumulative download progress, reported at most every 50 ms. */
function reporter(sendStatus) {
  let loaded = 0;
  let last = 0;
  const report = (bytes) => {
    loaded += bytes;
    const now = performance.now();
    if (now - last >= 50) {
      last = now;
      sendStatus({ loaded });
    }
  };
  report.flush = () => sendStatus({ loaded });
  return report;
}
/** The LOD worker owns the node table and cuts; decoder workers own loads and LCC2 file caches. */
export function createLccStreamHandlers(decodeSplats) {
  const files = new Map();
  const loads = new Map();
  let meta;
  let selection;
  const track = (id) => {
    const controller = new AbortController();
    loads.set(id, controller);
    return controller;
  };
  const publish = (table) => {
    selection = new LccSelection(table);
    // The selection keeps its arrays; RPC transfers copies. Bounds stay here.
    const { bounds, cullBounds, ...copy } = table;
    for (const key of TABLE_ARRAYS) copy[key] = table[key].slice();
    copy.sceneBounds = table.sceneBounds.slice();
    copy.retainedIndexBytes = selection.byteLength;
    return copy;
  };
  return {
    /** LCC2 returns its node table; LCC needs index.bin next. */
    parseLccManifest({ bytes, baseUrl }) {
      const json = parseLccJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (isLcc2Manifest(json)) return publish(packLcc2Index(json, baseUrl));
      meta = parseLccMeta(json);
      return {
        format: "lcc",
        levels: meta.levels,
        hasSh: meta.hasSh,
        ranges: meta.ranges.slice(),
        environmentRanges: meta.environmentRanges.slice(),
      };
    },
    parseLccUnits({ bytes }) {
      if (!meta) throw new Error("LCC: meta.lcc must be parsed first");
      return publish(packLccIndex(meta, new Uint8Array(bytes)));
    },
    selectLcc(request) {
      return selection.select(request);
    },
    setLccBounds({ updates }) {
      selection.setBounds(updates);
    },
    /** One LCC node: its data.bin records and, for SH scenes, shcoef.bin records. */
    async loadLccRecords(
      { id, data, sh, count, ranges, sourceBase, source },
      { sendStatus },
    ) {
      const controller = track(id);
      const progress = reporter(sendStatus);
      try {
        const [base, coefficients] = await Promise.all([
          readRange(
            { ...source, url: data },
            sourceBase * 32,
            count * 32,
            controller.signal,
            progress,
          ),
          sh &&
            readRange(
              { ...source, url: sh },
              sourceBase * 64,
              count * 64,
              controller.signal,
              progress,
            ),
        ]);
        controller.signal.throwIfAborted();
        return finishSplats(
          decodeRecords(base, coefficients || undefined, false, ranges),
          sourceBase,
        );
      } finally {
        progress.flush();
        loads.delete(id);
      }
    },
    /** environment.bin interleaves SH with base records; absent files return undefined. */
    async loadLccEnvironment(
      { id, url, hasSh, ranges, source },
      { sendStatus },
    ) {
      const controller = track(id);
      const progress = reporter(sendStatus);
      try {
        const response = await fetch(url, {
          ...request(source),
          signal: controller.signal,
        });
        // Single-page hosts answer missing files with their HTML page.
        if (
          response.status === 404 ||
          (response.ok &&
            response.headers.get("Content-Type")?.startsWith("text/html"))
        ) {
          await response.body?.cancel().catch(() => {});
          return undefined;
        }
        const { chunks, size } = await readResponse(
          response,
          Number.POSITIVE_INFINITY,
          progress,
          controller.signal,
        );
        return finishSplats(
          decodeRecords(joinBytes(chunks, size), undefined, hasSh, ranges),
          0,
        );
      } finally {
        progress.flush();
        loads.delete(id);
      }
    },
    /**
     * Decode an LCC2 splat file in file order and keep it for node extraction.
     * Each file is needed whole, so it downloads in one request.
     */
    async loadLccFile({ id, required, url, ...args }, options) {
      const controller = track(id);
      const progress = reporter(options.sendStatus);
      try {
        const fileBytes = await readFile(
          { ...args, url },
          controller.signal,
          progress,
        );
        progress.flush();
        const data = await decodeSplats(
          { ...args, pathName: url, fileBytes, signal: controller.signal },
          options,
        );
        controller.signal.throwIfAborted();
        if (data.numSplats < required)
          throw new Error(
            `LCC2: ${url} has ${data.numSplats} Splats; its nodes need ${required}`,
          );
        // Extracted nodes compute their own centers and bounds.
        data.sortCenters = undefined;
        files.set(id, data);
        return {
          numSplats: data.numSplats,
          numSh: getSplatShDegree(data.extra),
          byteLength: getSplatByteLength(data),
        };
      } finally {
        loads.delete(id);
      }
    },
    extractLccNodes({ id, ranges }) {
      const file = files.get(id);
      if (!file) throw new Error("LCC2 file is no longer cached");
      return ranges.map(({ start, count }) =>
        finishSplats(extractSplatRange(file, start, count), start),
      );
    },
    cancelLccLoad({ id }) {
      loads.get(id)?.abort();
    },
    releaseLccFile({ id }) {
      loads.get(id)?.abort();
      files.delete(id);
    },
  };
}
