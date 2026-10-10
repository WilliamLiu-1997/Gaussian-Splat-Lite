import { set_sort_center_state, sort32_centers } from "gaussian-splat-rs";
import {
  loadSplats,
  resolveAsset,
  resolveFile,
} from "../loaders/workerDecode.js";
import { wasmCall } from "./wasmCall.js";
import { startWorker } from "./workerServer.js";
const rpcHandlers = {
  setSortCenterState,
  sortCenters32,
  loadSplats,
  resolveAsset,
  resolveFile,
};
startWorker(rpcHandlers);
function setSortCenterState({
  centerUpdateRangeIndices,
  updateCenters,
  matrixUpdateRangeIndices,
  updateMatrices,
  rangeMeshIds,
  rangeBases,
  rangeCounts,
}) {
  wasmCall(() =>
    set_sort_center_state(
      centerUpdateRangeIndices,
      updateCenters,
      matrixUpdateRangeIndices,
      updateMatrices,
      rangeMeshIds,
      rangeBases,
      rangeCounts,
    ),
  );
}
/** Orders the Splats for one viewpoint; returns the active count. */
function sortCenters32({
  numSplats,
  cameraPosition,
  direction,
  radial,
  fastSort,
  frontSort,
  ordering,
}) {
  const activeSplats = wasmCall(() =>
    sort32_centers(
      numSplats,
      ...cameraPosition,
      ...direction,
      radial,
      fastSort,
      frontSort,
      ordering,
    ),
  );
  return { ordering, activeSplats };
}
