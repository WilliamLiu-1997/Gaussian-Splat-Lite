import { set_sort_center_state, sort32_centers } from "gaussian-splat-rs";
import { loadSplats, resolveAsset, resolveFile } from "../loaders/workerDecode";
import { startWorker } from "./workerServer";

const rpcHandlers = {
  setSortCenterState,
  sortCenters32,
  loadSplats,
  resolveAsset,
  resolveFile,
};
export type RpcHandlers = typeof rpcHandlers;

startWorker(rpcHandlers);

function setSortCenterState({
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
}) {
  set_sort_center_state(
    centerUpdateRangeIndices,
    updateCenters,
    matrixUpdateRangeIndices,
    updateMatrices,
    rangeMeshIds,
    rangeBases,
    rangeCounts,
  );
}

function sortCenters32({
  numSplats,
  cameraPosition,
  direction,
  radial,
  ordering,
}: {
  numSplats: number;
  cameraPosition: [number, number, number];
  direction: [number, number, number];
  radial: boolean;
  ordering: Uint32Array;
}) {
  const activeSplats = sort32_centers(
    numSplats,
    cameraPosition[0],
    cameraPosition[1],
    cameraPosition[2],
    direction[0],
    direction[1],
    direction[2],
    radial,
    ordering,
  );
  return { activeSplats, ordering };
}
