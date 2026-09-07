import { DefaultLoadingManager } from "three";
import { Splats, type SplatsOptions } from "../../data/Splats";
import { getAssetBaseUrl } from "../assetUrl";
import type { SplatLoadStatus } from "../loadTypes";
import type { SogStreamSchedulerOptions } from "./SogStreamScheduler";
import { SogStreamWorker } from "./SogStreamWorker";
import type { SogChunkInfo } from "./workerHandlers";

/** A handle to packed data that stays in its decoding worker. */
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
    const results = await this.worker.call("extractSogRegions", {
      id: this.id,
      ranges,
    });
    return results.map((data) => new Splats(data as SplatsOptions));
  }

  dispose() {
    if (this.released) return;
    this.released = true;
    if (!this.worker.disposed)
      void this.worker.call("releaseSogChunk", { id: this.id }).catch(() => {});
    this.onRelease();
  }
}

/** Dedicated streaming workers share the RPC transport and decoder. Each slot
 * runs one chunk load at a time and retains its cache between loads. */
export class SogStreamLoader {
  private slots: {
    worker: SogStreamWorker;
    busy: boolean;
    sources: Set<SogChunkSource>;
  }[] = [];
  private nextId = 0;
  private disposed = false;

  constructor(
    private readonly options: SogStreamSchedulerOptions,
    private readonly onChange: () => void,
  ) {}

  async parseIndex(bytes: ArrayBuffer, baseUrl: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("Streaming loader disposed");
    const worker = new SogStreamWorker();
    try {
      return await worker.call("parseSogIndex", { bytes, baseUrl }, { signal });
    } finally {
      worker.dispose();
    }
  }

  async load(url: string, count: number, baseUrl: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("Streaming loader disposed");
    let slot = this.slots.find((candidate) => !candidate.busy);
    if (!slot) {
      slot = {
        worker: new SogStreamWorker(() => queueMicrotask(this.onChange)),
        busy: false,
        sources: new Set(),
      };
      this.slots.push(slot);
    } else if (slot.worker.disposed) {
      slot.sources.clear();
      slot.worker = new SogStreamWorker(() => queueMicrotask(this.onChange));
    }
    slot.busy = true;
    const { worker } = slot;
    const id = ++this.nextId;
    const release = () => {
      if (!worker.disposed)
        void worker.call("releaseSogChunk", { id }).catch(() => {});
    };
    signal.addEventListener("abort", release, { once: true });
    const manager = this.options.manager ?? DefaultLoadingManager;
    const resolveBase =
      typeof document === "undefined" ? baseUrl : document.baseURI;
    let resolved: string | undefined;
    let custom: Splats | undefined;
    try {
      let info: SogChunkInfo;
      if (this.options.loadChunk) {
        custom = await this.options.loadChunk(url, signal);
        signal.throwIfAborted();
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
          new URL(baseUrl).origin;
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
            },
          },
        );
      }
      signal.throwIfAborted();
      if (this.disposed) throw new Error("Streaming loader disposed");
      const owner = slot;
      const source = new SogChunkSource(worker, id, info, () => {
        owner.sources.delete(source);
        if (!owner.sources.size && !owner.busy) worker.dispose();
      });
      slot.sources.add(source);
      return source;
    } catch (error) {
      release();
      if (resolved) manager.itemError(resolved);
      throw error;
    } finally {
      custom?.dispose();
      signal.removeEventListener("abort", release);
      slot.busy = false;
      if (!slot.sources.size) worker.dispose();
      if (resolved) manager.itemEnd(resolved);
    }
  }

  dispose() {
    this.disposed = true;
    for (const { worker } of this.slots) worker.dispose();
    this.slots = [];
  }
}
