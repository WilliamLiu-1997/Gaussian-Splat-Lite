import { DefaultLoadingManager } from "three";
import { WorkerTerminatedError } from "../../../runtime/WorkerRpc.js";
import { abortable } from "../../../runtime/abort.js";
import { getAssetBaseUrl } from "../../assetUrl.js";
import { joinBytes, readResponse, requestOptions } from "../../source.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { streamSources } from "../streamOptions.js";
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
  constructor(options, maxConcurrentLoads, maxSh, onChange) {
    this.maxSh = maxSh;
    this.controller = new AbortController();
    this.sources = streamSources(options).map((options) => ({
      options: { ...options },
      baseUrl: "",
    }));
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
    this.initialization ??= this.readIndices().catch((error) => {
      this.dispose();
      throw error;
    });
    return abortable(this.initialization, signal);
  }
  async readIndices() {
    for (const input of this.sources) await this.readIndex(input);
    const { retainedIndexBytes, ...index } = await this.lodWorker.call(
      "initializeSogIndex",
      undefined,
    );
    this.assertActive();
    this.retainedIndexBytes = retainedIndexBytes;
    return index;
  }
  async readIndex(input) {
    const { options } = input;
    const signal = this.controller.signal;
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
      const bytes = new Uint8Array(joinBytes(chunks, size)).buffer;
      await this.lodWorker.call("parseSogIndex", {
        bytes,
        baseUrl: getAssetBaseUrl(response.url || url) ?? resourceUrl,
      });
      this.assertActive();
    } catch (error) {
      manager.itemError(url);
      throw error;
    } finally {
      manager.itemEnd(url);
    }
  }
  async selectLod(request) {
    this.assertActive();
    return this.lodWorker.call("selectSogLod", request);
  }
  async load(sourceIndex, url, count, signal) {
    this.assertActive();
    const { options, baseUrl } = this.sources[sourceIndex];
    const manager = options.manager ?? DefaultLoadingManager;
    return this.pool.run(
      {
        signal,
        manager,
        cancel: (worker, id) => worker.call("releaseSogChunk", { id }),
      },
      async ({ worker, id, signal, retain, start, progress }) => {
        this.assertActive();
        let info;
        if (options.loadChunk) {
          const custom = await options.loadChunk(url, signal);
          try {
            signal.throwIfAborted();
            info = await worker.call("cacheSogChunk", {
              id,
              data: custom.takeData(),
              maxSh: this.maxSh,
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
            "loadSogChunk",
            {
              id,
              url: resolved,
              baseUrl: resourceUrl,
              fileType: "sog",
              maxSh: this.maxSh,
              requestHeader: sameOrigin ? options.requestHeader : undefined,
              withCredentials: sameOrigin && options.withCredentials,
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
