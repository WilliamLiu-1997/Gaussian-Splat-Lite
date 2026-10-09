import { DefaultLoadingManager } from "three";
import { WorkerTerminatedError } from "../../../runtime/WorkerRpc.js";
import { abortable } from "../../../runtime/abort.js";
import { getAssetBaseUrl } from "../../assetUrl.js";
import { joinBytes, readResponse, requestOptions } from "../../source.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { SogStreamWorker } from "./SogStreamWorker.js";
/** A retained worker cache; extraction transfers owned packed arrays to the caller. */
export class SogChunkSource {
  constructor(worker, id, info, onRelease) {
    this.worker = worker;
    this.id = id;
    this.info = info;
    this.onRelease = onRelease;
    this.released = false;
  }
  get alive() {
    return !this.released && !this.worker.disposed;
  }
  async extract(ranges) {
    if (!this.alive)
      throw new WorkerTerminatedError("Streaming chunk is no longer cached");
    return this.worker.call("extractSogRegions", { id: this.id, ranges });
  }
  dispose() {
    if (this.released) return;
    this.released = true;
    if (!this.worker.disposed)
      void this.worker.call("releaseSogChunk", { id: this.id }).catch(() => {});
    this.onRelease();
  }
}
/** Dedicated LOD worker, bounded decoders and retained chunk cache handles. */
export class SogStreamLoader {
  constructor(options, maxConcurrentLoads, onChange) {
    this.options = options;
    this.controller = new AbortController();
    this.baseUrl = "";
    this.downloadedBytes = 0;
    this.retainedIndexBytes = 0;
    this.pool = new StreamWorkerPool(
      () => new SogStreamWorker(() => queueMicrotask(onChange)),
      maxConcurrentLoads,
    );
    this.lodWorker = new SogStreamWorker(() => queueMicrotask(onChange));
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
    if (this.lodWorker.disposed) throw new Error("SOG LOD worker terminated");
  }
  initialize(signal) {
    signal?.throwIfAborted();
    this.assertActive();
    this.initialization ??= this.readIndex().catch((error) => {
      this.dispose();
      throw error;
    });
    return abortable(this.initialization, signal);
  }
  async readIndex() {
    const signal = this.controller.signal;
    const manager = this.options.manager ?? DefaultLoadingManager;
    const resolveBase =
      typeof document === "undefined" ? undefined : document.baseURI;
    const url = new URL(manager.resolveURL(this.options.url), resolveBase).href;
    const resourceUrl = new URL(this.options.url, resolveBase ?? url).href;
    this.baseUrl = getAssetBaseUrl(url) ?? resourceUrl;
    manager.itemStart(url);
    try {
      const response = await fetch(url, {
        ...requestOptions(this.options, url, resourceUrl),
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
      const bytes = new Uint8Array(joinBytes(chunks, size)).buffer;
      this.assertActive();
      const { retainedIndexBytes, ...index } = await this.lodWorker.call(
        "parseSogIndex",
        {
          bytes,
          baseUrl: getAssetBaseUrl(response.url || url) ?? resourceUrl,
        },
      );
      this.assertActive();
      this.retainedIndexBytes = retainedIndexBytes;
      return index;
    } catch (error) {
      manager.itemError(url);
      throw error;
    } finally {
      manager.itemEnd(url);
    }
  }
  async selectLod(view, budget) {
    this.assertActive();
    return this.lodWorker.call("selectSogLod", { view, budget });
  }
  async load(url, count, signal) {
    this.assertActive();
    const manager = this.options.manager ?? DefaultLoadingManager;
    return this.pool.run(
      {
        signal,
        manager,
        cancel: (worker, id) => worker.call("releaseSogChunk", { id }),
      },
      async ({ worker, id, signal, retain, start, progress }) => {
        this.assertActive();
        let info;
        if (this.options.loadChunk) {
          const custom = await this.options.loadChunk(url, signal);
          try {
            signal.throwIfAborted();
            info = await worker.call("cacheSogChunk", {
              id,
              data: custom.takeData(),
            });
          } finally {
            custom.dispose();
          }
        } else {
          const resolveBase =
            typeof document === "undefined" ? this.baseUrl : document.baseURI;
          const resourceUrl = new URL(url, resolveBase).href;
          const resolved = new URL(manager.resolveURL(url), resolveBase).href;
          start(resolved);
          const sameOrigin =
            new URL(getAssetBaseUrl(resolved) ?? resourceUrl).origin ===
            new URL(this.baseUrl).origin;
          info = await worker.call(
            "loadSogChunk",
            {
              id,
              url: resolved,
              baseUrl: resourceUrl,
              fileType: "sog",
              requestHeader: sameOrigin
                ? this.options.requestHeader
                : undefined,
              withCredentials: sameOrigin && this.options.withCredentials,
              expectedSogCount: count < 0 ? undefined : count,
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
        return new SogChunkSource(worker, id, info, retain());
      },
    );
  }
  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort(
      new DOMException("SOG loader disposed", "AbortError"),
    );
    this.pool.dispose(this.controller.signal.reason);
    this.lodWorker.dispose(this.controller.signal.reason);
    this.initialization = undefined;
    this.retainedIndexBytes = 0;
  }
}
