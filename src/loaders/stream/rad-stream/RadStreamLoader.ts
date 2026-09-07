import { DefaultLoadingManager } from "three";
import { abortable } from "../../../runtime/abort";
import { RadSource, type RadSourceOptions } from "../../rad/RadSource";
import type { RadChunkData, RadHeader } from "../../rad/radFormat";
import { StreamWorkerPool } from "../StreamWorkerPool";
import { RadStreamWorker } from "./RadStreamWorker";
import type { RadLodRequest } from "./radLod";

export type RadStreamLoaderOptions = Pick<
  RadSourceOptions,
  | "url"
  | "file"
  | "fileBytes"
  | "resolveFile"
  | "manager"
  | "requestHeader"
  | "withCredentials"
>;

/** Bounded parallel decoders; the first worker also owns LOD traversal. */
export class RadStreamLoader {
  readonly source: RadSource;
  private readonly worker: RadStreamWorker;
  private readonly pool: StreamWorkerPool<RadStreamWorker>;
  private readonly decoderReady = new WeakMap<RadStreamWorker, Promise<void>>();
  private readonly controller = new AbortController();
  private initialization?: Promise<RadHeader>;
  private header?: RadHeader;
  private rootReady?: Promise<void>;
  private initialRoot?: RadChunkData;
  private rootBytes?: Uint8Array;
  private pending = new Map<
    number,
    { task: Promise<RadChunkData>; signal?: AbortSignal }
  >();
  private readonly retained = new Map<
    number,
    { bytes: number; generation: number }
  >();
  private nextDecodeGeneration = 0;
  private estimatedCodebookBytes = 0;

  constructor(
    private readonly options: RadStreamLoaderOptions,
    private readonly maxConcurrentLoads = 4,
  ) {
    this.source = new RadSource({
      ...options,
      manager: options.manager ?? DefaultLoadingManager,
    });
    this.worker = new RadStreamWorker();
    this.pool = new StreamWorkerPool(
      () => new RadStreamWorker(),
      maxConcurrentLoads,
      true,
      this.worker,
    );
    this.decoderReady.set(this.worker, Promise.resolve());
  }

  get stats() {
    return {
      ...this.source.stats,
      retainedTreeBytes: [...this.retained.values()].reduce(
        (sum, { bytes }) => sum + bytes,
        0,
      ),
      peakWasmMemoryBytes: this.pool.peakWasmMemoryBytes,
      estimatedCodebookBytes:
        this.estimatedCodebookBytes *
        this.pool.workers.filter((worker) => !worker.disposed).length,
      bootstrapBytes: this.rootBytes?.byteLength ?? 0,
    };
  }

  initialize(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.controller.signal.throwIfAborted();
    this.initialization ??= this.source
      .readHeader(this.controller.signal)
      .then(async (bytes) => {
        const header = await this.worker.call("initializeRad", {
          bytes,
        });
        this.controller.signal.throwIfAborted();
        this.header = header;
        const degree = header.meta.maxSh ?? 0;
        this.estimatedCodebookBytes =
          (header.meta.shCodeCount ?? 0) * [0, 36, 96, 180][degree];
        return header;
      });
    return abortable(this.initialization, signal);
  }

  loadChunk(index: number, signal?: AbortSignal): Promise<RadChunkData> {
    signal?.throwIfAborted();
    this.controller.signal.throwIfAborted();
    let pending = this.pending.get(index);
    if (!pending || pending.signal?.aborted) {
      const task = this.loadChunkInternal(index, signal).finally(() => {
        if (this.pending.get(index) === pending) this.pending.delete(index);
      });
      pending = { task, signal };
      this.pending.set(index, pending);
    }
    return abortable(pending.task, signal);
  }

  private async loadChunkInternal(
    index: number,
    signal?: AbortSignal,
  ): Promise<RadChunkData> {
    signal?.throwIfAborted();
    const header = await this.initialize(signal);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= header.meta.chunks.length
    )
      throw new Error(`RAD: missing chunk ${index}`);
    // Codebooks live in chunk zero. Its initial geometry is held only until the
    // caller requests that page, avoiding a duplicate fetch during races.
    this.rootReady ??= this.decode(0, header, this.controller.signal)
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
    return this.decode(index, header, signal);
  }

  private async decode(index: number, header: RadHeader, signal?: AbortSignal) {
    const generation = ++this.nextDecodeGeneration;
    const lease = await this.pool.acquire(signal);
    const worker = lease.worker;
    let retained = false;
    try {
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
      // Fetch and decoder setup can overlap, but each slot decodes one page.
      const [bytes] = await Promise.all([
        this.source.readChunk(header, index, signal),
        ready,
      ]);
      signal?.throwIfAborted();
      this.controller.signal.throwIfAborted();
      const rootBytes =
        index === 0 &&
        this.estimatedCodebookBytes &&
        this.maxConcurrentLoads > 1
          ? bytes.slice()
          : undefined;
      // Cancellation must not terminate the tree owner or discard codebooks.
      const result = await worker.call("decodeRadChunk", {
        index,
        bytes,
        generation,
        retain: worker === this.worker,
      });
      retained = worker === this.worker;
      this.controller.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (result.tree) {
        await this.worker.call("retainRadChunk", {
          index,
          generation,
          tree: result.tree,
        });
        retained = true;
      }
      // Publish only after the complete tree is available to LOD traversal.
      this.controller.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (rootBytes) this.rootBytes = rootBytes;
      this.retained.set(index, {
        bytes: result.data.retainedTreeBytes ?? 0,
        generation,
      });
      return result.data;
    } catch (error) {
      if (retained) this.releaseChunk(index, generation);
      throw error;
    } finally {
      lease.release();
    }
  }

  getChunkUrl(index: number) {
    const filename = this.header?.meta.chunks[index]?.filename;
    const root = this.source.url;
    if (filename) return root ? new URL(filename, root).href : filename;
    return root ?? (this.options.file as File | undefined)?.name ?? "RAD";
  }

  selectLod(request: RadLodRequest, previous?: Uint32Array, fade = false) {
    this.controller.signal.throwIfAborted();
    // Keep the live cut on the main thread; transfer a snapshot for comparison
    // and fade merging so large LOD changes do not block the next frame.
    return this.worker.call("selectRadLod", {
      ...request,
      previous: previous?.slice(),
      fade,
    });
  }

  releaseChunk(index: number, generation?: number) {
    if (
      generation === undefined ||
      this.retained.get(index)?.generation === generation
    )
      this.retained.delete(index);
    if (index === 0 && generation === undefined) this.initialRoot = undefined;
    if (!this.worker.disposed)
      void this.worker
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
    this.pending.clear();
    this.retained.clear();
    this.initialRoot = undefined;
    this.rootBytes = undefined;
    this.estimatedCodebookBytes = 0;
    this.header = undefined;
  }
}
