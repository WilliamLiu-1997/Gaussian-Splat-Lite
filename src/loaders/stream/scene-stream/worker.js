import { decodeLcc } from "gaussian-splat-rs";
import { startWorker } from "../../../runtime/workerServer.js";
import { decodeSplats, resolveAsset, resolveFile } from "../../workerDecode.js";
import { createSceneStreamHandlers } from "./workerHandlers.js";
startWorker({
  ...createSceneStreamHandlers(decodeSplats, decodeLcc),
  resolveAsset,
  resolveFile,
});
