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

/** Dedicated LOD traversal with a separate bounded pool of parallel decoders. */
export class RadStreamLoader {
  readonly source: RadSource;
  private readonly lodWorker: RadStreamWorker;
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
  private nextDecodeGeneration = 0;
  private estimatedCodebookBytes = 0;

  constructor(
    private readonly options: RadStreamLoaderOptions,
    maxConcurrentLoads = 4,
  ) {
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
      ...this.source.stats,
      peakWasmMemoryBytes:
        this.pool.peakWasmMemoryBytes + this.lodWorker.peakWasmMemoryBytes,
      estimatedCodebookBytes:
        this.estimatedCodebookBytes *
        this.pool.workers.filter((worker) => !worker.disposed).length,
      bootstrapBytes: this.rootBytes?.byteLength ?? 0,
    };
  }

  private assertActive() {
    this.controller.signal.throwIfAborted();
    if (this.lodWorker.disposed) throw new Error("RAD LOD worker terminated");
  }

  initialize(signal?: AbortSignal) {
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
        this.estimatedCodebookBytes =
          (header.meta.shCodeCount ?? 0) * [0, 36, 96, 180][degree];
        return header;
      });
    return abortable(this.initialization, signal);
  }

  async loadChunk(
    index: number,
    signal?: AbortSignal,
    onDecoded?: () => void,
  ): Promise<RadChunkData> {
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

  private async loadChunkInternal(
    index: number,
    signal?: AbortSignal,
    onDecoded?: () => void,
  ): Promise<RadChunkData> {
    const header = await this.initialize(signal);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= header.meta.chunks.length
    )
      throw new Error(`RAD: missing chunk ${index}`);
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

  private async decode(
    index: number,
    header: RadHeader,
    signal?: AbortSignal,
    onDecoded?: () => void,
  ) {
    this.assertActive();
    const generation = ++this.nextDecodeGeneration;
    const lease = await this.pool.acquire(signal);
    const worker = lease.worker;
    let retained = false;
    try {
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
      // Fetch and decoder setup can overlap, but each slot decodes one page.
      const [bytes] = await Promise.all([
        this.source.readChunk(header, index, signal),
        ready,
      ]);
      signal?.throwIfAborted();
      this.assertActive();
      const rootBytes =
        index === 0 && this.estimatedCodebookBytes ? bytes.slice() : undefined;
      // Keep decoder codebooks warm when a page is cancelled. Root bytes also
      // seed replacement decoders after a worker failure, even at concurrency 1.
      const result = await worker.call("decodeRadChunk", {
        index,
        bytes,
      });
      this.assertActive();
      signal?.throwIfAborted();
      const registration = this.lodWorker.call("retainRadChunk", {
        index,
        generation,
        tree: result.tree,
      });
      // Tree registration owns no decoder state. Its page stays reserved while
      // the decoder starts another job within the scheduler's pending budget.
      lease.release();
      onDecoded?.();
      await registration;
      retained = true;
      // Publish only after the complete tree is available to LOD traversal.
      this.assertActive();
      signal?.throwIfAborted();
      if (rootBytes) this.rootBytes = rootBytes;
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

  async selectLod(
    request: RadLodRequest,
    previous?: Uint32Array,
    fade = false,
  ) {
    this.assertActive();
    // Keep the live cut on the main thread; transfer a snapshot for comparison
    // and fade merging so large LOD changes do not block the next frame.
    return this.lodWorker.call("selectRadLod", {
      ...request,
      previous: previous?.slice(),
      fade,
    });
  }

  releaseChunk(index: number, generation?: number) {
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
    this.header = undefined;
  }
}
