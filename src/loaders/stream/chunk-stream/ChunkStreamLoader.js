import { DefaultLoadingManager } from "three";
import { ShPalette } from "../../../data/shPalette.js";
import { WorkerTerminatedError } from "../../../runtime/WorkerRpc.js";
import { abortable, linkedAbortController } from "../../../runtime/abort.js";
import { getAssetBaseUrl } from "../../assetUrl.js";
import { joinBytes, readResponse, requestOptions } from "../../source.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { ChunkStreamWorker } from "./ChunkStreamWorker.js";
/** A retained worker cache; extraction transfers owned packed arrays to the caller. */
export class ChunkSource {
  constructor(worker, id, info, onRelease) {
    this.worker = worker;
    this.id = id;
    this.info = info;
    this.palette = info.shPalette
      ? new ShPalette(info.shPalette, info.shDegree)
      : undefined;
    info.shPalette = undefined;
    this.onRelease = onRelease;
    this.released = false;
  }
  get alive() {
    return !this.released && !this.worker.disposed;
  }
  async extract(ranges) {
    if (!this.alive)
      throw new WorkerTerminatedError("Streaming chunk is no longer cached");
    return this.worker.call("extractRegions", { id: this.id, ranges });
  }
  dispose() {
    if (this.released) return;
    this.released = true;
    if (!this.worker.disposed)
      void this.worker.call("releaseChunk", { id: this.id }).catch(() => {});
    this.onRelease();
  }
}
/** Dedicated LOD worker, bounded decoders and retained chunk cache handles. */
export class ChunkStreamLoader {
  constructor(
    maxConcurrentLoads,
    maxSh,
    onChange,
    format = "sog",
    blindData = true,
  ) {
    this.format = format;
    this.maxSh = maxSh;
    this.blindData = blindData;
    this.controller = new AbortController();
    this.sources = new Map();
    this.downloadedBytes = 0;
    this.retainedIndexBytes = 0;
    this.pool = new StreamWorkerPool(
      () => new ChunkStreamWorker(() => queueMicrotask(onChange)),
      maxConcurrentLoads,
    );
    this.lodWorker = new ChunkStreamWorker(() => queueMicrotask(onChange));
  }
  get stats() {
    return {
      downloadedBytes: this.downloadedBytes + this.pool.downloadedBytes,
      peakWasmMemoryBytes:
        this.pool.peakWasmMemoryBytes + this.lodWorker.peakWasmMemoryBytes,
      retainedIndexBytes: this.lodWorker.disposed ? 0 : this.retainedIndexBytes,
    };
  }
  assertActive() {
    this.controller.signal.throwIfAborted();
    if (this.lodWorker.disposed) throw new Error("Chunk LOD worker terminated");
  }
  async addSource(id, options, signal) {
    this.assertActive();
    const input = { options: { ...options }, baseUrl: "", indexBytes: 0 };
    this.sources.set(id, input);
    const request = linkedAbortController(this.controller.signal, signal);
    try {
      const index = await abortable(
        this.readIndex(id, input, request.signal),
        request.signal,
      );
      request.signal.throwIfAborted();
      input.indexBytes = index.retainedIndexBytes;
      this.retainedIndexBytes += input.indexBytes;
      return index;
    } catch (error) {
      this.removeSource(id);
      throw error;
    } finally {
      request.cleanup();
    }
  }
  removeSource(id) {
    const input = this.sources.get(id);
    if (!input) return;
    this.sources.delete(id);
    this.retainedIndexBytes -= input.indexBytes;
    if (!this.lodWorker.disposed)
      void this.lodWorker.call("releaseIndex", { id }).catch(() => {});
  }
  async readIndex(id, input, signal) {
    const { options } = input;
    signal.throwIfAborted();
    const manager = options.manager ?? DefaultLoadingManager;
    const resolveBase =
      typeof document === "undefined" ? undefined : document.baseURI;
    const url = new URL(manager.resolveURL(options.url), resolveBase).href;
    const resourceUrl = new URL(options.url, resolveBase ?? url).href;
    input.baseUrl = getAssetBaseUrl(url) ?? resourceUrl;
    manager.itemStart(url);
    try {
      const response = await fetch(url, {
        ...requestOptions(options, url, resourceUrl),
        signal,
      });
      const { chunks, size } = await readResponse(
        response,
        Number.POSITIVE_INFINITY,
        (bytes) => {
          this.downloadedBytes += bytes;
        },
        signal,
      );
      signal.throwIfAborted();
      const bytes = new Uint8Array(joinBytes(chunks, size)).buffer;
      const index = await this.lodWorker.call("parseIndex", {
        id,
        bytes,
        baseUrl: getAssetBaseUrl(response.url || url) ?? resourceUrl,
        format: this.format,
      });
      this.assertActive();
      signal.throwIfAborted();
      return index;
    } catch (error) {
      manager.itemError(url);
      throw error;
    } finally {
      manager.itemEnd(url);
    }
  }
  async selectLod(request) {
    this.assertActive();
    return this.lodWorker.call("selectLod", {
      ...request,
      format: this.format,
    });
  }
  async load(sourceId, url, count, signal) {
    this.assertActive();
    const { options, baseUrl } = this.sources.get(sourceId);
    const manager = options.manager ?? DefaultLoadingManager;
    return this.pool.run(
      {
        signal,
        manager,
        cancel: (worker, id) => worker.call("releaseChunk", { id }),
      },
      async ({ worker, id, signal, retain, start, progress }) => {
        this.assertActive();
        let info;
        if (options.loadChunk) {
          const custom = await options.loadChunk(url, signal);
          try {
            signal.throwIfAborted();
            info = await worker.call("cacheChunk", {
              id,
              data: custom.takeData(),
              maxSh: this.maxSh,
              blindData: this.blindData,
            });
          } finally {
            custom.dispose();
          }
        } else {
          const resolveBase =
            typeof document === "undefined" ? baseUrl : document.baseURI;
          const resourceUrl = new URL(url, resolveBase).href;
          const resolved = new URL(manager.resolveURL(url), resolveBase).href;
          start(resolved);
          const sameOrigin =
            new URL(getAssetBaseUrl(resolved) ?? resourceUrl).origin ===
            new URL(baseUrl).origin;
          info = await worker.call(
            "loadChunk",
            {
              id,
              url: resolved,
              baseUrl: resourceUrl,
              fileType:
                this.format === "sog"
                  ? "sog"
                  : new URL(resourceUrl).pathname
                      .split(".")
                      .pop()
                      .toLowerCase(),
              maxSh: this.maxSh,
              blindData: this.blindData,
              requestHeader: sameOrigin ? options.requestHeader : undefined,
              withCredentials: sameOrigin && options.withCredentials,
              expectedSogCount:
                this.format === "sog" && count >= 0 ? count : undefined,
            },
            {
              onStatus: (data) => {
                const status = data;
                if ("assetRequest" in status)
                  return worker.call("resolveAsset", {
                    requestId: status.assetRequest,
                    url: new URL(manager.resolveURL(status.url), resolveBase)
                      .href,
                  });
                if ("loaded" in status) progress(status.loaded);
              },
            },
          );
        }
        signal.throwIfAborted();
        this.assertActive();
        return new ChunkSource(worker, id, info, retain());
      },
    );
  }
  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort(
      new DOMException("Chunk loader disposed", "AbortError"),
    );
    this.pool.dispose(this.controller.signal.reason);
    this.lodWorker.dispose(this.controller.signal.reason);
    this.sources.clear();
    this.retainedIndexBytes = 0;
  }
}
