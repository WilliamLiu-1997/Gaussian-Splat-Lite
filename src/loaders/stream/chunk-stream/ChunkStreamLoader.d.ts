import type { Matrix4 } from "three";
import type { Splats } from "../../../data/Splats.js";
import type { ReorderedSplatResult } from "../../../data/defines.js";
import type { ShPalette } from "../../../data/shPalette.js";
import type { StreamRequestOptions } from "../streamOptions.js";
import type { ChunkStreamWorker } from "./ChunkStreamWorker.js";
import type { LodTreeIndex, LodTreeRequest } from "./lodTree.js";
import type { ChunkInfo } from "./workerHandlers.js";

export type ChunkStreamSourceOptions = StreamRequestOptions & {
  url: string;
  /** Model-to-group transform; identity when omitted. Change with setSourceSettings(). */
  transform?: Matrix4;
  /** Load this input's environment; defaults to true. Change with setSourceSettings(). */
  environment?: boolean;
  /** Base LOD distance in world units; inherits the scheduler's value when omitted. Must be finite and positive. */
  lodBaseDistance?: number;
  /** Distance multiplier between LOD levels; inherits the scheduler's value when omitted. Must be finite and at least 1. */
  lodMultiplier?: number;
  /** Returns owned Splats; the loader restores their decoded record order before slicing. */
  loadChunk?: (url: string, signal: AbortSignal) => Promise<Splats>;
};
export type ChunkStreamMetadata = Omit<LodTreeIndex, "nodeBounds"> & {
  hasData: boolean;
  /** Application-defined JSON from this input's lod-meta.json extras. */
  extra?: unknown;
  /** Stable global node and chunk offsets, never reused after removal. */
  nodeBase: number;
  fileBase: number;
  /** Global environment chunk ID, or -1. */
  environment: number;
  /** Stable batch slot per node, prepared in the worker. */
  batchStarts: Float64Array;
  /** Aligned batch capacity per local chunk; environments are sized on load. */
  batchCapacities: Float64Array;
  retainedIndexBytes: number;
};
/** A retained worker cache; extraction transfers owned packed arrays to the caller. */
export declare class ChunkSource {
  private readonly worker;
  private readonly id;
  readonly info: ChunkInfo;
  readonly palette?: ShPalette;
  private readonly onRelease;
  private released;
  constructor(
    worker: ChunkStreamWorker,
    id: number,
    info: ChunkInfo,
    onRelease: () => void,
  );
  get alive(): boolean;
  extract(
    ranges: {
      start: number;
      count: number;
    }[],
  ): Promise<ReorderedSplatResult[]>;
  dispose(): void;
}
/** Dedicated LOD worker, bounded decoders and retained chunk cache handles. */
export declare class ChunkStreamLoader {
  private readonly format;
  private readonly maxSh;
  private readonly blindData;
  private readonly lodWorker;
  private readonly pool;
  private readonly controller;
  private readonly sources;
  private downloadedBytes;
  private retainedIndexBytes;
  constructor(
    maxConcurrentLoads: number,
    maxSh: number,
    onChange: () => void,
    format?: "sog" | "lcc2",
    blindData?: boolean,
  );
  get stats(): {
    downloadedBytes: number;
    peakWasmMemoryBytes: number;
    retainedIndexBytes: number;
  };
  private assertActive;
  addSource(
    id: number,
    options: ChunkStreamSourceOptions,
    signal: AbortSignal,
  ): Promise<ChunkStreamMetadata>;
  removeSource(id: number): void;
  private readIndex;
  selectLod(request: LodTreeRequest): Promise<Uint32Array>;
  load(
    sourceId: number,
    url: string,
    count: number,
    signal: AbortSignal,
  ): Promise<ChunkSource>;
  dispose(): void;
}
