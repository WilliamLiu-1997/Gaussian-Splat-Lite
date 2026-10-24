export type Lcc2ParseOptions = {
  /** Maximum UTF-8 JSON bytes, including unknown metadata. Default: 16 MiB. */
  maxBytes?: number;
  /** Maximum hierarchy nodes. Default: 100000. */
  maxNodes?: number;
  /** Maximum hierarchy depth, with root at zero. Default: 128. */
  maxDepth?: number;
};
export type Lcc2Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};
export type Lcc2File = {
  /** Index in the normalized manifest's files array. */
  id: number;
  kind: "3dgs" | "mesh" | "bvh";
  /** Index in the original root file table. */
  index: number;
  path: string;
  url: string;
  codec: "ply" | "spz" | "sog" | "btree";
};
type Lcc2ReferenceBase = {
  node: string;
  /** Index in the normalized manifest's files array. */
  file: number;
  /** Present only for array-valued node data; never inferred from tree depth. */
  dataIndex: number | undefined;
  metadata: Record<string, unknown>;
};
export type Lcc2SplatReference = Lcc2ReferenceBase & {
  kind: "3dgs";
  /** Record interval, not a compressed byte range. */
  start: number;
  count: number;
};
export type Lcc2MeshReference = Lcc2ReferenceBase & {
  kind: "mesh";
  vertex: number;
  face: number;
};
export type Lcc2Reference =
  | Lcc2SplatReference
  | Lcc2MeshReference
  | (Lcc2ReferenceBase & { kind: "bvh" | "env" });
export type Lcc2Lod = {
  /** Position in the exported data array, not an inferred refinement policy. */
  level: number;
  data: Record<string, unknown>;
  references: Lcc2Reference[];
};
export type Lcc2Node = {
  id: string;
  depth: number;
  boundingBox: Lcc2Bounds;
  children: Lcc2Node[];
  /** Original data, including unknown attributes and any exported LOD array. */
  data: Record<string, unknown> | Record<string, unknown>[] | null | undefined;
  references: Lcc2Reference[];
  /** Empty for object-valued data; only exported arrays have positional LODs. */
  lods: Lcc2Lod[];
  metadata: Record<string, unknown>;
};
export type Lcc2Environment = {
  /** Absent when env metadata has no explicit root.data.env file reference. */
  reference: Lcc2Reference | undefined;
  count?: number;
  boundingBox?: Lcc2Bounds;
  metadata: Record<string, unknown> | null | undefined;
};
export type Lcc2Manifest = {
  version: "0.0.3";
  /** All three root file tables, in splatFiles/meshFiles/bvhFiles order. */
  files: Lcc2File[];
  tree: Lcc2Node;
  nodes: Lcc2Node[];
  references: Lcc2Reference[];
  environment: Lcc2Environment | undefined;
  totalLevels: number;
  totalSplats: number;
  lodSplats: number[];
  /** Original JSON; normalization does not mutate or apply reserved transforms. */
  metadata: Record<string, unknown>;
};
/** Normalize the 0.0.3 profile without applying reserved transforms or LOD policy. */
export declare function parseLcc2Manifest(
  value: unknown,
  baseUrl: string,
  options?: Lcc2ParseOptions,
): Lcc2Manifest;
/** Check the byte budget before decoding UTF-8 or parsing JSON. */
export declare function parseLcc2Bytes(
  value: ArrayBuffer | ArrayBufferView,
  baseUrl: string,
  options?: Lcc2ParseOptions,
): Lcc2Manifest;

export {};
