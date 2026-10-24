export type LccFormat = "lcc" | "lcc2";
/** Manifest metadata, reported as stored; no transform is applied. */
export type LccInfo = {
  format: LccFormat;
  version?: string;
  /** Splats per LOD level, finest (LOD0) first. */
  levelSplats: number[];
  /** Coordinate system code, when the manifest gives one. */
  epsg?: number;
  offset?: number[];
  shift?: number[];
  scale?: number[];
};
export type LccSplatFile = {
  url: string;
  type: "sog" | "spz" | "ply";
  /** Splats the file must hold to cover every node range that uses it. */
  required: number;
};
/**
 * Nodes of LCC Unit chains or an LCC2 tree. A node's children are contiguous,
 * and refining a node replaces it with all of them.
 */
export type LccNodeTable = {
  format: LccFormat;
  nodeCount: number;
  levels: number;
  count: Float64Array;
  /** LOD level; 0 is the finest. */
  level: Uint8Array;
  /** -1 for roots. */
  parent: Int32Array;
  firstChild: Uint32Array;
  childCount: Uint32Array;
  /** LCC: data.bin byte offset. LCC2: splat file index, or -1 without data. */
  location: Float64Array;
  /** First source ID: the data.bin record index, or the start within an LCC2 file. */
  start: Float64Array;
  /** Min XYZ and max XYZ per node, for distance. */
  bounds: Float64Array;
  /** Conservative min XYZ and max XYZ per node, for culling. */
  cullBounds: Float64Array;
  roots: Uint32Array;
  /** Scene min XYZ and max XYZ, excluding the environment. */
  sceneBounds: Float64Array;
  info: LccInfo;
  files?: LccSplatFile[];
  environmentFile?: number;
  environmentCount?: number;
};
export type LccMeta = {
  levels: number;
  cell: [number, number];
  bounds: number[];
  hasSh: boolean;
  /** Scale min/max and SH min/max XYZ. */
  ranges: Float32Array;
  environmentRanges: Float32Array;
  levelSplats?: number[];
  info: LccInfo;
};
/** LCC2 manifests have a root object; meta.lcc describes a Unit grid. */
export declare function isLcc2Manifest(json: unknown): boolean;
/** Some LCC2 exporters write trailing commas; retry without them outside strings. */
export declare function parseLccJson(text: string): unknown;
/** Validates meta.lcc; Unit layout and counts come from index.bin. */
export declare function parseLccMeta(json: unknown): LccMeta;
/** One chain per Unit: node `unit * levels` is its coarsest level, LOD0 is last. */
export declare function packLccIndex(
  meta: LccMeta,
  bytes: Uint8Array,
): LccNodeTable;
/** Breadth-first node order keeps each node's children contiguous. */
export declare function packLcc2Index(
  json: unknown,
  baseUrl: string,
): LccNodeTable;
