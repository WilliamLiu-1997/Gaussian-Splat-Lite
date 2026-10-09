import type { Box3 } from "three";
export type SogLodRange = {
  leaf: number;
  level: number;
  /** -1 for an empty LOD, which has no backing file. */
  file: number;
  offset: number;
  count: number;
};
export type SogLodLeaf = {
  id: number;
  /** Coarse to fine, with strictly increasing counts and decreasing levels. */
  lods: SogLodRange[];
};
export type SogLodNode = {
  bound: Box3;
  children?: SogLodNode[];
  leaf?: SogLodLeaf;
};
export type SogLodFile = {
  url: string;
  count: number;
  ranges: SogLodRange[];
};
export type SogLodManifest = {
  tree: SogLodNode;
  leaves: SogLodLeaf[];
  /** Flattened in leaf/LOD order; each leaf's first entry is unused. */
  upgradeRatios: number[];
  files: SogLodFile[];
  environment?: string;
};
export declare const SOG_LOD_STRIDE = 4;
/** Packed worker index. Float64 preserves source bounds and safe-integer counts. */
export type SogLodIndex = {
  /** Preorder nodes: min XYZ, max XYZ, next index after the subtree, leaf ID (-1 for interiors). */
  nodes: Float64Array;
  leafOffsets: Uint32Array;
  /** Per level: level, file, offset, count. */
  lods: Float64Array;
  /** Best reachable distance-error reduction per added splat, in LOD order. */
  upgradeRatios: Float32Array;
  urls: string[];
  counts: Float64Array;
  environment?: string;
};
/** Scheduler metadata; the complete spatial tree stays in the LOD worker. */
export type SogLodMetadata = Omit<SogLodIndex, "nodes" | "upgradeRatios"> & {
  /** Root min XYZ and max XYZ. */
  bounds: Float64Array;
};
/** Flatten the tree and ranges into transferable typed arrays. */
export declare function packSogLodIndex(manifest: SogLodManifest): SogLodIndex;
/** Materialize only leaves visited by the camera, preserving stable range identities. */
export declare function readSogLodLeaf(
  index: Pick<SogLodIndex, "leafOffsets" | "lods">,
  id: number,
): SogLodLeaf;
/** Streamed SOG v1, including the earlier unversioned manifests. */
export declare function parseSogLodManifest(
  value: unknown,
  baseUrl: string,
): SogLodManifest;
export type SogVisibleLeaf = {
  leaf: SogLodLeaf;
  weight: number;
};
/** Reuse cached refinements up to the target, then split gaps of four or more. */
export declare function resolveSogLod(
  leaf: SogLodLeaf,
  target: SogLodRange,
  current: SogLodRange | undefined,
  isLoaded: (range: SogLodRange) => boolean,
): {
  range: SogLodRange | undefined;
  load?: SogLodRange;
  /** Wait until range is attached before requesting the next LOD. */
  refinement?: boolean;
};
/** Distance bands within a splat budget, using a small heap. */
export declare function selectSogLods(
  visible: SogVisibleLeaf[],
  budget: number,
  manifest: Pick<SogLodIndex, "leafOffsets" | "upgradeRatios">,
): Map<number, SogLodRange>;
