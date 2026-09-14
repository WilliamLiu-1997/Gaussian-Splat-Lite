import { startWorker } from "../../../runtime/workerServer";
import { decodeSplats, resolveAsset } from "../../workerDecode";
import { createSogStreamHandlers } from "./workerHandlers";

const rpcHandlers = {
  ...createSogStreamHandlers(decodeSplats),
  resolveAsset,
};
export type SogStreamRpcHandlers = typeof rpcHandlers;

startWorker(rpcHandlers);
