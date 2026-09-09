import type { LoadingManager } from "three";
import { abortable, linkedAbortController } from "../../runtime/abort";
import { getAssetBaseUrl } from "../assetUrl";
import type {
  SplatFileInput,
  SplatFileResolver,
  SplatRequestOptions,
} from "../loadTypes";
import { checkRange, joinBytes, readResponse, requestOptions } from "../source";
import {
  RAD_FULL_LOAD_LIMIT,
  type RadHeader,
  collectRadHeader,
  getRadHeaderSize,
} from "./radFormat";

export type RadSourceOptions = SplatRequestOptions & {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array | ArrayBuffer;
  baseUrl?: string;
  manager?: LoadingManager;
  resolveFile?: SplatFileResolver;
  /** Internal bridge for LoadingManager URL modifiers in a decode worker. */
  resolveAsset?: (url: string) => Promise<string>;
  onProgress?: (downloadedBytes: number) => void;
  /** Ordinary decoding validates its working set before buffering a full response. */
  validateHeader?: (bytes: Uint8Array) => void;
};

type Remote = {
  url: string;
  resolved?: string;
  responseUrl?: string;
  total?: number;
  validator?: string;
  validatorHeader?: "ETag" | "Last-Modified";
  full?: Blob;
};

const MAX_CHUNK_BYTES = 256 * 1024 * 1024;

function baseUrl() {
  return typeof document === "undefined" ? undefined : document.baseURI;
}

/** Validated byte reads shared by ordinary RAD loading and paged loading. */
export class RadSource {
  readonly stats = { downloadedBytes: 0, activeRequests: 0, cachedBytes: 0 };
  private readonly controller = new AbortController();
  private readonly remotes = new Map<string, Remote>();
  private readonly root: SplatFileInput;
  private readonly origin?: string;

  constructor(
    readonly options: RadSourceOptions,
    private readonly allowFullDownload = false,
  ) {
    const inputs = [options.url, options.file, options.fileBytes].filter(
      (input) => input !== undefined,
    );
    if (inputs.length !== 1)
      throw new Error("RAD: provide exactly one of url, file, or fileBytes");
    this.root = inputs[0];
    const initialUrl = options.url ?? options.baseUrl;
    if (initialUrl) this.origin = new URL(initialUrl, baseUrl()).origin;
  }

  get url() {
    if (typeof this.root !== "string") return this.options.baseUrl;
    return this.remotes.get(this.root)?.responseUrl ?? this.root;
  }

  async readHeader(signal?: AbortSignal) {
    const prefix = await this.read(this.root, 0, 8, signal);
    const { headerLength } = getRadHeaderSize(prefix);
    const tail = await this.read(this.root, 8, headerLength - 8, signal);
    const bytes = new Uint8Array(headerLength);
    bytes.set(prefix);
    bytes.set(tail, 8);
    return bytes;
  }

  async readChunk(header: RadHeader, index: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.controller.signal.throwIfAborted();
    const chunk = header.meta.chunks[index];
    if (!chunk) throw new Error(`RAD: missing chunk ${index}`);
    let input = this.root;
    let offset = header.chunksStart + chunk.offset;
    if (chunk.filename !== undefined) {
      offset = chunk.offset;
      if (this.options.resolveFile) {
        const controller = this.requestController(signal);
        try {
          input = await abortable(
            Promise.resolve(
              this.options.resolveFile(chunk.filename, controller.signal),
            ),
            controller.signal,
          );
        } finally {
          controller.cleanup();
        }
      } else {
        const sourceBase = getAssetBaseUrl(this.url) ?? this.options.baseUrl;
        if (!sourceBase)
          throw new Error(
            `RAD: external chunk "${chunk.filename}" requires resolveFile or baseUrl`,
          );
        input = new URL(chunk.filename, sourceBase).href;
      }
      if (typeof input === "string")
        input = new URL(
          input,
          getAssetBaseUrl(this.url) ?? this.options.baseUrl ?? baseUrl(),
        ).href;
    }
    return this.read(
      input,
      offset,
      chunk.bytes,
      signal,
      chunk.filename !== undefined && offset === 0,
    );
  }

  private requestController(signal?: AbortSignal) {
    return linkedAbortController(this.controller.signal, signal);
  }

