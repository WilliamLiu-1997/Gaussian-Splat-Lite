import { SogDecodeSession, decode_sog_meta } from "gaussian-splat-rs";
import { getAssetBaseUrl } from "./assetUrl";
import type { PostDecodeSplatData } from "./postDecodeRuntime";

type LoadArgs = {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array;
  readChunk?: () => Promise<Uint8Array | undefined>;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  baseUrl?: string;
  sendStatus: (status: { loaded: number; total: number }) => void;
  resolveAsset?: (url: string) => Promise<string>;
  expectedSogCount?: number;
  signal?: AbortSignal;
};

type Segment = { offset: number; bytes: Uint8Array };
type Source = {
  size: number;
  url?: string;
  read(offset: number, length: number, retain?: boolean): Promise<Uint8Array>;
};
type Entry = {
  name: string;
  nameLength: number;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
};

const MiB = 1024 * 1024;
const DIRECTORY_LIMIT = 16 * MiB;
const READ_CHUNK = 16 * MiB;
const utf8 = new TextDecoder("utf-8", { fatal: true });
// ZIP's original filename encoding, used when the UTF-8 flag is absent.
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function fail(message: string): never {
  throw new Error(`SOG: ${message}`);
}

function dataView(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function checkRange(offset: number, length: number, size: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > size
  ) {
    fail("archive range is out of bounds");
  }
}

