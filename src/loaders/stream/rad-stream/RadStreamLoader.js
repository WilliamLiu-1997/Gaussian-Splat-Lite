import { DefaultLoadingManager } from "three";
import { abortable } from "../../../runtime/abort.js";
import { RadSource } from "../../rad/RadSource.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { RadStreamWorker } from "./RadStreamWorker.js";
/** Dedicated LOD traversal with a separate bounded pool of parallel decoders. */
export class RadStreamLoader {
  constructor(options, maxConcurrentLoads = 4) {
    this.options = options;
    this.decoderReady = new WeakMap();
    this.controller = new AbortController();
    this.pending = new Map();
    this.estimatedCodebookBytes = 0;
    this.selectionBytes = 0;
    this.source = new RadSource({
      ...options,
      manager: options.manager ?? DefaultLoadingManager,
    });
    this.lodWorker = new RadStreamWorker();
    this.pool = new StreamWorkerPool(
      () => new RadStreamWorker(),
      maxConcurrentLoads,
      true,
    );
  }
  get stats() {
    return {
      cachedBytes: this.source.stats.cachedBytes,
      downloadedBytes:
        this.source.stats.downloadedBytes + this.pool.downloadedBytes,
      peakWasmMemoryBytes:
        this.pool.peakWasmMemoryBytes + this.lodWorker.peakWasmMemoryBytes,
      estimatedCodebookBytes:
        this.estimatedCodebookBytes *
        this.pool.workers.filter((worker) => !worker.disposed).length,
      bootstrapBytes: this.rootBytes?.byteLength ?? 0,
      selectionBytes: this.selectionBytes,
    };
  }
  get lodWorkerLost() {
    return this.lodWorker.disposed && !this.controller.signal.aborted;
  }
  assertActive() {
    this.controller.signal.throwIfAborted();
    if (this.lodWorker.disposed) throw new Error("RAD LOD worker terminated");
  }
  initialize(signal) {
    signal?.throwIfAborted();
    this.assertActive();
    this.initialization ??= this.source
      .readHeader(this.controller.signal)
      .then(async (bytes) => {
        const header = await this.lodWorker.call("initializeRad", {
          bytes,
        });
        this.assertActive();
        this.header = header;
        const degree = header.meta.maxSh ?? 0;
        // Float codebooks plus packed caches for every degree up to maxSh.
        this.estimatedCodebookBytes =
          (header.meta.shCodeCount ?? 0) * [0, 52, 144, 292][degree];
        return header;
      });
    return abortable(this.initialization, signal);
  }
  async loadChunk(index, signal, onDecoded) {
    signal?.throwIfAborted();
    this.assertActive();
    let pending = this.pending.get(index);
    if (!pending || pending.signal?.aborted) {
      const task = this.loadChunkInternal(index, signal, onDecoded).finally(
        () => {
          if (this.pending.get(index) === pending) this.pending.delete(index);
        },
      );
      pending = { task, signal };
      this.pending.set(index, pending);
    }
    // Keep cancelled synchronous work reserved until its worker reply arrives.
    return pending.task;
  }
  async loadChunkInternal(index, signal, onDecoded) {
    const header = await this.initialize(signal);
    // Codebooks live in chunk zero. Its initial geometry is held only until the
    // caller requests that page, avoiding a duplicate fetch during races.
    this.rootReady ??= this.decode(
      0,
      header,
      this.controller.signal,
      index === 0 ? onDecoded : undefined,
    )
      .then((data) => {
        this.initialRoot = data;
      })
      .catch((error) => {
        this.rootReady = undefined;
        throw error;
      });
    await abortable(this.rootReady, signal);
    if (index === 0 && this.initialRoot) {
      const root = this.initialRoot;
      this.initialRoot = undefined;
      return root;
    }
    return this.decode(index, header, signal, onDecoded);
  }
  async decode(index, header, signal, onDecoded) {
    this.assertActive();
    return this.pool.run(
      {
        signal,
        manager: this.options.manager ?? DefaultLoadingManager,
        cancel: (worker, generation) =>
          worker.call("cancelRadLoad", { generation }),
      },
      async ({ worker, id: generation, signal, release, start, progress }) => {
        this.assertActive();
        let ready = this.decoderReady.get(worker);
        if (!ready) {
          ready = worker
            .call("initializeRadDecoder", {
              header,
              rootBytes: this.rootBytes?.slice(),
            })
            .catch((error) => {
              worker.dispose(error);
              throw error;
            });
          this.decoderReady.set(worker, ready);
        }
        // Resolve application callbacks here; page bodies stay inside the worker.
        const [request] = await Promise.all([
          this.source.prepareChunk(header, index, signal),
          ready,
        ]);
        signal.throwIfAborted();
        this.assertActive();
        if (typeof request.input === "string") start(request.input);
        const result = await worker.call(
          "loadRadChunk",
          { index, generation, request },
          {
            onStatus: (status) => progress(status.loaded),
          },
        );
        this.assertActive();
        signal.throwIfAborted();
        try {
          this.source.acceptChunkResponse(request, result.state);
        } catch (error) {
          // A response rejected against another worker must not seed future jobs.
          worker.dispose(error);
          throw error;
        }
        const registration = this.lodWorker.call("retainRadChunk", {
          index,
          generation,
          tree: result.tree,
        });
        // Registration owns no decoder state; release the slot before awaiting it.
        release();
        try {
          onDecoded?.();
          await registration;
          this.assertActive();
          signal.throwIfAborted();
          if (result.rootBytes) this.rootBytes = result.rootBytes;
          return result.data;
        } catch (error) {
          // A throwing callback must still observe registration before rollback.
          await registration.catch(() => {});
          this.releaseChunk(index, generation);
          throw error;
        }
      },
    );
  }
  getChunkUrl(index) {
    const filename = this.header?.meta.chunks[index]?.filename;
    const root = this.source.url;
    if (filename) return root ? new URL(filename, root).href : filename;
    return root ?? this.options.file?.name ?? "RAD";
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
    const result = await this.lodWorker.call("prepareRadSelection", request);
    this.assertActive();
    return result;
  }
  releaseChunk(index, generation) {
    if (index === 0 && generation === undefined) this.initialRoot = undefined;
    if (!this.lodWorker.disposed)
      void this.lodWorker
        .call("releaseRadChunk", { index, generation })
        .catch(() => {});
  }
  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort(
      new DOMException("RAD loader disposed", "AbortError"),
    );
    this.source.dispose();
    this.pool.dispose(this.controller.signal.reason);
    this.lodWorker.dispose(this.controller.signal.reason);
    this.pending.clear();
    this.initialRoot = undefined;
    this.rootBytes = undefined;
    this.estimatedCodebookBytes = 0;
    this.selectionBytes = 0;
    this.header = undefined;
  }
}
