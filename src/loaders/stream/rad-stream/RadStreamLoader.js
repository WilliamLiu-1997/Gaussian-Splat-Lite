import { DefaultLoadingManager } from "three";
import { ShPalette } from "../../../data/shPalette.js";
import { getShPaletteLayout } from "../../../data/shPaletteData.js";
import { abortable, linkedAbortController } from "../../../runtime/abort.js";
import { RadSource } from "../../rad/RadSource.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { RadStreamWorker } from "./RadStreamWorker.js";
/** Separate traversal and display preparation workers, plus bounded page decoders. */
export class RadStreamLoader {
  constructor(maxConcurrentLoads, maxSh, onRegistrationSettled, onWorkerError) {
    this.maxSh = maxSh;
    this.onRegistrationSettled = onRegistrationSettled;
    this.decoderReady = new WeakMap();
    this.controller = new AbortController();
    // Shared workers own persistent state. Their loss is global, even when
    // the pending task was cancelled or no task is awaiting a reply.
    this.onWorkerError = (error) => {
      if (!this.controller.signal.aborted) onWorkerError(error);
    };
    this.pendingRegistrationBytes = 0;
    this.selectionBytes = 0;
    this.preparationBytes = 0;
    this.sources = new Map();
    this.downloadedBytes = 0;
    this.lodWorker = new RadStreamWorker(this.onWorkerError);
    this.preparationWorker = new RadStreamWorker(this.onWorkerError);
    this.pool = new StreamWorkerPool(
      () => new RadStreamWorker(),
      maxConcurrentLoads,
      true,
    );
  }
  get stats() {
    let cachedBytes = 0;
    let downloadedBytes = this.downloadedBytes + this.pool.downloadedBytes;
    let paletteBytes = 0;
    for (const input of this.sources.values()) {
      const stats = input.source.stats;
      cachedBytes += stats.cachedBytes;
      downloadedBytes += stats.downloadedBytes;
      paletteBytes += input.palette?.byteLength ?? 0;
    }
    return {
      cachedBytes,
      downloadedBytes,
      peakWasmMemoryBytes:
        this.pool.peakWasmMemoryBytes +
        this.lodWorker.peakWasmMemoryBytes +
        this.preparationWorker.peakWasmMemoryBytes,
      // Each shared palette has one CPU copy and one texture of the same size.
      paletteBytes,
      selectionBytes: this.selectionBytes + this.preparationBytes,
    };
  }
  /** Reserve each input's source cache and shared SH palette. */
  get residentCpuOverheadBytes() {
    let bytes = 0;
    for (const input of this.sources.values())
      bytes += input.source.stats.cachedBytes + input.estimatedPaletteBytes;
    return bytes;
  }
  /** Reserve each input's shared SH palette texture. */
  get residentGpuOverheadBytes() {
    let bytes = 0;
    for (const input of this.sources.values())
      bytes += input.estimatedPaletteBytes;
    return bytes;
  }
  palette(source) {
    return this.sources.get(source)?.palette;
  }
  async addSource(id, options, signal) {
    this.controller.signal.throwIfAborted();
    const input = {
      id,
      source: new RadSource({
        ...options,
        manager: options.manager ?? DefaultLoadingManager,
      }),
      estimatedPaletteBytes: 0,
      palette: undefined,
    };
    this.sources.set(id, input);
    const request = linkedAbortController(this.controller.signal, signal);
    try {
      return await abortable(
        this.readSource(input, request.signal),
        request.signal,
      );
    } catch (error) {
      this.removeSource(id);
      throw error;
    } finally {
      request.cleanup();
    }
  }
  async readSource(input, signal) {
    const bytes = await input.source.readHeader(signal);
    signal.throwIfAborted();
    // Register both worker-owned directories before pages can be decoded.
    const [result] = await Promise.all([
      this.lodWorker.call("addRadSource", { id: input.id, bytes }),
      this.preparationWorker.call("addRadSelectionSource", {
        source: input.id,
      }),
    ]);
    this.controller.signal.throwIfAborted();
    signal.throwIfAborted();
    const { header } = result;
    input.metadata = result;
    const degree = Math.min(header.meta.maxSh ?? 0, this.maxSh);
    const codeCount = header.meta.count ? (header.meta.shCodeCount ?? 0) : 0;
    input.estimatedPaletteBytes =
      codeCount > 0 && degree > 0
        ? getShPaletteLayout(codeCount, degree).byteLength
        : 0;
    return result;
  }
  removeSource(id) {
    const input = this.sources.get(id);
    if (!input) return;
    this.sources.delete(id);
    this.downloadedBytes += input.source.stats.downloadedBytes;
    input.source.dispose();
    input.palette?.dispose();
    for (const worker of this.pool.workers) {
      if (this.decoderReady.get(worker)?.input !== input) continue;
      worker.dispose(new DOMException("RAD source removed", "AbortError"));
      this.decoderReady.delete(worker);
    }
    this.send(this.lodWorker, "removeRadSource", { id }, (bytes) => {
      this.selectionBytes = bytes;
      this.onRegistrationSettled();
    });
    this.send(
      this.preparationWorker,
      "removeRadSelectionSource",
      { source: id },
      (bytes) => {
        this.preparationBytes = bytes;
        this.onRegistrationSettled();
      },
    );
  }
  async loadChunk(sourceId, index, signal) {
    signal?.throwIfAborted();
    this.controller.signal.throwIfAborted();
    // The scheduler owns each page's load and requests roots before children.
    const input = this.sources.get(sourceId);
    const { metadata, source } = input;
    const { header } = metadata;
    return this.pool.run(
      {
        signal,
        manager: source.options.manager,
        cancel: (worker, generation) =>
          worker.call("cancelRadLoad", { generation }),
      },
      async ({ worker, id: generation, signal, start, progress }) => {
        this.controller.signal.throwIfAborted();
        let ready = this.decoderReady.get(worker);
        // Decoders need only their input's header; pages decode independently.
        if (ready?.input !== input) {
          const promise = worker
            .call("initializeRadDecoder", { header, maxSh: this.maxSh })
            .catch((error) => {
              worker.dispose(error);
              throw error;
            });
          ready = { input, promise };
          this.decoderReady.set(worker, ready);
        }
        // Resolve application callbacks here; page bodies stay inside the worker.
        let request;
        try {
          [request] = await Promise.all([
            source.prepareChunk(header, index, signal),
            ready.promise,
          ]);
        } catch (error) {
          // Do not return this worker to the pool while initialization is pending.
          await ready.promise.catch(() => {});
          throw error;
        }
        signal.throwIfAborted();
        this.controller.signal.throwIfAborted();
        if (typeof request.input === "string") start(request.input);
        const result = await worker.call(
          "loadRadChunk",
          {
            index,
            generation,
            request,
            needsPalette: !input.palette,
          },
          {
            onStatus: (status) => progress(status.loaded),
          },
        );
        this.controller.signal.throwIfAborted();
        signal.throwIfAborted();
        try {
          source.acceptChunkResponse(request, result.state);
        } catch (error) {
          // A response rejected against another worker must not seed future jobs.
          worker.dispose(error);
          throw error;
        }
        if (result.palette && !input.palette)
          input.palette = new ShPalette(
            result.palette,
            result.data.extra.shDegree,
          );
        // Uploads can start immediately; selection waits for both registrations.
        const registration = this.registerChunk(
          index,
          input.id,
          generation,
          result.tree,
        );
        return { data: result.data, registration };
      },
    );
  }
  registerChunk(
    index,
    source,
    generation,
    { sourceToStorage, boundsBlocks, ...tree },
  ) {
    const treeBytes = Object.values(tree).reduce(
      (bytes, array) => bytes + array.byteLength,
      0,
    );
    const preparationBytes =
      sourceToStorage.byteLength + boundsBlocks.byteLength;
    this.pendingRegistrationBytes += treeBytes + preparationBytes;
    const settled = (bytes) => {
      if (this.controller.signal.aborted) return;
      this.pendingRegistrationBytes -= bytes;
      this.onRegistrationSettled();
    };
    // Transfers still occupy queue memory until their own worker acknowledges.
    const retained = this.lodWorker
      .call("retainRadChunk", { index, generation, source, tree })
      .finally(() => settled(treeBytes));
    const prepared = this.preparationWorker
      .call("retainRadSelectionChunk", {
        index,
        generation,
        source,
        chunk: { sourceToStorage, boundsBlocks },
      })
      .then((bytes) => {
        if (!this.controller.signal.aborted) this.preparationBytes = bytes;
      })
      .finally(() => settled(preparationBytes));
    const registration = Promise.all([retained, prepared]).then(
      () => {},
      (error) => {
        this.releaseChunk(index, source, generation);
        throw error;
      },
    );
    // A cancelled load may discard its data before observing registration.
    void registration.catch(() => {});
    return registration;
  }
  getChunkUrl(sourceId, index) {
    const input = this.sources.get(sourceId);
    const chunk = input?.metadata.header.meta.chunks[index];
    const filename = chunk?.filename;
    const root = input?.source.url;
    if (filename) return root ? new URL(filename, root).href : filename;
    return root ?? input?.source.options.file?.name ?? "RAD";
  }
  /** Await a worker reply that is discarded once the loader is disposed. */
  async call(worker, name, args) {
    this.controller.signal.throwIfAborted();
    const result = await worker.call(name, args);
    this.controller.signal.throwIfAborted();
    return result;
  }
  /** Request without waiting; a live reply may report retained bytes. */
  send(worker, name, args, onBytes) {
    if (!worker || worker.disposed) return;
    void worker
      .call(name, args)
      .then((bytes) => {
        if (!this.controller.signal.aborted) onBytes?.(bytes);
      })
      .catch(() => {});
  }
  async selectLod(request) {
    const { retainedBytes, ...selection } = await this.call(
      this.lodWorker,
      "selectRadLod",
      request,
    );
    this.selectionBytes = retainedBytes;
    return selection;
  }
  prepareSelection(request) {
    return this.call(this.preparationWorker, "prepareRadSelection", request);
  }
  snapshotSelection(id) {
    return this.call(this.lodWorker, "snapshotRadSelection", { id });
  }
  prepareMerge(request) {
    return this.call(this.preparationWorker, "prepareRadMerge", request);
  }
  allocateStorage(numSh, indexedSh) {
    return this.call(this.preparationWorker, "allocateRadStorage", {
      numSh,
      indexedSh,
    });
  }
  releaseChunk(index, source, generation) {
    this.send(this.lodWorker, "releaseRadChunk", { index, generation, source });
    this.send(
      this.preparationWorker,
      "releaseRadSelectionChunk",
      { index, generation, source },
      (bytes) => {
        this.preparationBytes = bytes;
      },
    );
  }
  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort(
      new DOMException("RAD loader disposed", "AbortError"),
    );
    for (const input of this.sources.values()) {
      input.source.dispose();
      input.palette?.dispose();
    }
    this.pool.dispose(this.controller.signal.reason);
    for (const worker of this.pool.workers) this.decoderReady.delete(worker);
    this.lodWorker.dispose(this.controller.signal.reason);
    this.preparationWorker.dispose(this.controller.signal.reason);
    this.pendingRegistrationBytes = 0;
    this.selectionBytes = 0;
    this.preparationBytes = 0;
    this.sources.clear();
  }
}
