import type { ReorderedSplatResult } from "../../../data/defines.js";
import type { StreamRequestOptions } from "../streamOptions.js";
import type { LccStreamWorker } from "./LccStreamWorker.js";
import type { LccChunk, LccStreamIndex } from "./lccIndex.js";
import type { LccSelectionRequest } from "./lccSelection.js";
import type { LccChunkInfo, LccRange, LccRequest } from "./workerHandlers.js";
export type LccStreamLoaderOptions = StreamRequestOptions & { url: string };
export declare class LccChunkSource {
  private readonly worker;
  private readonly id;
  readonly info: LccChunkInfo;
  private readonly release;
  private released;
  constructor(
    worker: LccStreamWorker,
    id: number,
    info: LccChunkInfo,
    release: () => void,
  );
  get alive(): boolean;
  extract(ranges: LccRange[]): Promise<ReorderedSplatResult[]>;
  dispose(): void;
}
export declare class LccStreamLoader {
  private readonly options;
  private readonly manager;
  private readonly origin;
  private readonly controller;
  private readonly resourceVersions;
  private readonly pool;
  private readonly lodWorker;
  private downloadedBytes;
  private retainedIndexBytes;
  private baseUrl?;
  private initialization?;
  private index?;
  constructor(
    options: LccStreamLoaderOptions,
    concurrency: number,
    onChange: () => void,
  );
  get stats(): {
    downloadedBytes: number;
    peakWasmMemoryBytes: number;
    retainedIndexBytes: number;
  };
  resolve(path: string): LccRequest;
  initialize(
    signal?: AbortSignal,
  ): Promise<LccStreamIndex & { retainedIndexBytes: number }>;
  private readIndex;
  selectLod(request: LccSelectionRequest): Promise<Uint32Array>;
  load(chunk: LccChunk, signal: AbortSignal): Promise<LccChunkSource>;
  private acceptResources;
  dispose(): void;
}
