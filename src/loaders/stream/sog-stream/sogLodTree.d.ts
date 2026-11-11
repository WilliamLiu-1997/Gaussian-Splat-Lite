import type { LodTreeIndex } from "../chunk-stream/lodTree.js";
import type { SogLodManifest } from "./sogLod.js";
/** Promote contiguous ranges to spatial ancestors, as in PlayCanvas's SOG LOD tree. */
export declare function buildSogLodTree(manifest: SogLodManifest): LodTreeIndex;
