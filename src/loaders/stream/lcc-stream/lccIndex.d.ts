export type LccChunk = {
  url: string;
  type?: "sog" | "spz" | "ply";
  offset?: number;
  size?: number;
  count: number;
  environment?: boolean;
};
export type LccInfo = {
  format: "lcc" | "lcc2";
  version?: string;
  epsg?: number;
  offset?: number[];
  shift?: number[];
  scale?: number[];
  /** Counts from finest to coarsest LOD, excluding the environment. */
  levelSplats: number[];
};
export type LccIndex = {
  format: "lcc" | "lcc2";
  levels: number;
  maxLod: number;
  numNodes: number;
  bounds: Float64Array;
  parents: Int32Array;
  firstChild: Uint32Array;
  childCount: Uint32Array;
  level: Uint8Array;
  counts: Float64Array;
  chunk: Uint32Array;
  start: Float64Array;
  roots: number[];
  chunks: LccChunk[];
  sceneBounds: number[];
  info: LccInfo;
  environment?: number;
  hasSh?: boolean;
  ranges?: Float32Array;
  environmentRanges?: Float32Array;
  shUrl?: string;
};
/** Main-thread scheduling data; spatial selection stays in the worker. */
export type LccStreamIndex = Omit<LccIndex, "numNodes" | "bounds" | "roots"> & {
  empty: boolean;
};
export declare function parseLccJson(text: string): Record<string, unknown>;
export declare function parseLccIndex(
  meta: Record<string, unknown>,
  bytes: Uint8Array,
  baseUrl: string,
): LccIndex;
export declare function parseLcc2Index(
  meta: Record<string, unknown>,
  baseUrl: string,
): LccIndex;
