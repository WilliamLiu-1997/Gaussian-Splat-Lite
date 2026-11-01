import type { Matrix4 } from "three";
import type { RadSourceOptions } from "../../rad/RadSource.js";
import type {
  RadChunkRange,
  RadHeader,
  RadStreamChunk,
} from "../../rad/radFormat.js";
import type { RadSelectionRequest } from "./RadSelectionState.js";
import type {
  RadSelectionPreparation,
  prepareRadMerge,
  prepareRadSelection,
} from "./prepareRadSelection.js";
import type { RadStreamSelection } from "./radFade.js";
import type { RadSourceCut } from "./radLod.js";
export type RadStreamSourceOptions = Pick<
  RadSourceOptions,
  | "url"
  | "file"
  | "fileBytes"
  | "resolveFile"
  | "manager"
  | "requestHeader"
  | "withCredentials"
> & {
  /** Model-to-group transform; identity when omitted. Change with setSourceSettings(). */
  transform?: Matrix4;
};
export type RadStreamSourceMetadata = {
  header: RadHeader & {
    meta: { chunks: (RadChunkRange & { base: number; count: number })[] };
  };
};
/** Separate traversal and display preparation workers, plus bounded page decoders. */
export declare class RadStreamLoader {
  private readonly maxSh;
  private readonly onRegistrationSettled;
  private readonly sources;
  private readonly lodWorker;
  private readonly preparationWorker;
  private codebookWorker?;
  private readonly pool;
  private readonly decoderReady;
  private readonly controller;
  private downloadedBytes;
  readonly pendingRegistrationBytes: number;
  private selectionBytes;
  private preparationBytes;
  constructor(
    maxConcurrentLoads: number,
    maxSh: number,
    onRegistrationSettled: () => void,
  );
  get stats(): {
    cachedBytes: number;
    downloadedBytes: number;
    peakWasmMemoryBytes: number;
    estimatedCodebookBytes: number;
    codebookCacheBytes: number;
    selectionBytes: number;
  };
  /** Reserve per-input packed codebooks and each worker's current decoder. */
  get residentCpuOverheadBytes(): number;
  get selectionWorkerLost(): boolean;
  private assertActive;
  addSource(
    id: number,
    options: RadStreamSourceOptions,
    signal?: AbortSignal,
  ): Promise<RadStreamSourceMetadata>;
  removeSource(id: number): void;
  private readSource;
  loadChunk(
    sourceId: number,
    index: number,
    signal?: AbortSignal,
  ): Promise<{ data: RadStreamChunk; registration: Promise<void> }>;
  private registerChunk;
  getChunkUrl(sourceId: number, index: number): string;
  /** Await a worker reply that is discarded once the loader is disposed. */
  private call;
  /** Request without waiting; a live reply may report retained bytes. */
  private send;
  selectLod(request: RadSelectionRequest): Promise<RadStreamSelection>;
  prepareSelection(
    request: Parameters<typeof prepareRadSelection>[0],
  ): Promise<RadSelectionPreparation>;
  snapshotSelection(id: number): Promise<RadSourceCut[]>;
  prepareMerge(
    request: Parameters<typeof prepareRadMerge>[0],
  ): Promise<ReturnType<typeof prepareRadMerge>>;
  /** Allocate a fixed eight-page pool off the main thread. */
  allocateStorage(numSh: number): Promise<Uint32Array<ArrayBuffer>[]>;
  releaseChunk(index: number, source: number, generation?: number): void;
  dispose(): void;
}
