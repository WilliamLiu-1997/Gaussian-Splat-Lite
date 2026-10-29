import { DefaultLoadingManager } from "three";
import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import { abortable } from "../../../runtime/abort.js";
import { RadSource } from "../../rad/RadSource.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { streamSources } from "../streamOptions.js";
import { RadStreamWorker } from "./RadStreamWorker.js";
import CodebookWorker from "./codebookWorker.js?worker&inline";
/** Separate traversal and display preparation workers, plus bounded page decoders. */
export class RadStreamLoader {
  constructor(options, maxConcurrentLoads, maxSh, onRegistrationSettled) {
    this.maxSh = maxSh;
    this.onRegistrationSettled = onRegistrationSettled;
    this.decoderReady = new WeakMap();
    this.controller = new AbortController();
    this.pendingRegistrationBytes = 0;
    this.selectionBytes = 0;
    this.preparationBytes = 0;
    this.sources = streamSources(options).map((options) => ({
      source: new RadSource({
        ...options,
        manager: options.manager ?? DefaultLoadingManager,
      }),
      estimatedCodebookCacheBytes: 0,
      estimatedCodebookBytes: 0,
      codebookBytes: 0,
    }));
    this.lodWorker = new RadStreamWorker();
    this.preparationWorker = new RadStreamWorker();
    this.pool = new StreamWorkerPool(
      () => new RadStreamWorker(),
      maxConcurrentLoads,
      true,
    );
  }
  get stats() {
    let cachedBytes = 0;
    let downloadedBytes = this.pool.downloadedBytes;
    let codebookCacheBytes = 0;
    for (const input of this.sources) {
      const stats = input.source.stats;
      cachedBytes += stats.cachedBytes;
      downloadedBytes += stats.downloadedBytes;
      codebookCacheBytes += input.codebookBytes;
    }
    return {
      cachedBytes,
      downloadedBytes,
      peakWasmMemoryBytes:
        this.pool.peakWasmMemoryBytes +
        this.lodWorker.peakWasmMemoryBytes +
        this.preparationWorker.peakWasmMemoryBytes,
      estimatedCodebookBytes: this.pool.workers.reduce(
        (bytes, worker) =>
          bytes +
          (worker.disposed
            ? 0
            : (this.decoderReady.get(worker)?.input.estimatedCodebookBytes ??
              0)),
        0,
      ),
      codebookCacheBytes,
      selectionBytes: this.selectionBytes + this.preparationBytes,
    };
  }
  /** Reserve per-input packed codebooks and each worker's current decoder. */
  get residentCpuOverheadBytes() {
    // Each worker retains only its current input's decoder/codebooks.
    let bytes = 0;
    let codebookBytes = 0;
    for (const input of this.sources) {
      bytes += input.source.stats.cachedBytes;
      bytes += input.estimatedCodebookCacheBytes;
      codebookBytes = Math.max(codebookBytes, input.estimatedCodebookBytes);
    }
    return bytes + codebookBytes * this.pool.concurrency;
  }
  get selectionWorkerLost() {
    return (
      (this.lodWorker.disposed ||
        this.preparationWorker.disposed ||
        this.codebookWorker?.disposed === true) &&
      !this.controller.signal.aborted
    );
  }
  assertActive() {
    this.controller.signal.throwIfAborted();
    if (this.lodWorker.disposed) throw new Error("RAD LOD worker terminated");
    if (this.preparationWorker.disposed)
      throw new Error("RAD preparation worker terminated");
    if (this.codebookWorker?.disposed)
      throw new Error("RAD codebook worker terminated");
  }
  initialize(signal) {
    signal?.throwIfAborted();
    this.assertActive();
    this.initialization ??= this.readHeaders();
    return abortable(this.initialization, signal);
  }
  async readHeaders() {
    const bytes = [];
    for (const input of this.sources)
      bytes.push(await input.source.readHeader(this.controller.signal));
    const result = await this.lodWorker.call("initializeRad", {
      bytes,
      maxSh: this.maxSh,
    });
    this.assertActive();
    this.meta = result.meta;
    let chunkBase = 0;
    result.headers.forEach((header, index) => {
      const input = this.sources[index];
      input.header = header;
      input.chunkBase = chunkBase;
      chunkBase += header.meta.chunks.length;
      const degree = Math.min(header.meta.maxSh ?? 0, this.maxSh);
      const codeCount = header.meta.count ? (header.meta.shCodeCount ?? 0) : 0;
      input.estimatedCodebookCacheBytes = codeCount * [0, 12, 32, 60][degree];
      // Packed bands plus the palettes for every supported page SH degree.
      input.estimatedCodebookBytes = codeCount * [0, 28, 80, 172][degree];
    });
    return result;
  }
  async loadChunk(index, signal) {
    signal?.throwIfAborted();
    this.assertActive();
    // The scheduler owns each page's load and requests roots before children.
    const input = this.sources[this.meta.chunks[index].source];
    const { header, source } = input;
    const localIndex = index - input.chunkBase;
    return this.pool.run(
      {
        signal,
        manager: source.options.manager,
        cancel: (worker, generation) =>
          worker.call("cancelRadLoad", { generation }),
      },
      async ({ worker, id: generation, signal, start, progress }) => {
        this.assertActive();
        let ready = this.decoderReady.get(worker);
        // A decoder created before its input's root succeeded lacks codebooks.
        if (
          ready?.input !== input ||
          ready.codebooksReady !== input.codebooksReady
        ) {
          const promise = (async () => {
            await input.codebooksReady;
            // Copies are made off-thread; both RPC hops transfer their buffers.
            const codebooks = input.codebooksReady
              ? await this.codebookWorker.call("get", {
                  source: input.chunkBase,
                })
              : undefined;
            signal.throwIfAborted();
            this.assertActive();
            await worker.call("initializeRadDecoder", {
              header,
              maxSh: this.maxSh,
              codebooks,
            });
          })().catch((error) => {
            worker.dispose(error);
            throw error;
          });
          ready = { input, codebooksReady: input.codebooksReady, promise };
          this.decoderReady.set(worker, ready);
        }
        // Resolve application callbacks here; page bodies stay inside the worker.
        let request;
        try {
          [request] = await Promise.all([
            source.prepareChunk(header, localIndex, signal),
            ready.promise,
          ]);
        } catch (error) {
          // Do not return this worker to the pool while initialization is pending.
          await ready.promise.catch(() => {});
          throw error;
        }
        signal.throwIfAborted();
        this.assertActive();
        if (typeof request.input === "string") start(request.input);
        const result = await worker.call(
          "loadRadChunk",
          { index: localIndex, generation, request },
          {
            onStatus: (status) => progress(status.loaded),
          },
        );
        this.assertActive();
        signal.throwIfAborted();
        try {
          source.acceptChunkResponse(request, result.state);
        } catch (error) {
          // A response rejected against another worker must not seed future jobs.
          worker.dispose(error);
          throw error;
        }
        if (result.codebooks) {
          this.codebookWorker ??= new WorkerRpc(new CodebookWorker());
          input.codebookBytes = result.codebooks.reduce(
            (bytes, codes) => bytes + (codes?.byteLength ?? 0),
            0,
          );
          input.codebooksReady = this.codebookWorker.call("set", {
            source: input.chunkBase,
            codebooks: result.codebooks,
          });
          // This decoder produced them and needs no reinitialization.
          ready.codebooksReady = input.codebooksReady;
          await input.codebooksReady;
          signal.throwIfAborted();
          this.assertActive();
        }
        // Uploads can start immediately; selection waits for both registrations.
        const registration = this.registerChunk(index, generation, result.tree);
        return { data: result.data, registration };
      },
    );
  }
  registerChunk(index, generation, { sourceToStorage, boundsBlocks, ...tree }) {
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
      .call("retainRadChunk", { index, generation, tree })
      .finally(() => settled(treeBytes));
    const prepared = this.preparationWorker
      .call("retainRadSelectionChunk", {
        index,
        generation,
        chunk: { sourceToStorage, boundsBlocks },
      })
      .then((bytes) => {
        if (!this.controller.signal.aborted) this.preparationBytes = bytes;
      })
      .finally(() => settled(preparationBytes));
    const registration = Promise.all([retained, prepared]).then(
      () => {},
      (error) => {
        this.releaseChunk(index, generation);
        throw error;
      },
    );
    // A cancelled load may discard its data before observing registration.
    void registration.catch(() => {});
    return registration;
  }
  getChunkUrl(index) {
    const chunk = this.meta?.chunks[index];
    const input = this.sources[chunk?.source ?? 0];
    const filename = chunk?.filename;
    const root = input.source.url;
    if (filename) return root ? new URL(filename, root).href : filename;
    return root ?? input.source.options.file?.name ?? "RAD";
  }
  async selectLod(request) {
    this.assertActive();
    const { retainedBytes, ...selection } = await this.lodWorker.call(
      "selectRadLod",
      request,
    );
    this.assertActive();
    this.selectionBytes = retainedBytes;
    return selection;
  }
  async prepareSelection(request) {
    this.assertActive();
    const result = await this.preparationWorker.call(
      "prepareRadSelection",
      request,
    );
    this.assertActive();
    return result;
  }
  releaseChunk(index, generation) {
    if (!this.lodWorker.disposed)
      void this.lodWorker
        .call("releaseRadChunk", { index, generation })
        .catch(() => {});
    if (!this.preparationWorker.disposed)
      void this.preparationWorker
        .call("releaseRadSelectionChunk", { index, generation })
        .then((bytes) => {
          if (!this.controller.signal.aborted) this.preparationBytes = bytes;
        })
        .catch(() => {});
  }
  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort(
      new DOMException("RAD loader disposed", "AbortError"),
    );
    for (const input of this.sources) {
      input.source.dispose();
      input.codebooksReady = undefined;
      input.codebookBytes = 0;
      input.estimatedCodebookCacheBytes = 0;
      input.estimatedCodebookBytes = 0;
    }
    this.pool.dispose(this.controller.signal.reason);
    for (const worker of this.pool.workers) this.decoderReady.delete(worker);
    this.lodWorker.dispose(this.controller.signal.reason);
    this.preparationWorker.dispose(this.controller.signal.reason);
    this.codebookWorker?.dispose(this.controller.signal.reason);
    this.pendingRegistrationBytes = 0;
    this.selectionBytes = 0;
    this.preparationBytes = 0;
    this.meta = undefined;
  }
}
