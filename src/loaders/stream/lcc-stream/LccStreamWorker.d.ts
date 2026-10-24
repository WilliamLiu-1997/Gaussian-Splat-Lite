import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import type { LccStreamRpcHandlers } from "./worker.js";
/** Worker assigned either LOD selection or decoding with retained LCC2 files. */
export declare class LccStreamWorker extends WorkerRpc<LccStreamRpcHandlers> {
  constructor(onDispose?: () => void);
}
