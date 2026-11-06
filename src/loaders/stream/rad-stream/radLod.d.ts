export declare function radPageCosts(
  numSh: number,
  indexedSh?: boolean,
): {
  cpu: number;
  gpu: number;
  pending: number;
};
/** Resident bytes of the whole eight-page pools that hold this many pages. */
export declare function radPoolBytes(
  costs: { cpu: number; gpu: number },
  pages?: number,
): { cpu: number; gpu: number };
/** CPU-only page data split between traversal and display preparation workers. */
export type RadLodChunk = {
  centers: Float32Array;
  radii: Float32Array;
  childStart: Uint32Array;
  childCount: Uint16Array;
  /** Original page index to Morton storage; tree arrays keep file order. */
  sourceToStorage: Uint32Array;
  /** Center and scale/rotation bounds per Morton storage block. */
  boundsBlocks: Float32Array;
};
export type RadLodView = {
  /** Object-to-camera transform; doubles preserve large scene translations. */
  viewFromObject: number[];
  /** Camera projection's X/Y rows (8 values), including zoom and view offsets. */
  projectionRows: number[];
  /** Pixels per camera-space unit at depth 1, including projection zoom. */
  pixelScale: number;
  orthographic: boolean;
};
export type RadLodRequest = {
  views: RadLodView[];
  /** Active inputs, each with its transform and decoded page costs. */
  sources: {
    id: number;
    /** Stored SH degree; inputs of one degree share pools. */
    numSh: number;
    transform: number[];
    pageCpuBytes: number;
    pageGpuBytes: number;
  }[];
  splatBudget: number;
  splatBudgetTolerance: number;
  maxResidentCpuBytes: number;
  maxResidentGpuBytes: number;
  pixelThreshold: number;
  /** Interleaved source ID / local chunk pairs. */
  residentChunks: number[];
};
export type RadSourceCut = {
  source: number;
  /** Source-local file indices, independent of physical pool slots. */
  indices: Uint32Array;
};
export type RadLodSelection = {
  sources: RadSourceCut[];
  /** Source ID / local chunk pairs in traversal priority order. */
  wantedChunks: Uint32Array;
  /** Ancestor and selected pages, as source ID / local chunk pairs. */
  touchedChunks: Uint32Array;
};
/** Resolve validated LOD indices without assuming that chunks are 64K records. */
export declare function radChunkIndex(
  meta: { chunks: { base: number; count: number }[] },
  index: number,
): number;
