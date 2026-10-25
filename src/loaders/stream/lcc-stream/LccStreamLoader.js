import { DefaultLoadingManager } from "three";
import { WorkerTerminatedError } from "../../../runtime/WorkerRpc.js";
import { abortable } from "../../../runtime/abort.js";
import { getAssetBaseUrl } from "../../assetUrl.js";
import { joinBytes, readResponse, requestOptions } from "../../source.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { LccStreamWorker } from "./LccStreamWorker.js";

export class LccChunkSource {
  constructor(worker, id, info, release) {
    this.worker = worker;
    this.id = id;
    this.info = info;
    this.release = release;
    this.released = false;
  }
  get alive() {
    return !this.released && !this.worker.disposed;
  }
  extract(ranges) {
    if (!this.alive)
      throw new WorkerTerminatedError("LCC chunk is no longer cached");
    return this.worker.call("extractLccNodes", { id: this.id, ranges });
  }
  dispose() {
    if (this.released) return;
    this.released = true;
    if (!this.worker.disposed)
      void this.worker.call("releaseLccChunk", { id: this.id }).catch(() => {});
    this.release();
  }
}
/** The same worker-pool ownership and LoadingManager contract as RAD/SOG. */
export class LccStreamLoader {
  constructor(options, concurrency, onChange) {
    this.options = options;
    this.manager = options.manager ?? DefaultLoadingManager;
    this.origin = new URL(
      options.url,
      typeof document === "undefined" ? undefined : document.baseURI,
    ).origin;
    this.controller = new AbortController();
    this.resourceVersions = new Map();
    this.downloadedBytes = 0;
    this.retainedIndexBytes = 0;
    this.pool = new StreamWorkerPool(
      () => new LccStreamWorker(() => queueMicrotask(onChange)),
      concurrency,
    );
    this.lodWorker = new LccStreamWorker(() => queueMicrotask(onChange));
  }
  get stats() {
    return {
      downloadedBytes: this.downloadedBytes + this.pool.downloadedBytes,
      peakWasmMemoryBytes:
        this.pool.peakWasmMemoryBytes + this.lodWorker.peakWasmMemoryBytes,
      retainedIndexBytes: this.lodWorker.disposed ? 0 : this.retainedIndexBytes,
    };
  }
  resolve(path) {
    const base =
      typeof document === "undefined" ? this.baseUrl : document.baseURI;
    const resourceUrl = new URL(path, base).href;
    const url = new URL(this.manager.resolveURL(resourceUrl), base).href;
    const sameOrigin =
      new URL(getAssetBaseUrl(url) ?? resourceUrl).origin === this.origin;
    return {
      url,
      baseUrl: resourceUrl,
      requestHeader: sameOrigin ? this.options.requestHeader : undefined,
      withCredentials: sameOrigin && this.options.withCredentials,
    };
  }
  initialize(signal) {
    this.controller.signal.throwIfAborted();
    this.initialization ??= this.readIndex();
    return abortable(this.initialization, signal);
  }
  async readIndex() {
    const read = async (path, parse) => {
      const request = this.resolve(path);
      this.manager.itemStart(request.url);
      try {
        const response = await fetch(request.url, {
          ...requestOptions(request, request.url, request.baseUrl),
          signal: this.controller.signal,
        });
        const { chunks, size } = await readResponse(
          response,
          Number.POSITIVE_INFINITY,
          (size) => {
            this.downloadedBytes += size;
          },
          this.controller.signal,
        );
        return await parse(
          joinBytes(chunks, size),
          getAssetBaseUrl(response.url || request.url) ?? request.baseUrl,
        );
      } catch (error) {
        this.manager.itemError(request.url);
        throw error;
      } finally {
        this.manager.itemEnd(request.url);
      }
    };
    return read(this.options.url, async (bytes, baseUrl) => {
      this.baseUrl = baseUrl;
      let index = await this.lodWorker.call("parseLccManifest", {
        bytes,
        baseUrl,
      });
      if (!index)
        index = await read(new URL("index.bin", baseUrl).href, (bytes) =>
          this.lodWorker.call("parseLccIndex", { bytes, baseUrl }),
        );
      this.controller.signal.throwIfAborted();
      this.retainedIndexBytes = index.retainedIndexBytes;
      this.index = index;
      return index;
    });
  }
  selectLod(request) {
    return this.lodWorker.call("selectLcc", request);
  }
  load(chunk, signal) {
    const index = this.index;
    return this.pool.run(
      {
        signal,
        manager: this.manager,
        cancel: (worker, id) => worker.call("releaseLccChunk", { id }),
      },
      async ({ worker, id, signal, retain, start, progress }) => {
        const request = this.resolve(chunk.url);
        start(request.url);
        const { resources, ...info } = await worker.call(
          "loadLccChunk",
          {
            id,
            request,
            chunk,
            hasSh: index.hasSh,
            ranges: (chunk.environment
              ? index.environmentRanges
              : index.ranges
            )?.slice(),
            sh:
              index.hasSh && !chunk.environment
                ? this.resolve(index.shUrl)
                : undefined,
          },
          {
            onStatus: (status) => {
              if ("assetRequest" in status)
                return worker.call("resolveAsset", {
                  requestId: status.assetRequest,
                  url: this.resolve(status.url).url,
                });
              if ("loaded" in status) progress(status.loaded);
            },
          },
        );
        signal.throwIfAborted();
        this.acceptResources(resources);
        return new LccChunkSource(worker, id, info, retain());
      },
    );
  }
  acceptResources(resources) {
    // Workers may read the same file concurrently; reconcile every response
    // here before any of its decoded ranges can be published.
    for (const resource of resources) {
      const previous = this.resourceVersions.get(resource.url);
      if (
        previous &&
        (previous.etag
          ? resource.etag !== previous.etag
          : previous.lastModified &&
            resource.lastModified !== previous.lastModified)
      )
        throw new Error("LCC: resource version changed during loading");
      if (
        previous?.total !== undefined &&
        resource.total !== undefined &&
        previous.total !== resource.total
      )
        throw new Error("LCC: resource length changed during loading");
      this.resourceVersions.set(resource.url, {
        etag: previous?.etag ?? resource.etag,
        lastModified: previous?.lastModified ?? resource.lastModified,
        total: previous?.total ?? resource.total,
      });
    }
  }
  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort(
      new DOMException("LCC loader disposed", "AbortError"),
    );
    this.pool.dispose(this.controller.signal.reason);
    this.lodWorker.dispose(this.controller.signal.reason);
    this.index = undefined;
    this.initialization = undefined;
    this.retainedIndexBytes = 0;
    this.resourceVersions.clear();
  }
}
