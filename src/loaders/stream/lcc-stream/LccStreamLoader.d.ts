import type { ReorderedSplatResult } from "../../../data/defines.js";
import type { StreamRequestOptions } from "../streamOptions.js";
import type { LccStreamWorker } from "./LccStreamWorker.js";
import type { LccBoundsUpdate, LccSelectionRequest } from "./lccSelection.js";
import type { LccFileInfo, LccPublishedTable } from "./workerHandlers.js";
export type LccStreamLoaderOptions = StreamRequestOptions & {
  /** URL of the scene's .lcc (meta.lcc) or .lcc2 manifest. */
  url: string;
};
/** LCC file names next to the manifest, in the casing the export uses. */
export type LccCompanions = {
  index: string;
  data: string;
  sh: string;
  environment: string;
};
/** Main-thread node table; LCC adds its companions and dequantization ranges. */
export type LccSceneTable = LccPublishedTable & {
  companions?: LccCompanions;
  hasSh?: boolean;
  ranges?: Float32Array;
  environmentRanges?: Float32Array;
};
/** A decoded LCC2 file retained by its worker; extraction transfers node data. */
export declare class LccFileSource {
  private readonly worker;
  private readonly id;
  readonly info: LccFileInfo;
  private readonly onRelease;
  private released;
  constructor(
    worker: LccStreamWorker,
    id: number,
    info: LccFileInfo,
    onRelease: () => void,
  );
  get alive(): boolean;
  extract(
    ranges: { start: number; count: number }[],
  ): Promise<ReorderedSplatResult[]>;
  dispose(): void;
}
/** Dedicated LOD worker plus bounded decoders; LCC2 files stay with their decoder. */
export declare class LccStreamLoader {
  private readonly options;
  private readonly controller;
  private readonly pool;
  private readonly lodWorker;
  private initialization?;
  /** Base URL of the manifest response; companions resolve against it. */
  baseUrl: string;
  private downloadedBytes;
  private retainedIndexBytes;
  table?: LccSceneTable;
  constructor(
    options: LccStreamLoaderOptions,
    maxConcurrentLoads: number,
    onChange: () => void,
  );
  private get manager();
  get stats(): {
    downloadedBytes: number;
    peakWasmMemoryBytes: number;
    retainedIndexBytes: number;
  };
  private assertActive;
  initialize(signal?: AbortSignal): Promise<LccSceneTable>;
  /** Resolve a scene file through the manager; only same-origin requests carry credentials. */
  private resolve;
  /** Small whole files on the main thread; returns undefined for HTTP 404. */
  private fetchFile;
  private readIndex;
  selectLod(request: LccSelectionRequest): Promise<Uint32Array>;
  /** Tighten selection bounds from loaded data; failures only lose precision. */
  setBounds(updates: LccBoundsUpdate[]): void;
  private run;
  /** One LCC node, decoded and reordered in a pool worker. */
  loadNode(node: number, signal?: AbortSignal): Promise<ReorderedSplatResult>;
  /** environment.bin, or undefined when the scene has none. */
  loadEnvironment(
    signal?: AbortSignal,
  ): Promise<ReorderedSplatResult | undefined>;
  /** Decode an LCC2 splat file into a retained worker cache. */
  loadFile(file: number, signal?: AbortSignal): Promise<LccFileSource>;
  dispose(): void;
}
