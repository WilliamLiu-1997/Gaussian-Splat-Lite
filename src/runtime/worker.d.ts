import type {
  loadSplats,
  resolveAsset,
  resolveFile,
} from "../loaders/workerDecode.js";
declare const rpcHandlers: {
  setSortCenterState: typeof setSortCenterState;
  sortCenters32: typeof sortCenters32;
  loadSplats: typeof loadSplats;
  resolveAsset: typeof resolveAsset;
  resolveFile: typeof resolveFile;
};
export type RpcHandlers = typeof rpcHandlers;
declare function setSortCenterState({
  centerUpdateRangeIndices,
  updateCenters,
  matrixUpdateRangeIndices,
  updateMatrices,
  rangeMeshIds,
  rangeBases,
  rangeCounts,
}: {
  centerUpdateRangeIndices: Uint32Array;
  updateCenters: Float32Array;
  matrixUpdateRangeIndices: Uint32Array;
  updateMatrices: Float64Array;
  rangeMeshIds: Uint32Array;
  rangeBases: Uint32Array;
  rangeCounts: Uint32Array;
}): void;
/** Orders the Splats for one viewpoint; returns the active count. */
declare function sortCenters32({
  numSplats,
  cameraPosition,
  direction,
  radial,
  fastSort,
  frontSort,
  ordering,
}: {
  numSplats: number;
  cameraPosition: [number, number, number];
  direction: [number, number, number];
  radial: boolean;
  fastSort: boolean;
  frontSort: boolean;
  ordering: Uint32Array;
}): {
  ordering: Uint32Array<ArrayBufferLike>;
  activeSplats: number;
};
export {};
