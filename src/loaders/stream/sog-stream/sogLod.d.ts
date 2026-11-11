import type { Box3 } from "three";
import type { LodRange } from "../chunk-stream/lodTree.js";
/** A manifest range; levels without Splats are omitted. */
export type SogLodManifestRange = LodRange;
export type SogLodNode = {
  bound: Box3;
  children?: SogLodNode[];
  /** Leaf regions only, in manifest order. */
  lods?: SogLodManifestRange[];
};
export type SogLodFile = {
  url: string;
  count: number;
  ranges: SogLodManifestRange[];
};
export type SogLodManifest = {
  tree: SogLodNode;
  lodLevels: number;
  files: SogLodFile[];
  environment?: string;
  extra?: unknown;
};
/** Streamed SOG v1, including the earlier unversioned manifests. */
export declare function parseSogLodManifest(
  value: unknown,
  baseUrl: string,
): SogLodManifest;
