import { startWorker } from "../../../runtime/workerServer.js";
import { decodeSplats, resolveAsset } from "../../workerDecode.js";
import { createChunkStreamHandlers } from "./workerHandlers.js";
const rpcHandlers = {
  ...createChunkStreamHandlers(decodeSplats),
  resolveAsset,
};
startWorker(rpcHandlers);
