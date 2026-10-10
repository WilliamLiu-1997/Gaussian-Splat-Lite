import { abortable } from "../../runtime/abort.js";
import { getAssetBaseUrl } from "../assetUrl.js";
import {
  checkRange,
  collectBytes as collect,
  joinBytes as join,
  readResponse,
  requestOptions,
} from "../source.js";
function fail(message) {
  throw new Error(`SOG: ${message}`);
}
function segmentedSource(chunks, url) {
  let size = 0;
  const segments = chunks.map((bytes) => {
    const segment = { offset: size, bytes };
    size += bytes.byteLength;
    return segment;
  });
  return rangeSource(size, undefined, url, segments);
}
function rangeSource(size, readRange, url, cache = []) {
  return {
    size,
    url,
    async read(offset, length, retain = false) {
      checkRange(offset, length, size);
      if (!length) return new Uint8Array();
      const end = offset + length;
      let cursor = offset;
      const chunks = [];
      // Cached ranges are sorted and disjoint, including fully buffered input.
      let index = 0;
      let high = cache.length;
      while (index < high) {
        const mid = (index + high) >>> 1;
        const segment = cache[mid];
        if (segment.offset + segment.bytes.byteLength <= offset)
          index = mid + 1;
        else high = mid;
      }
      while (cursor < end) {
        const cached = cache[index];
        if (cached && cached.offset <= cursor) {
          const stop = Math.min(end, cached.offset + cached.bytes.byteLength);
          chunks.push(
            cached.bytes.subarray(cursor - cached.offset, stop - cached.offset),
          );
          cursor = stop;
          index++;
          continue;
        }
        if (!readRange) fail("truncated buffered input");
        const next = Math.min(end, cached?.offset ?? end);
        const bytes = await readRange(cursor, next - cursor);
        if (bytes.byteLength !== next - cursor) fail("truncated input range");
        if (retain) cache.splice(index++, 0, { offset: cursor, bytes });
        chunks.push(bytes);
        cursor = next;
      }
      return join(chunks, length);
    },
  };
}
export async function openSogSource(args, progress, signal) {
  if (args.file) {
    const file = args.file;
    progress(0, file.size);
    return rangeSource(file.size, async (offset, length) => {
      const bytes = new Uint8Array(
        await abortable(
          file.slice(offset, offset + length).arrayBuffer(),
          signal,
        ),
      );
      progress(bytes.byteLength);
      return bytes;
    });
  }
  if (args.fileBytes) {
    progress(args.fileBytes.byteLength);
    return segmentedSource([args.fileBytes]);
  }
  if (args.readChunk) {
    const buffered = await collect(
      args.readChunk,
      Number.POSITIVE_INFINITY,
      progress,
      signal,
    );
    return segmentedSource(buffered.chunks);
  }
  if (!args.url) fail("no input source");
  const initialUrl = args.url;
  const options = requestOptions(args, initialUrl);
  options.headers.set("Range", "bytes=0-4095");
  const first = await fetch(initialUrl, {
    ...options,
    signal,
  });
  const responseUrl = first.url || initialUrl;
  if (!first.ok) {
    await first.body?.cancel();
    fail(`HTTP ${first.status} loading ${responseUrl}`);
  }
  const buffered = async (response) => {
    const size = Number(response.headers.get("Content-Length"));
    const encoding = response.headers.get("Content-Encoding");
    progress(
      0,
      Number.isSafeInteger(size) &&
        size > 0 &&
        (!encoding || encoding.toLowerCase() === "identity")
        ? size
        : 0,
    );
    const data = await readResponse(
      response,
      Number.POSITIVE_INFINITY,
      progress,
      signal,
    );
    return segmentedSource(data.chunks, response.url || initialUrl);
  };
  if (first.status === 200) return buffered(first);
  const parseRange = (response, start, requestedEnd, total) => {
    const encoding = response.headers.get("Content-Encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      return undefined;
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get("Content-Range") ?? "",
    );
    if (response.status !== 206 || !match) return undefined;
    const [actualStart, actualEnd, size] = match.slice(1).map(Number);
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      actualStart !== start ||
      actualEnd !== Math.min(requestedEnd, size - 1) ||
      (total !== undefined && total !== size)
    )
      fail("invalid or changed Content-Range");
    return size;
  };
  let size;
  try {
    size = parseRange(first, 0, 4095);
  } catch (error) {
    await first.body?.cancel();
    throw error;
  }
  if (size === undefined) {
    await first.body?.cancel();
    return buffered(
      await fetch(initialUrl, { ...requestOptions(args, initialUrl), signal }),
    );
  }
  progress(0, size);
  const firstData = await readResponse(
    first,
    Math.min(4096, size),
    progress,
    signal,
  );
  if (firstData.size !== Math.min(4096, size)) fail("truncated range response");
  const cache = [
    {
      offset: 0,
      bytes: join(firstData.chunks, firstData.size),
    },
  ];
  const etag = first.headers.get("ETag");
  const modified = first.headers.get("Last-Modified");
  const archiveSize = size;
  return rangeSource(
    archiveSize,
    async (offset, length) => {
      const end = offset + length - 1;
      const options = requestOptions(args, responseUrl, initialUrl);
      options.headers.set("Range", `bytes=${offset}-${end}`);
      const response = await fetch(responseUrl, {
        ...options,
        signal,
      });
      try {
        if (
          parseRange(response, offset, end, archiveSize) === undefined ||
          (etag && response.headers.get("ETag") !== etag) ||
          (!etag &&
            modified &&
            response.headers.get("Last-Modified") !== modified) ||
          (response.url && response.url !== responseUrl)
        )
          fail("archive changed or its byte-range response is invalid");
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      const data = await readResponse(response, length, progress, signal);
      return join(data.chunks, data.size);
    },
    responseUrl,
    cache,
  );
}
/** Resolve and read an external property image; ZIP entries stay with the archive reader. */
export async function readSogAsset(name, args, sourceUrl, progress, signal) {
  signal.throwIfAborted();
  const directoryBase = getAssetBaseUrl(sourceUrl) ?? args.baseUrl;
  const requestBase = getAssetBaseUrl(args.url) ?? directoryBase;
  const input = args.resolveFile
    ? await abortable(Promise.resolve(args.resolveFile(name, signal)), signal)
    : name;
  signal.throwIfAborted();
  if (typeof input === "string") {
    const initialUrl = new URL(input, directoryBase).href;
    const url = args.resolveAsset
      ? await abortable(args.resolveAsset(initialUrl), signal)
      : initialUrl;
    signal.throwIfAborted();
    const response = await fetch(url, {
      ...requestOptions(args, url, requestBase),
      signal,
    });
    const { chunks } = await readResponse(
      response,
      Number.POSITIVE_INFINITY,
      progress,
      signal,
    );
    return chunks;
  }
  const bytes =
    input instanceof Blob
      ? new Uint8Array(await abortable(input.arrayBuffer(), signal))
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input;
  if (!(bytes instanceof Uint8Array))
    fail(`file resolver returned an unsupported input for ${name}`);
  signal.throwIfAborted();
  progress(bytes.byteLength);
  return [bytes];
}
