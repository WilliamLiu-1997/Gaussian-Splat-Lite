import type { Matrix4 } from "three";
import type { Splats } from "../../../data/Splats.js";
import type { StreamRequestOptions } from "../streamOptions.js";
import type { SogStreamWorker } from "./SogStreamWorker.js";
import type { SogLodIndex } from "./sogLod.js";
import type { SogLodRequest } from "./sogVisibility.js";
import type { SogChunkInfo } from "./workerHandlers.js";
export type SogStreamSourceOptions = StreamRequestOptions & {
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
export type SogStreamLoaderOptions = {
  /** Nonempty list of inputs, fixed at creation. */
  sources: readonly SogStreamSourceOptions[];
};
export type SogStreamMetadata = Omit<
  SogLodIndex,
  "bounds" | "leafBounds" | "lodLevels"
> & {
  /** Input index for each chunk, including environments. */
  sourceIndices: Uint32Array;
  /** Six bounds values per input, in its own coordinates. */
  sourceBounds: Float64Array;
  /** Each input's environment chunk, or -1. */
  environments: Int32Array;
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
  private readonly maxSh;
  private readonly lodWorker;
  private readonly pool;
  private readonly controller;
  private initialization?;
  private readonly sources;
  private downloadedBytes;
  private retainedIndexBytes;
  constructor(
    options: SogStreamLoaderOptions,
    maxConcurrentLoads: number,
    maxSh: number,
    onChange: () => void,
  );
  get stats(): {
    downloadedBytes: number;
    peakWasmMemoryBytes: number;
    retainedIndexBytes: number;
  };
  private assertActive;
  initialize(signal?: AbortSignal): Promise<SogStreamMetadata>;
  private readIndices;
  private readIndex;
  selectLod(request: SogLodRequest): Promise<Uint32Array>;
  load(
    sourceIndex: number,
    url: string,
    count: number,
    signal: AbortSignal,
  ): Promise<SogChunkSource>;
  dispose(): void;
}
