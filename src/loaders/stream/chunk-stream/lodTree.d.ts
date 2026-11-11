import type { Box3 } from "three";

export type LodRange = {
  level: number;
  /** -1 for an empty node, which has no backing file. */
  file: number;
  offset: number;
  count: number;
};
/** Packed worker index. Float64 preserves bounds and safe-integer counts. */
export type LodTreeIndex = {
  /** Root min XYZ and max XYZ. */
  bounds: Float64Array;
  /** Per node: min XYZ and max XYZ. */
  nodeBounds: Float64Array;
  /** Per node: level, file, offset, count. */
  ranges: Float64Array;
  urls: string[];
  counts: Float64Array;
  parents: Int32Array;
  /** Whether empty nodes can cover this subtree without loaded data. */
  emptyCoverage: Uint8Array;
  roots: Uint32Array;
  childOffsets: Uint32Array;
  children: Uint32Array;
};
export type LodTreeNode = {
  parent: number;
  bound: Box3;
  level: number;
  file: number;
  start: number;
  count: number;
  children: number[];
};
export type LodBudgetMode = "target" | "limit";
export type LodView = {
  /** Registered cameras that see the group; selection serves all of them. */
  cameras: { modelView: number[]; fovScale: number }[];
  shown: boolean;
};
export type LodTreeRequest = {
  budget: number;
  splatBudgetMode: LodBudgetMode;
  /** Each input's stable ID and current LOD settings. */
  sources: {
    id: number;
    transform: number[];
    lodBaseDistance: number;
    lodMultiplier: number;
  }[];
  view: LodView;
  lodBehindPenalty: number;
  lodDistanceShrink: number;
};
/** Pack parent-before-child nodes with one file range per LOD node. */
export declare function packLodTree(
  nodes: LodTreeNode[],
  roots: number[],
  options: { bounds: Box3 } & Pick<LodTreeIndex, "urls" | "counts">,
): LodTreeIndex;
