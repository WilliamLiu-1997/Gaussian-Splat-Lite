import { decode_to_splats } from "gaussian-splat-rs";
import { abortable } from "../runtime/abort.js";
import { wasmCall, wasmFree } from "../runtime/wasmCall.js";
import { getAssetBaseUrl } from "./assetUrl.js";
import { reorderSplats } from "./morton.js";
import { applySplatPostDecode } from "./postDecode/runtime.js";
import { isRadPrefix, loadRad } from "./rad.js";
import { isSogPrefix, loadSog } from "./sog.js";
/** Limit worker messages while always reporting stage boundaries. */
function createStageProgress(sendStatus, stage) {
  if (!sendStatus) return undefined;
  let lastReport = Number.NEGATIVE_INFINITY;
  return (loaded, total) => {
    const now = performance.now();
    if (loaded === 0 || loaded === total || now - lastReport >= 50) {
      sendStatus({ stage, loaded, total });
      lastReport = now;
    }
  };
}
async function decodeInput(args) {
  const {
    file,
    fileType,
    pathName,
    baseUrl,
    url,
    requestHeader,
    withCredentials,
    sendStatus,
    resolveAsset,
  } = args;
  let { fileBytes } = args;
  if (
    fileType === "rad" ||
    (!fileType &&
      (/\.rad(?:[?#]|$)/i.test(pathName ?? url ?? "") ||
        (fileBytes && isRadPrefix(fileBytes)) ||
        (file &&
          isRadPrefix(new Uint8Array(await file.slice(0, 4).arrayBuffer())))))
  ) {
    return loadRad(args);
  }
  if (
    fileType === "sog" ||
    (!fileType &&
      (/(?:\.sog|(?:^|\/)meta\.json)(?:[?#]|$)/i.test(pathName ?? url ?? "") ||
        (fileBytes && isSogPrefix(fileBytes)) ||
        (file &&
          isSogPrefix(
            new Uint8Array(await file.slice(0, 4096).arrayBuffer()),
          ))))
  ) {
    return loadSog(args);
  }
  let streamLength = fileBytes?.length ?? file?.size ?? 0;
  let expectedInputLength = streamLength;
  let responseBody = file?.stream();
  let responseUrl = url;
  if (!fileBytes && url) {
    const request = new Request(url, {
      headers: requestHeader ? new Headers(requestHeader) : undefined,
      credentials: withCredentials ? "include" : "same-origin",
      signal: args.signal,
    });
    const response = await fetch(request);
    if (!response.ok || !response.body) {
      throw new Error(
        `HTTP ${response.status} loading "${url}": ${response.statusText}`,
      );
    }
    responseBody = response.body;
    responseUrl = response.url;
    const contentLength = Number(response.headers.get("Content-Length") || "0");
    const responseLength =
      Number.isSafeInteger(contentLength) && contentLength > 0
        ? contentLength
        : 0;
    streamLength ||= responseLength;
    const contentEncoding = response.headers.get("Content-Encoding");
    // A CORS-filtered response can hide Content-Encoding while exposing
    // Content-Length, so only use the response length for decoder validation
    // when every response header is visible.
    const hasIdentityEncoding =
      !contentEncoding || contentEncoding.toLowerCase() === "identity";
    if (response.type === "basic" && hasIdentityEncoding) {
      expectedInputLength = responseLength;
    }
  } else if (!fileBytes && !file) {
    throw new Error("No url, file, or fileBytes provided");
  }
  const streamReader = responseBody?.getReader();
  const readInputChunk = async () => {
    if (fileBytes) {
      const chunk = fileBytes;
      fileBytes = undefined;
      return chunk;
    }
    if (streamReader) {
      for (;;) {
        const { done, value } = await streamReader.read();
        if (done) return undefined;
        if (value.length) return value;
      }
    }
  };
  let loaded = 0;
  let decoder;
  try {
    // Keep the sniffed prefix for either decoder, including tiny stream chunks.
    const pending = [];
    const prefix = new Uint8Array(4096);
    let prefixSize = 0;
    if (!fileType && !file && !fileBytes) {
      while (prefixSize < prefix.length) {
        const chunk = await readInputChunk();
        if (!chunk) break;
        pending.push(chunk);
        const count = Math.min(chunk.length, prefix.length - prefixSize);
        prefix.set(chunk.subarray(0, count), prefixSize);
        prefixSize += count;
        if (
          prefixSize >= 4 &&
          new TextDecoder().decode(prefix.subarray(0, prefixSize)).trim()
        )
          break;
      }
      const sniffed = prefix.subarray(0, prefixSize);
      if (isSogPrefix(sniffed) || isRadPrefix(sniffed)) {
        const crossOrigin =
          url &&
          responseUrl &&
          new URL(url).origin !== new URL(responseUrl).origin;
        const streamingArgs = {
          expectedSogCount: args.expectedSogCount,
          readChunk: async () => pending.shift() ?? readInputChunk(),
          baseUrl: getAssetBaseUrl(responseUrl) ?? baseUrl,
          requestHeader: crossOrigin ? undefined : requestHeader,
          withCredentials: !crossOrigin && withCredentials,
          sendStatus,
          resolveAsset,
          resolveFile: args.resolveFile,
          signal: args.signal,
        };
        return isRadPrefix(sniffed)
          ? await loadRad(streamingArgs)
          : await loadSog(streamingArgs);
      }
    }
    args.signal?.throwIfAborted();
    const activeDecoder = wasmCall(() =>
      decode_to_splats(fileType, pathName ?? url),
    );
    decoder = activeDecoder;
    if (expectedInputLength > 0) {
      wasmCall(() =>
        activeDecoder.set_expected_input_size(expectedInputLength),
      );
    }
    while (true) {
      const value = pending.shift() ?? (await readInputChunk());
      if (!value) break;
      loaded += value.length;
      if (expectedInputLength > 0 && loaded > expectedInputLength) {
        throw new Error(
          `Input length exceeds the expected ${expectedInputLength} bytes`,
        );
      }
      sendStatus({ loaded, total: streamLength });
      wasmCall(() => activeDecoder.push(value));
    }
    if (expectedInputLength > 0 && loaded !== expectedInputLength) {
      throw new Error(
        `Input length mismatch: expected ${expectedInputLength} bytes, received ${loaded}`,
      );
    }
    if (streamLength === 0) {
      sendStatus({ loaded, total: loaded });
    }
    const complete = decoder;
    decoder = undefined;
    return wasmCall(() => complete.finish());
  } catch (error) {
    await streamReader?.cancel(error).catch(() => {});
    throw error;
  } finally {
    wasmFree(decoder);
    streamReader?.releaseLock();
  }
}
/** Decode in source order so streamed SOG can extract file ranges first. */
export async function decodeSplats(args, { sendStatus }) {
  const decoded = await decodeInput({
    ...args,
    sendStatus,
    resolveAsset: (url) => {
      const requestId = ++assetRequestId;
      return abortable(
        new Promise((resolve) => {
          assetRequests.set(requestId, resolve);
          sendStatus({ assetRequest: requestId, url });
        }),
        args.signal,
      ).finally(() => assetRequests.delete(requestId));
    },
    resolveFile: args.hasFileResolver
      ? (filename, signal) => {
          const requestId = ++assetRequestId;
          return abortable(
            new Promise((resolve) => {
              fileRequests.set(requestId, resolve);
              sendStatus({ fileRequest: requestId, filename });
            }),
            signal,
          ).finally(() => fileRequests.delete(requestId));
        }
      : undefined,
  });
  if (args.postDecode)
    applySplatPostDecode(
      decoded,
      args.postDecode,
      createStageProgress(
        args.reportProcessingProgress ? sendStatus : undefined,
        "postDecode",
      ),
    );
  return {
    numSplats: decoded.numSplats,
    splatArrays: [decoded.splat0, decoded.splat1],
    sortCenters: decoded.sortCenters,
    sourceIds: decoded.sourceIds,
    extra: {
      sh1: decoded.sh1,
      sh2: decoded.sh2,
      sh3a: decoded.sh3a,
      sh3b: decoded.sh3b,
    },
  };
}
export async function loadSplats(args, options) {
  const data = await decodeSplats(args, options);
  reorderSplats(
    data,
    undefined,
    createStageProgress(
      args.reportProcessingProgress ? options.sendStatus : undefined,
      "optimize",
    ),
  );
  return data;
}
let assetRequestId = 0;
const assetRequests = new Map();
const fileRequests = new Map();
export function resolveFile({ requestId, input }) {
  fileRequests.get(requestId)?.(input);
}
export function resolveAsset({ requestId, url }) {
  assetRequests.get(requestId)?.(url);
}
