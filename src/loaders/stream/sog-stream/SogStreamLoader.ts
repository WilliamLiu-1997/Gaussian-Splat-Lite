import { DefaultLoadingManager } from "three";
import type { Splats } from "../../../data/Splats";
import { abortable, linkedAbortController } from "../../../runtime/abort";
import { getAssetBaseUrl } from "../../assetUrl";
import type { SplatLoadStatus } from "../../loadTypes";
import { joinBytes, readResponse, requestOptions } from "../../source";
import { StreamWorkerPool } from "../StreamWorkerPool";
import type { StreamRequestOptions } from "../streamOptions";
import { SogStreamWorker } from "./SogStreamWorker";
import type { SogLodIndex } from "./sogLod";
import type { SogView } from "./sogVisibility";
import type { SogChunkInfo } from "./workerHandlers";

export type SogStreamLoaderOptions = StreamRequestOptions & {
  url: string;
  /** Returns independently owned data in original storage order. */
  loadChunk?: (url: string, signal: AbortSignal) => Promise<Splats>;
};

/** A retained worker cache; extraction transfers owned packed arrays to the caller. */
export class SogChunkSource {
  private released = false;
  constructor(
    private readonly worker: SogStreamWorker,
    private readonly id: number,
    readonly info: SogChunkInfo,
    private readonly onRelease: () => void,
  ) {}

  get alive() {
    return !this.released && !this.worker.disposed;
  }

  async extract(ranges: { start: number; count: number }[]) {
    if (!this.alive) throw new Error("Streaming chunk is no longer cached");
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
  private readonly lodWorker: SogStreamWorker;
  private readonly pool: StreamWorkerPool<SogStreamWorker>;
  private readonly controller = new AbortController();
  private initialization?: Promise<SogLodIndex>;
  private nextId = 0;
  private baseUrl = "";
  private downloadedBytes = 0;
  private retainedIndexBytes = 0;

  constructor(
    private readonly options: SogStreamLoaderOptions,
    maxConcurrentLoads: number,
    onChange: () => void,
  ) {
    this.pool = new StreamWorkerPool(
      () => new SogStreamWorker(() => queueMicrotask(onChange)),
      maxConcurrentLoads,
    );
    this.lodWorker = new SogStreamWorker(() => queueMicrotask(onChange));
  }

  get stats() {
    return {
      downloadedBytes: this.downloadedBytes,
      peakWasmMemoryBytes:
        this.pool.peakWasmMemoryBytes + this.lodWorker.peakWasmMemoryBytes,
      retainedIndexBytes: this.lodWorker.disposed ? 0 : this.retainedIndexBytes,
    };
  }

  private assertActive() {
    this.controller.signal.throwIfAborted();
    if (this.lodWorker.disposed) throw new Error("SOG LOD worker terminated");
  }

  initialize(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.assertActive();
    this.initialization ??= this.readIndex().catch((error) => {
      this.dispose();
      throw error;
    });
    return abortable(this.initialization, signal);
  }

  private async readIndex() {
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
      const index = await this.lodWorker.call("parseSogIndex", {
        bytes,
        baseUrl: getAssetBaseUrl(response.url || url) ?? resourceUrl,
      });
      this.assertActive();
      this.retainedIndexBytes =
        index.nodes.byteLength +
        index.leafOffsets.byteLength +
        index.lods.byteLength +
        index.counts.byteLength;
      return index;
    } catch (error) {
      manager.itemError(url);
      throw error;
    } finally {
      manager.itemEnd(url);
    }
  }

  async selectLod(view: SogView, budget: number): Promise<Uint32Array> {
    this.assertActive();
    return this.lodWorker.call("selectSogLod", { view, budget });
  }

  async load(url: string, count: number, signal: AbortSignal) {
    this.assertActive();
    const request = linkedAbortController(this.controller.signal, signal);
    const activeSignal = request.signal;
    const lease = await this.pool.acquire(activeSignal).catch((error) => {
      request.cleanup();
      throw error;
    });
    const { worker } = lease;
    const id = ++this.nextId;
    const release = () => {
      if (!worker.disposed)
        void worker.call("releaseSogChunk", { id }).catch(() => {});
    };
    activeSignal.addEventListener("abort", release, { once: true });
    const manager = this.options.manager ?? DefaultLoadingManager;
    const resolveBase =
      typeof document === "undefined" ? this.baseUrl : document.baseURI;
    let resolved: string | undefined;
    let custom: Splats | undefined;
    let loaded = 0;
    try {
      activeSignal.throwIfAborted();
      this.assertActive();
      let info: SogChunkInfo;
      if (this.options.loadChunk) {
        custom = await this.options.loadChunk(url, activeSignal);
        activeSignal.throwIfAborted();
        info = await worker.call("cacheSogChunk", {
          id,
          data: custom.takeData(),
        });
      } else {
        const resourceUrl = new URL(url, resolveBase).href;
        resolved = new URL(manager.resolveURL(url), resolveBase).href;
        manager.itemStart(resolved);
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
            requestHeader: sameOrigin ? this.options.requestHeader : undefined,
            withCredentials: sameOrigin && this.options.withCredentials,
            expectedSogCount: count < 0 ? undefined : count,
          },
          {
            onStatus: (data) => {
              const status = data as SplatLoadStatus;
              if ("assetRequest" in status)
                return worker.call("resolveAsset", {
                  requestId: status.assetRequest,
                  url: new URL(manager.resolveURL(status.url), resolveBase)
                    .href,
                });
              if ("loaded" in status) {
                this.downloadedBytes += Math.max(0, status.loaded - loaded);
                loaded = status.loaded;
              }
            },
          },
        );
      }
      activeSignal.throwIfAborted();
      this.assertActive();
      return new SogChunkSource(worker, id, info, lease.retain());
    } catch (error) {
      release();
      if (resolved) manager.itemError(resolved);
      throw error;
    } finally {
      custom?.dispose();
      activeSignal.removeEventListener("abort", release);
      request.cleanup();
      lease.release();
      if (resolved) manager.itemEnd(resolved);
    }
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
