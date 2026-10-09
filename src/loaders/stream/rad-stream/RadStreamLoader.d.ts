import type { RadSource, RadSourceOptions } from "../../rad/RadSource.js";
import type { RadHeader, RadStreamChunk } from "../../rad/radFormat.js";
import type { RadSelectionRequest } from "./RadSelectionState.js";
import type { prepareRadSelection } from "./prepareRadSelection.js";
import type { RadStreamSelection } from "./radFade.js";
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
export declare class RadStreamLoader {
  private readonly options;
  readonly source: RadSource;
  private readonly lodWorker;
  private readonly pool;
  private readonly decoderReady;
  private readonly controller;
  private initialization?;
  private header?;
  private rootReady?;
  private initialRoot?;
  private rootBytes?;
  private pending;
  private estimatedCodebookBytes;
  private selectionBytes;
  constructor(options: RadStreamLoaderOptions, maxConcurrentLoads?: number);
  get stats(): {
    cachedBytes: number;
    downloadedBytes: number;
    peakWasmMemoryBytes: number;
    estimatedCodebookBytes: number;
    bootstrapBytes: number;
    selectionBytes: number;
  };
  get lodWorkerLost(): boolean;
  private assertActive;
  initialize(signal?: AbortSignal): Promise<RadHeader>;
  loadChunk(
    index: number,
    signal?: AbortSignal,
    onDecoded?: () => void,
  ): Promise<RadStreamChunk>;
  private loadChunkInternal;
  private decode;
  getChunkUrl(index: number): string;
  selectLod(request: RadSelectionRequest): Promise<RadStreamSelection>;
  prepareSelection(
    request: Parameters<typeof prepareRadSelection>[0],
  ): Promise<{
    selection: {
      indices: Uint32Array;
      wantedChunks: Uint32Array;
      touchedChunks: Uint32Array;
      selectionId: number;
      changedChunks: Uint32Array;
    };
    fade: boolean;
    pools: import("../../../data/RadPagedSplats.js").RadPreparedSelection[];
  }>;
  releaseChunk(index: number, generation?: number): void;
  dispose(): void;
}
