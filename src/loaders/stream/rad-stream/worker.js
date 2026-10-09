import { startWorker } from "../../../runtime/workerServer.js";
import { createRadStreamHandlers } from "./workerHandlers.js";
const rpcHandlers = createRadStreamHandlers();
startWorker(rpcHandlers);