  private async read(
    input: SplatFileInput,
    offset: number,
    length: number,
    signal?: AbortSignal,
    wholeFile = false,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    this.controller.signal.throwIfAborted();
    checkRange(offset, length);
    if (length > MAX_CHUNK_BYTES)
      throw new Error("RAD: encoded chunk exceeds 256 MiB");
    if (typeof input === "string") {
      let remote = this.remotes.get(input);
      if (!remote) {
        remote = { url: input };
        this.remotes.set(input, remote);
      }
      return this.readRemote(remote, offset, length, signal, wholeFile);
    }
    if (input instanceof Blob) {
      checkRange(offset, length, input.size);
      return new Uint8Array(
        await abortable(
          input.slice(offset, offset + length).arrayBuffer(),
          signal,
        ),
      );
    }
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array))
      throw new Error("RAD: chunk resolver returned an unsupported input");
    checkRange(offset, length, bytes.length);
    // Workers transfer buffers; never detach the caller's source bytes.
    return new Uint8Array(bytes.subarray(offset, offset + length));
  }

  private async readRemote(
    remote: Remote,
    offset: number,
    length: number,
    signal?: AbortSignal,
    wholeFile = false,
  ): Promise<Uint8Array> {
    checkRange(offset, length, remote.total);
    if (!length) return new Uint8Array();
    if (remote.full)
      return new Uint8Array(
        await abortable(
          remote.full.slice(offset, offset + length).arrayBuffer(),
          signal,
        ),
      );
    const controller = this.requestController(signal);
    const manager = this.options.manager;
    let started = false;
    let response: Response | undefined;
    try {
      remote.resolved ??= new URL(
        this.options.resolveAsset
          ? await abortable(
              this.options.resolveAsset(remote.url),
              controller.signal,
            )
          : (manager?.resolveURL(remote.url) ?? remote.url),
        this.options.baseUrl ?? baseUrl(),
      ).href;
      controller.signal.throwIfAborted();
      const options = requestOptions(
        this.options,
        remote.resolved,
        this.origin,
      );
      const { headers } = options;
      if (!wholeFile)
        headers.set("Range", `bytes=${offset}-${offset + length - 1}`);
      // A single byte range can be fetched without a CORS preflight. Adding
      // If-Range would require server opt-in even when Range itself works.
      // Compare response validators below to detect resource changes instead.
      manager?.itemStart(remote.resolved);
      started = true;
      this.stats.activeRequests++;
      response = await fetch(remote.resolved, {
        headers,
        credentials: options.credentials,
        signal: controller.signal,
      });
      remote.responseUrl = response.url || remote.resolved;
      const encoding = response.headers.get("Content-Encoding");
      if (
        encoding &&
        encoding.toLowerCase() !== "identity" &&
        (response.status === 206 || !this.allowFullDownload)
      )
        throw new Error(
          "RAD: byte-range resources must use identity Content-Encoding",
        );
      const etag = response.headers.get("ETag");
      const modified = response.headers.get("Last-Modified");
      const validatorHeader =
        etag && !etag.startsWith("W/")
          ? "ETag"
          : modified
            ? "Last-Modified"
            : undefined;
      const validator = validatorHeader
        ? (response.headers.get(validatorHeader) ?? undefined)
        : undefined;
      if (
        remote.validator &&
        response.headers.get(remote.validatorHeader ?? "ETag") !==
          remote.validator
      )
        throw new Error("RAD: resource version changed during loading");
      if (!remote.validator && validator) {
        remote.validator = validator;
        remote.validatorHeader = validatorHeader;
      }
      if (response.status === 206) {
        const contentRange = response.headers.get("Content-Range");
        // Some public storage hosts serve correct ranges but do not expose
        // Content-Range to browser JavaScript. In that case the bounded body
        // and RAD/RADC container checks still validate the returned data.
        if (contentRange !== null) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
          if (!range) throw new Error("RAD: invalid Content-Range header");
          const [start, end, total] = range.slice(1).map(Number);
          if (
            !Number.isSafeInteger(total) ||
            start !== offset ||
            end !== offset + length - 1 ||
            end >= total ||
            (remote.total !== undefined && remote.total !== total)
          )
            throw new Error(
              "RAD: Content-Range does not match the requested bytes",
            );
          remote.total = total;
        }
        const bytes = await this.readResponse(
          response,
          length,
          controller.signal,
        );
        if (bytes.length !== length)
          throw new Error("RAD: truncated range response");
        return bytes;
      }
      if (response.status !== 200)
        throw new Error(
          `RAD: HTTP ${response.status} loading ${remote.resolved}`,
        );
      if (
        this.allowFullDownload &&
        remote.url === this.root &&
        offset === 0 &&
        length === 8
      ) {
        const { chunks, size } = await readResponse(
          response,
          RAD_FULL_LOAD_LIMIT,
          (bytes) => this.progress(bytes),
          controller.signal,
          collectRadHeader((bytes) => this.options.validateHeader?.(bytes)),
        );
        const full = new Blob(chunks as BlobPart[]);
        remote.total = size;
        checkRange(offset, length, size);
        this.cacheFullResponse(remote, full);
        return new Uint8Array(await full.slice(0, 8).arrayBuffer());
      }
      const limit = wholeFile
        ? length
        : this.allowFullDownload
          ? MAX_CHUNK_BYTES
          : 0;
      if (!limit && offset === 0 && length === 8) {
        // A split dataset's .rad contains only its bounded header. Allow that
        // complete response even when its server cannot serve byte ranges.
        const bytes = await this.readHeaderOnlyResponse(
          response,
          controller.signal,
        );
        remote.total = bytes.length;
        this.cacheFullResponse(remote, bytes);
        return bytes.slice(0, 8);
      }
      if (!limit)
        throw new Error(
          "RAD: server ignored Range; streaming requires byte-range support",
        );
      if (remote.total !== undefined && remote.total > limit)
        throw new Error("RAD: full response exceeds its byte limit");
      const bytes = await this.readResponse(response, limit, controller.signal);
      if (wholeFile && bytes.length !== length)
        throw new Error(
          "RAD: external chunk length does not match its directory entry",
        );
      if (remote.total !== undefined && remote.total !== bytes.length)
        throw new Error("RAD: resource length changed during loading");
      remote.total = bytes.length;
      checkRange(offset, length, bytes.length);
      return bytes.slice(offset, offset + length);
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (started) manager?.itemError(remote.resolved ?? remote.url);
      throw error;
    } finally {
      controller.cleanup();
      if (started) {
        this.stats.activeRequests--;
        manager?.itemEnd(remote.resolved ?? remote.url);
      }
    }
  }

  private cacheFullResponse(remote: Remote, bytes: Uint8Array | Blob) {
    remote.full = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]);
    this.stats.cachedBytes = [...this.remotes.values()].reduce(
      (sum, entry) => sum + (entry.full?.size ?? 0),
      0,
    );
  }

  private async readHeaderOnlyResponse(
    response: Response,
    signal: AbortSignal,
  ) {
    const failure = () =>
      new Error(
        "RAD: server ignored Range for a monolithic file; streaming requires byte-range support",
      );
    const prefix = new Uint8Array(8);
    let headerLength: number | undefined;
    let jsonLength = 0;
    // The prefix establishes the byte limit before response chunks are retained.
    const bytes = await this.readResponse(
      response,
      Number.POSITIVE_INFINITY,
      signal,
      (chunk, size) => {
        const offset = size - chunk.length;
        if (offset < 8) prefix.set(chunk.subarray(0, 8 - offset), offset);
        if (size >= 8 && headerLength === undefined)
          ({ jsonLength, headerLength } = getRadHeaderSize(prefix));
        if (size > (headerLength ?? 8)) throw failure();
      },
    );
    if (bytes.length !== headerLength)
      throw new Error("RAD: truncated header-only response");
    const meta = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(8, 8 + jsonLength),
      ),
    ) as { chunks?: unknown };
    if (
      !Array.isArray(meta.chunks) ||
      !meta.chunks.every(
        (chunk) =>
          chunk &&
          typeof chunk.filename === "string" &&
          chunk.filename.length > 0,
      )
    )
      throw failure();
    return bytes;
  }

  private async readResponse(
    response: Response,
    limit: number,
    signal: AbortSignal,
    validateChunk?: (chunk: Uint8Array, size: number) => void,
  ) {
    const { chunks, size } = await readResponse(
      response,
      limit,
      (bytes) => this.progress(bytes),
      signal,
      validateChunk,
    );
    return joinBytes(chunks, size);
  }

  private progress(bytes: number) {
    this.stats.downloadedBytes += bytes;
    this.options.onProgress?.(this.stats.downloadedBytes);
  }

  dispose() {
    this.controller.abort(
      new DOMException("RAD source disposed", "AbortError"),
    );
    this.remotes.clear();
    this.stats.cachedBytes = 0;
  }
}
