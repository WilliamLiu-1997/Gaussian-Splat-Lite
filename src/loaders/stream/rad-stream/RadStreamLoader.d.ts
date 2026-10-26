import type { RadSourceOptions } from "../../rad/RadSource.js";
import type {
  RadChunkRange,
  RadHeader,
  RadMeta,
  RadStreamChunk,
} from "../../rad/radFormat.js";
import type { RadSelectionRequest } from "./RadSelectionState.js";
import type {
  RadSelectionPreparation,
  prepareRadSelection,
} from "./prepareRadSelection.js";
import type { RadStreamSelection } from "./radFade.js";
export type RadStreamSourceOptions = Pick<
  RadSourceOptions,
  | "url"
  | "file"
  | "fileBytes"
  | "resolveFile"
  | "manager"
  | "requestHeader"
  | "withCredentials"
>;
export type RadStreamLoaderOptions = RadStreamSourceOptions &
  (
    | { sources?: never }
    | {
        url?: never;
        file?: never;
        fileBytes?: never;
        /** Inputs in the scheduler group's coordinates. */
        sources: readonly RadStreamSourceOptions[];
      }
  );
/** Combined directory; each chunk has an explicit span and its input index. */
export type RadStreamMetadata = Pick<
  RadMeta,
  "count" | "lodTree" | "chunkSize"
> & {
  /** Highest input SH degree, capped by the scheduler's storage limit. */
  maxSh: number;
  chunks: (RadChunkRange & { base: number; count: number; source: number })[];
};
/** Separate traversal and display preparation workers, plus bounded page decoders. */
export declare class RadStreamLoader {
  private readonly maxSh;
  private readonly onRegistrationSettled;
  private readonly sources;
  private readonly lodWorker;
  private readonly preparationWorker;
  private readonly pool;
  private readonly decoderReady;
  private readonly controller;
  private initialization?;
  private meta?;
  readonly pendingRegistrationBytes: number;
  private selectionBytes;
  private preparationBytes;
  constructor(
    options: RadStreamLoaderOptions,
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
  initialize(signal?: AbortSignal): Promise<{
    meta: RadStreamMetadata;
    /** Input headers, in source order. */
    headers: RadHeader[];
    /** Root chunk of each nonempty input. */
    roots: number[];
  }>;
  private readHeaders;
  loadChunk(
    index: number,
    signal?: AbortSignal,
  ): Promise<{ data: RadStreamChunk; registration: Promise<void> }>;
  private registerChunk;
  getChunkUrl(index: number): string;
  selectLod(request: RadSelectionRequest): Promise<RadStreamSelection>;
  prepareSelection(
    request: Parameters<typeof prepareRadSelection>[0],
  ): Promise<RadSelectionPreparation>;
  releaseChunk(index: number, generation?: number): void;
  dispose(): void;
}
