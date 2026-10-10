import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import type { SogStreamRpcHandlers } from "./worker.js";
/** Worker assigned either LOD traversal or retained chunk decoding. */
export declare class SogStreamWorker extends WorkerRpc<SogStreamRpcHandlers> {
  constructor(onDispose?: () => void);
}
