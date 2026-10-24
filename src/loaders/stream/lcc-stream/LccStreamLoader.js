import { DefaultLoadingManager } from "three";
import { WorkerTerminatedError } from "../../../runtime/WorkerRpc.js";
import { abortable } from "../../../runtime/abort.js";
import { getAssetBaseUrl } from "../../assetUrl.js";
import { joinBytes, readResponse, requestOptions } from "../../source.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { LccStreamWorker } from "./LccStreamWorker.js";
// Exports use lowercase names; the whitepaper lists capitalized ones.
const COMPANIONS = [
  {
    index: "index.bin",
    data: "data.bin",
    sh: "shcoef.bin",
    environment: "environment.bin",
  },
  {
    index: "Index.bin",
    data: "Data.bin",
    sh: "Shcoef.bin",
    environment: "Environment.bin",
  },
];
/** A decoded LCC2 file retained by its worker; extraction transfers node data. */
export class LccFileSource {
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
      throw new WorkerTerminatedError("LCC2 file is no longer cached");
    return this.worker.call("extractLccNodes", { id: this.id, ranges });
  }
  dispose() {
    if (this.released) return;
    this.released = true;
    if (!this.worker.disposed)
      void this.worker.call("releaseLccFile", { id: this.id }).catch(() => {});
    this.onRelease();
  }
}
/** Dedicated LOD worker plus bounded decoders; LCC2 files stay with their decoder. */
export class LccStreamLoader {
  constructor(options, maxConcurrentLoads, onChange) {
    this.options = options;
    this.controller = new AbortController();
    this.baseUrl = "";
    this.downloadedBytes = 0;
    this.retainedIndexBytes = 0;
    // Idle decoders stay alive: LCC nodes need no cache to keep a worker busy.
    this.pool = new StreamWorkerPool(
      () => new LccStreamWorker(() => queueMicrotask(onChange)),
      maxConcurrentLoads,
      true,
    );
    this.lodWorker = new LccStreamWorker(() => queueMicrotask(onChange));
  }
  get manager() {
    return this.options.manager ?? DefaultLoadingManager;
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
    if (this.lodWorker.disposed) throw new Error("LCC LOD worker terminated");
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
  /** Resolve a scene file through the manager; only same-origin requests carry credentials. */
  resolve(path) {
    const documentBase =
      typeof document === "undefined" ? this.baseUrl : document.baseURI;
    const resourceUrl = new URL(path, this.baseUrl || documentBase).href;
    const url = new URL(this.manager.resolveURL(resourceUrl), documentBase)
      .href;
    const sameOrigin =
      !this.baseUrl ||
      new URL(getAssetBaseUrl(url) ?? resourceUrl).origin ===
        new URL(this.baseUrl).origin;
    return {
      url,
      resourceUrl,
      requestHeader: sameOrigin ? this.options.requestHeader : undefined,
      withCredentials: sameOrigin && !!this.options.withCredentials,
    };
  }
  /** Small whole files on the main thread; returns undefined for HTTP 404. */
  async fetchFile(path, optional = false) {
    const signal = this.controller.signal;
    let target;
    try {
      target = this.resolve(path);
    } catch (error) {
      // A URL modifier can reject files that a local selection lacks.
      if (optional) return undefined;
      throw error;
    }
    const { url } = target;
    this.manager.itemStart(url);
    try {
      const response = await fetch(url, {
        ...requestOptions(this.options, url, this.baseUrl || undefined),
        signal,
      });
      if (optional && response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return undefined;
      }
      const { chunks, size } = await readResponse(
        response,
        Number.POSITIVE_INFINITY,
        (bytes) => {
          this.downloadedBytes += bytes;
        },
        signal,
      );
      return {
        bytes: new Uint8Array(joinBytes(chunks, size)).buffer,
        responseUrl: response.url || url,
      };
    } catch (error) {
      this.manager.itemError(url);
      throw error;
    } finally {
      this.manager.itemEnd(url);
    }
  }
  async readIndex() {
    const manifest = await this.fetchFile(this.options.url);
    this.assertActive();
    const documentBase =
      typeof document === "undefined" ? undefined : document.baseURI;
    this.baseUrl =
      getAssetBaseUrl(manifest.responseUrl) ??
      new URL(this.options.url, documentBase).href;
    const parsed = await this.lodWorker.call("parseLccManifest", {
      bytes: manifest.bytes,
      baseUrl: this.baseUrl,
    });
    this.assertActive();
    let table = parsed;
    if (parsed.format === "lcc") {
      let companions = COMPANIONS[0];
      let index = await this.fetchFile(companions.index, true);
      if (!index) {
        companions = COMPANIONS[1];
        index = await this.fetchFile(companions.index, true);
      }
      if (!index) throw new Error("LCC: index.bin is missing");
      this.assertActive();
      table = await this.lodWorker.call("parseLccUnits", {
        bytes: index.bytes,
      });
      this.assertActive();
      Object.assign(table, {
        companions,
        hasSh: parsed.hasSh,
        ranges: parsed.ranges,
        environmentRanges: parsed.environmentRanges,
      });
    }
    this.retainedIndexBytes = table.retainedIndexBytes;
    this.table = table;
    return table;
  }
  async selectLod(request) {
    this.assertActive();
    return this.lodWorker.call("selectLcc", request);
  }
  /** Tighten selection bounds from loaded data; failures only lose precision. */
  setBounds(updates) {
    if (!this.lodWorker.disposed)
      void this.lodWorker.call("setLccBounds", { updates }).catch(() => {});
  }
  run(signal, load) {
    this.assertActive();
    return this.pool.run(
      {
        signal,
        manager: this.manager,
        cancel: (worker, id) => worker.call("cancelLccLoad", { id }),
      },
      load,
    );
  }
  /** One LCC node, decoded and reordered in a pool worker. */
  loadNode(node, signal) {
    const { table } = this;
    return this.run(signal, async ({ worker, id, start, progress }) => {
      const data = this.resolve(table.companions.data);
      const sh = table.hasSh
        ? this.resolve(table.companions.sh).url
        : undefined;
      start(data.url);
      return worker.call(
        "loadLccRecords",
        {
          id,
          data: data.url,
          sh,
          count: table.count[node],
          sourceBase: table.start[node],
          // RPC transfers typed arrays; keep the table's copy.
          ranges: table.ranges.slice(),
          source: data,
        },
        { onStatus: (status) => progress(status.loaded) },
      );
    });
  }
  /** environment.bin, or undefined when the scene has none. */
  loadEnvironment(signal) {
    const { table } = this;
    return this.run(signal, async ({ worker, id, start, progress }) => {
      let target;
      try {
        target = this.resolve(table.companions.environment);
      } catch {
        return undefined;
      }
      start(target.url);
      return worker.call(
        "loadLccEnvironment",
        {
          id,
          url: target.url,
          hasSh: table.hasSh,
          ranges: table.environmentRanges.slice(),
          source: target,
        },
        { onStatus: (status) => progress(status.loaded) },
      );
    });
  }
  /** Decode an LCC2 splat file into a retained worker cache. */
  loadFile(file, signal) {
    const { url, type, required } = this.table.files[file];
    return this.run(
      signal,
      async ({ worker, id, signal, retain, start, progress }) => {
        const target = this.resolve(url);
        start(target.url);
        const info = await worker.call(
          "loadLccFile",
          {
            id,
            url: target.url,
            baseUrl: target.resourceUrl,
            fileType: type,
            required,
            requestHeader: target.requestHeader,
            withCredentials: target.withCredentials,
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
        this.assertActive();
        return new LccFileSource(worker, id, info, retain());
      },
    );
  }
  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort(
      new DOMException("LCC loader disposed", "AbortError"),
    );
    this.pool.dispose(this.controller.signal.reason);
    this.lodWorker.dispose(this.controller.signal.reason);
    this.initialization = undefined;
    this.retainedIndexBytes = 0;
  }
}
