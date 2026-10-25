import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import type { LccStreamRpcHandlers } from "./worker.js";
export declare class LccStreamWorker extends WorkerRpc<LccStreamRpcHandlers> {
  constructor(onDispose?: () => void);
}
