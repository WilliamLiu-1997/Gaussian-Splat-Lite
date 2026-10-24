import * as wasm from "gaussian-splat-rs";
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
  const limits = args.decoderLimits;
  if (limits && !Reflect.get(wasm, "decoder_budget_supported")?.())
    throw new Error(
      "WASM decoder lacks budget guards; rebuild WASM before bounded scene decoding",
    );
  if (limits)
    wasmCall(() =>
      Reflect.get(wasm, "set_decoder_memory_limit")(limits.maxWasmBytes),
    );
  const inputSize = fileBytes?.byteLength ?? file?.size;
  if (limits && inputSize !== undefined && inputSize > limits.maxInputBytes)
    throw new Error("Input exceeds decoder maxInputBytes");
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
      decode_to_splats(
        fileType,
        pathName ?? url,
        limits?.maxPoints,
        limits?.maxDecoderBytes,
        limits?.maxWasmBytes,
        args.maxSh,
      ),
