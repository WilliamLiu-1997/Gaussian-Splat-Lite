import { type ChunkDecoder, decode_to_splats } from "gaussian-splat-rs";
import type { SplatResult } from "../data/defines";
import { abortable } from "../runtime/abort";
import { getAssetBaseUrl } from "./assetUrl";
import type { SplatLoadArgs, SplatLoadStatus } from "./loadTypes";
import {
  type PostDecodeSplatData,
  applySplatPostDecode,
} from "./postDecodeRuntime";
import { isSogPrefix, loadSog } from "./sog";

type DecodeArgs = SplatLoadArgs & {
  sendStatus: (data: SplatLoadStatus) => void;
  resolveAsset: (url: string) => Promise<string>;
};

async function decodeInput(args: DecodeArgs) {
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
    });

    const response = await fetch(request);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to fetch "${url}": ${response.status} ${response.statusText}`,
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
  let decoder: ChunkDecoder | undefined;
  try {
    // Keep the sniffed prefix for either decoder, including tiny stream chunks.
    const pending: Uint8Array[] = [];
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
      if (isSogPrefix(prefix.subarray(0, prefixSize))) {
        const crossOrigin =
          url &&
          responseUrl &&
          new URL(url).origin !== new URL(responseUrl).origin;
        return await loadSog({
          expectedSogCount: args.expectedSogCount,
          readChunk: async () => pending.shift() ?? readInputChunk(),
          baseUrl: getAssetBaseUrl(responseUrl) ?? baseUrl,
          requestHeader: crossOrigin ? undefined : requestHeader,
          withCredentials: !crossOrigin && withCredentials,
          sendStatus,
          resolveAsset,
        });
      }
    }
    decoder = decode_to_splats(fileType, pathName ?? url);
    if (expectedInputLength > 0) {
      decoder.set_expected_input_size(expectedInputLength);
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
      decoder.push(value);
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
    return complete.finish();
  } catch (error) {
    try {
      await streamReader?.cancel(error);
    } catch {
      // Preserve the decoding error if stream cancellation itself fails.
    }
    throw error;
  } finally {
    decoder?.free();
    streamReader?.releaseLock();
  }
}

export async function loadSplats(
  args: SplatLoadArgs,
  { sendStatus }: { sendStatus: (data: SplatLoadStatus) => void },
): Promise<SplatResult> {
  const decoded = (await decodeInput({
    ...args,
    sendStatus,
    resolveAsset: (url) => {
      const requestId = ++assetRequestId;
      return abortable(
        new Promise<string>((resolve) => {
          assetRequests.set(requestId, resolve);
          sendStatus({ assetRequest: requestId, url });
        }),
        args.signal,
      ).finally(() => assetRequests.delete(requestId));
    },
  })) as PostDecodeSplatData;
  if (args.postDecode) applySplatPostDecode(decoded, args.postDecode);
  return {
    numSplats: decoded.numSplats,
    splatArrays: [decoded.splat0, decoded.splat1],
    sortCenters: decoded.sortCenters,
    extra: {
      sh1: decoded.sh1,
      sh2: decoded.sh2,
      sh3a: decoded.sh3a,
      sh3b: decoded.sh3b,
    },
  };
}

let assetRequestId = 0;
const assetRequests = new Map<number, (url: string) => void>();

export function resolveAsset({
  requestId,
  url,
}: { requestId: number; url: string }) {
  assetRequests.get(requestId)?.(url);
  assetRequests.delete(requestId);
}