function join(chunks: Uint8Array[], length: number) {
  if (chunks.length === 1 && chunks[0].byteLength === length) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function segmentedSource(chunks: Uint8Array[], url?: string): Source {
  let size = 0;
  const segments = chunks.map((bytes) => {
    const segment = { offset: size, bytes };
    size += bytes.byteLength;
    return segment;
  });
  return rangeSource(size, undefined, url, segments);
}

function rangeSource(
  size: number,
  readRange?: (offset: number, length: number) => Promise<Uint8Array>,
  url?: string,
  cache: Segment[] = [],
): Source {
  return {
    size,
    url,
    async read(offset, length, retain = false) {
      checkRange(offset, length, size);
      if (!length) return new Uint8Array();
      const end = offset + length;
      let cursor = offset;
      const chunks: Uint8Array[] = [];
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

async function collect(
  read: () => Promise<Uint8Array | undefined>,
  maxBytes: number,
  progress: (bytes: number) => void,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const bytes = await read();
    if (bytes === undefined) break;
    if (size + bytes.byteLength > maxBytes)
      fail("response exceeds expected length");
    if (bytes.byteLength) chunks.push(bytes);
    size += bytes.byteLength;
    progress(bytes.byteLength);
  }
  return { chunks, size };
}

async function readResponse(
  response: Response,
  maxBytes: number,
  progress: (bytes: number) => void,
) {
  if (!response.ok) fail(`HTTP ${response.status} loading ${response.url}`);
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) fail("response exceeds expected length");
    progress(bytes.byteLength);
    return { chunks: [bytes], size: bytes.byteLength };
  }
  try {
    return await collect(
      async () => {
        const { done, value } = await reader.read();
        return done ? undefined : value;
      },
      maxBytes,
      progress,
    );
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function requestOptions(
  args: LoadArgs,
  url: string,
  base?: string,
): RequestInit & { headers: Headers } {
  const sameOrigin = !base || new URL(url).origin === new URL(base).origin;
  const headers = new Headers(sameOrigin ? args.requestHeader : undefined);
  headers.delete("Range");
  headers.delete("If-Range");
  return {
    headers,
    credentials: sameOrigin && args.withCredentials ? "include" : "same-origin",
  };
}

async function openSource(
  args: LoadArgs,
  progress: (bytes: number, total?: number) => void,
  signal: AbortSignal,
): Promise<Source> {
  if (args.file) {
    const file = args.file;
    progress(0, file.size);
    return rangeSource(file.size, async (offset, length) => {
      const bytes = new Uint8Array(
        await file.slice(offset, offset + length).arrayBuffer(),
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
  const buffered = async (response: Response) => {
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
    );
    return segmentedSource(data.chunks, response.url || initialUrl);
  };
  if (first.status === 200) return buffered(first);
  const parseRange = (
    response: Response,
    start: number,
    requestedEnd: number,
    total?: number,
  ) => {
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
  let size: number | undefined;
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
  const firstData = await readResponse(first, Math.min(4096, size), progress);
  if (firstData.size !== Math.min(4096, size)) fail("truncated range response");
  const cache: Segment[] = [
    {
      offset: 0,
      bytes: join(firstData.chunks, firstData.size),
    },
  ];
  const etag = first.headers.get("ETag");
  const modified = first.headers.get("Last-Modified");
  const validator = etag && !etag.startsWith("W/") ? etag : modified;
  const archiveSize = size;
  return rangeSource(
    archiveSize,
    async (offset, length) => {
      const end = offset + length - 1;
      const options = requestOptions(args, responseUrl, initialUrl);
      options.headers.set("Range", `bytes=${offset}-${end}`);
      if (
        validator &&
        typeof location !== "undefined" &&
        new URL(responseUrl).origin === location.origin
      )
        options.headers.set("If-Range", validator);
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
      const data = await readResponse(response, length, progress);
      return join(data.chunks, data.size);
    },
    responseUrl,
    cache,
  );
}

function filename(bytes: Uint8Array, flags: number) {
  if (flags & 0x800) return utf8.decode(bytes);
  return Array.from(bytes, (byte) =>
    byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128],
  ).join("");
}

function pathName(name: string) {
  if (
    !name ||
    /[\0\\]/.test(name) ||
    name.startsWith("/") ||
    /^[a-z]+:/i.test(name)
  ) {
    fail(`invalid archive path ${name}`);
  }
  const parts: string[] = [];
  for (const part of name.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) fail(`archive path escapes its root: ${name}`);
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

async function readZip(source: Source) {
  if (source.size < 22) fail("truncated ZIP archive");
  const tailOffset = Math.max(0, source.size - 65557);
  const tail = await source.read(tailOffset, source.size - tailOffset, true);
  const view = dataView(tail);
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === tail.byteLength
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) fail("ZIP end-of-directory record is missing");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count
  )
    fail("multi-disk ZIP archives are unsupported");
  if (
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50)
  )
    fail("ZIP64 archives are unsupported");
  if (size > DIRECTORY_LIMIT || offset + size !== tailOffset + end)
    fail("invalid or oversized ZIP directory");
  const bytes = await source.read(offset, size, true);
  const directory = dataView(bytes);
  const entries = new Map<string, Entry>();
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > size || directory.getUint32(cursor, true) !== 0x02014b50)
      fail("invalid ZIP directory entry");
    const flags = directory.getUint16(cursor + 8, true);
    const method = directory.getUint16(cursor + 10, true);
    const nameLength = directory.getUint16(cursor + 28, true);
    const extraLength = directory.getUint16(cursor + 30, true);
    const commentLength = directory.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > size) fail("truncated ZIP directory entry");
    if (flags & 0x41) fail("encrypted ZIP entries are unsupported");
    if (method !== 0 && method !== 8)
      fail(`unsupported ZIP compression method ${method}`);
    if (directory.getUint16(cursor + 34, true))
      fail("multi-disk ZIP entries are unsupported");
    const name = filename(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      flags,
    );
    const entry: Entry = {
      name,
      nameLength,
      flags,
      method,
      crc: directory.getUint32(cursor + 16, true),
      compressedSize: directory.getUint32(cursor + 20, true),
      size: directory.getUint32(cursor + 24, true),
      offset: directory.getUint32(cursor + 42, true),
    };
    if ([entry.compressedSize, entry.size, entry.offset].includes(0xffffffff))
      fail("ZIP64 entries are unsupported");
    const extraEnd = next - commentLength;
    for (let extra = extraEnd - extraLength; extra < extraEnd; ) {
      if (extra + 4 > extraEnd) fail("truncated ZIP extra field");
      const tag = directory.getUint16(extra, true);
      const length = directory.getUint16(extra + 2, true);
      if (tag === 1) fail("ZIP64 entries are unsupported");
      extra += 4 + length;
      if (extra > extraEnd) fail("truncated ZIP extra field");
    }
    const key = pathName(name);
    if (entries.has(key)) fail(`duplicate ZIP path ${key}`);
    if (!name.endsWith("/")) entries.set(key, entry);
    cursor = next;
  }
  if (cursor !== size) fail("ZIP directory size mismatch");
  const rootMeta = entries.get("meta.json");
  const candidates = [...entries.keys()].filter(
    (name) => name.split("/").pop() === "meta.json",
  );
  if (!rootMeta && candidates.length !== 1)
    fail("ZIP must contain one unambiguous meta.json");
  const metaName = rootMeta ? "meta.json" : candidates[0];
  const meta = entries.get(metaName);
  if (!meta) fail("ZIP metadata is missing");
  const prefix = metaName.slice(0, metaName.length - "meta.json".length);
  const read = async (entry: Entry) => {
    if (entry.offset + 30 + entry.nameLength > offset)
      fail(`invalid local header for ${entry.name}`);
    // Fetch the local header and the first payload chunk together.
    const header = await source.read(
      entry.offset,
      Math.min(READ_CHUNK, 30 + entry.nameLength + entry.compressedSize),
    );
    const local = dataView(header);
    if (
      local.getUint32(0, true) !== 0x04034b50 ||
      local.getUint16(6, true) !== entry.flags ||
      local.getUint16(8, true) !== entry.method
    ) {
      fail(`local header disagrees with directory for ${entry.name}`);
    }
    const nameLength = local.getUint16(26, true);
    const extraLength = local.getUint16(28, true);
    if (nameLength !== entry.nameLength)
      fail("ZIP local filename length mismatch");
    const start = entry.offset + 30 + nameLength + extraLength;
    if (start + entry.compressedSize > offset)
      fail(`truncated payload for ${entry.name}`);
    const localName = header.subarray(30, 30 + nameLength);
    if (filename(localName, entry.flags) !== entry.name)
      fail("ZIP local filename mismatch");
    if (
      !(entry.flags & 8) &&
      (local.getUint32(14, true) !== entry.crc ||
        local.getUint32(18, true) !== entry.compressedSize ||
        local.getUint32(22, true) !== entry.size)
    )
      fail(`local payload size or CRC mismatch for ${entry.name}`);
    const first = header.subarray(start - entry.offset);
    const chunks = first.length ? [first] : [];
    for (
      let cursor = first.length;
      cursor < entry.compressedSize;
      cursor += READ_CHUNK
    ) {
      chunks.push(
        await source.read(
          start + cursor,
          Math.min(READ_CHUNK, entry.compressedSize - cursor),
        ),
      );
    }
    return chunks;
  };
  return {
    meta,
    read,
    entry(name: string) {
      if (name.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(name))
        return undefined;
      for (const path of [prefix + name, name]) {
        try {
          const entry = entries.get(pathName(path));
          if (entry) return entry;
        } catch {
          // A reference outside the archive is resolved as an external URL.
        }
      }
      return undefined;
    },
  };
}

function isJson(bytes: Uint8Array) {
  let index =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (index < bytes.length && [9, 10, 13, 32].includes(bytes[index]))
    index++;
  return bytes[index] === 123;
}

export function isSogPrefix(bytes: Uint8Array) {
  return (
    (bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 3 &&
      bytes[3] === 4) ||
    isJson(bytes.subarray(0, 4096))
  );
}

/** @internal Loads SOG with range reads and grouped property decoding. */
export async function loadSog(args: LoadArgs): Promise<PostDecodeSplatData> {
  const controller = new AbortController();
  const abort = () => controller.abort(args.signal?.reason);
  args.signal?.addEventListener("abort", abort, { once: true });
  try {
    args.signal?.throwIfAborted();
    return await decodeSog(args, controller);
  } finally {
    args.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

async function decodeSog(args: LoadArgs, controller: AbortController) {
  let loaded = 0;
  let total = 0;
  let lastProgress = 0;
  const progress = (bytes: number, expectedTotal?: number) => {
    loaded += bytes;
    if (expectedTotal !== undefined) total = expectedTotal;
    // A server can hide Content-Encoding, making Content-Length an underestimate.
    if (loaded > total) total = 0;
    const now = performance.now();
    if (expectedTotal !== undefined || now - lastProgress >= 50) {
      args.sendStatus({ loaded, total });
      lastProgress = now;
    }
  };
  const source = await openSource(args, progress, controller.signal);
  const prefix = await source.read(0, Math.min(source.size, 4096), true);
  if (!isSogPrefix(prefix))
    fail("input is neither a ZIP archive nor SOG metadata");
  const zip = isJson(prefix) ? undefined : await readZip(source);
  const metadata = decode_sog_meta(
    zip
      ? join(await zip.read(zip.meta), zip.meta.compressedSize)
      : await source.read(0, source.size),
    zip?.meta.method ?? 0,
    zip?.meta.size ?? source.size,
    zip?.meta.crc ?? -1,
  );
  if (args.expectedSogCount !== undefined) {
    const meta = JSON.parse(metadata.replace(/^\uFEFF+/, ""));
    const count = meta.version === 2 ? meta.count : meta.means?.shape?.[0];
    if (count !== args.expectedSogCount)
      fail(
        `chunk count mismatch: expected ${args.expectedSogCount}, received ${count}`,
      );
  }
  controller.signal.throwIfAborted();
  const session = new SogDecodeSession(metadata);
  let consumed = false;
  try {
    const groups = JSON.parse(session.plan()) as string[][];
    // Metadata and bundles with external assets do not describe the total input size.
    if (!zip || groups.some((group) => group.some((name) => !zip.entry(name))))
      progress(0, 0);
    const directoryBase = getAssetBaseUrl(source.url) ?? args.baseUrl;
    const requestBase = getAssetBaseUrl(args.url) ?? directoryBase;
    const downloadAsset = async (name: string) => {
      controller.signal.throwIfAborted();
      const entry = zip?.entry(name);
      let chunks: Uint8Array[];
      if (zip && entry) {
        chunks = await zip.read(entry);
      } else {
        const initialUrl = new URL(name, directoryBase).href;
        const url = (await args.resolveAsset?.(initialUrl)) ?? initialUrl;
        const response = await fetch(url, {
          ...requestOptions(args, url, requestBase),
          signal: controller.signal,
        });
        chunks = (
          await readResponse(response, Number.POSITIVE_INFINITY, progress)
        ).chunks;
      }
      return { entry, chunks };
    };
    // Start all property downloads: five images, plus two with higher-order SH.
    const downloads = groups.map((names) =>
      names.map((name) => {
        const task = downloadAsset(name);
        // Observe background errors immediately and cancel their sibling requests.
        void task.catch((error) => controller.abort(error));
        return task;
      }),
    );
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      try {
        const assets = await Promise.all(downloads[index]);
        downloads[index] = []; // Do not retain decoded groups through settled promises.
        const hasNextGroup = index + 1 < groups.length;
        for (const { entry, chunks } of assets) {
          // Let other downloads advance before synchronous image decoding.
          if (hasNextGroup)
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          controller.signal.throwIfAborted();
          session.decode_asset(
            chunks,
            entry?.method ?? 0,
            entry?.size ?? 0,
            entry?.crc ?? -1,
          );
        }
        let lastYield = performance.now();
        while (!session.decode_batch()) {
          if (
            (hasNextGroup || args.signal) &&
            performance.now() - lastYield >= 16
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            lastYield = performance.now();
          }
          controller.signal.throwIfAborted();
        }
      } catch (error) {
        controller.signal.throwIfAborted();
        fail(
          `${group.join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    controller.signal.throwIfAborted();
    consumed = true;
    const result = session.finish() as PostDecodeSplatData;
    progress(0, loaded);
    return result;
  } finally {
    controller.abort();
    if (!consumed) session.free();
  }
}
