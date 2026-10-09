import { startWorker } from "../../../runtime/workerServer.js";
import { decodeSplats, resolveAsset } from "../../workerDecode.js";
import { createSogStreamHandlers } from "./workerHandlers.js";
const rpcHandlers = {
  ...createSogStreamHandlers(decodeSplats),
  resolveAsset,
};
startWorker(rpcHandlers);
