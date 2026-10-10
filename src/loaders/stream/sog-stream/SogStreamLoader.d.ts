import type { Splats } from "../../../data/Splats.js";
import type { StreamRequestOptions } from "../streamOptions.js";
import type { SogStreamWorker } from "./SogStreamWorker.js";
import type { SogLodMetadata } from "./sogLod.js";
import type { SogView } from "./sogVisibility.js";
import type { SogChunkInfo } from "./workerHandlers.js";
export type SogStreamLoaderOptions = StreamRequestOptions & {
  url: string;
  /** Returns owned data in file order, or with a complete source ID map. */
  loadChunk?: (url: string, signal: AbortSignal) => Promise<Splats>;
};
/** A retained worker cache; extraction transfers owned packed arrays to the caller. */
export declare class SogChunkSource {
  private readonly worker;
  private readonly id;
  readonly info: SogChunkInfo;
  private readonly onRelease;
  private released;
  constructor(
    worker: SogStreamWorker,
    id: number,
    info: SogChunkInfo,
    onRelease: () => void,
  );
  get alive(): boolean;
  extract(
    ranges: {
      start: number;
      count: number;
    }[],
  ): Promise<import("../../../data/defines.js").ReorderedSplatResult[]>;
  dispose(): void;
}
/** Dedicated LOD worker, bounded decoders and retained chunk cache handles. */
export declare class SogStreamLoader {
  private readonly options;
  private readonly lodWorker;
  private readonly pool;
  private readonly controller;
  private initialization?;
  private baseUrl;
  private downloadedBytes;
  private retainedIndexBytes;
  constructor(
    options: SogStreamLoaderOptions,
    maxConcurrentLoads: number,
    onChange: () => void,
  );
  get stats(): {
    downloadedBytes: number;
    peakWasmMemoryBytes: number;
    retainedIndexBytes: number;
  };
  private assertActive;
  initialize(signal?: AbortSignal): Promise<SogLodMetadata>;
  private readIndex;
  selectLod(view: SogView, budget: number): Promise<Uint32Array>;
  load(
    url: string,
    count: number,
    signal: AbortSignal,
  ): Promise<SogChunkSource>;
  dispose(): void;
}
