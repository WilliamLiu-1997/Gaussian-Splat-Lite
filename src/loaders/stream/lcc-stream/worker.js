import { startWorker } from "../../../runtime/workerServer.js";
import { decodeSplats, resolveAsset } from "../../workerDecode.js";
import { createLccStreamHandlers } from "./workerHandlers.js";
const rpcHandlers = {
  ...createLccStreamHandlers(decodeSplats),
  resolveAsset,
};
startWorker(rpcHandlers);
