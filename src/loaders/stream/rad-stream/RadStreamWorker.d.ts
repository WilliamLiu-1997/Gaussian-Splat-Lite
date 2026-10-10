import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import type { RadStreamRpcHandlers } from "./worker.js";
/** Worker assigned either LOD ownership or a persistent page decoder. */
export declare class RadStreamWorker extends WorkerRpc<RadStreamRpcHandlers> {
  constructor(onDispose?: () => void);
}
