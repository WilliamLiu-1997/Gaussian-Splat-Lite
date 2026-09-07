import { startWorker } from "../../../runtime/workerServer";
import { loadSplats, resolveAsset } from "../../workerDecode";
import { createSogStreamHandlers } from "./workerHandlers";

const rpcHandlers = {
  ...createSogStreamHandlers(loadSplats),
  resolveAsset,
};
export type SogStreamRpcHandlers = typeof rpcHandlers;

startWorker(rpcHandlers);
