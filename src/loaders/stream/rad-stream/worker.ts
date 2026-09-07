import { startWorker } from "../../../runtime/workerServer";
import { createRadStreamHandlers } from "./workerHandlers";

const rpcHandlers = createRadStreamHandlers();
export type RadStreamRpcHandlers = typeof rpcHandlers;
startWorker(rpcHandlers);
