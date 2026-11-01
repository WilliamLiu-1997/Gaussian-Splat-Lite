import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import type { RadStreamRpcHandlers } from "./worker.js";
/** Worker assigned traversal, display preparation, or page decoding. */
export declare class RadStreamWorker extends WorkerRpc<RadStreamRpcHandlers> {
  constructor(onDispose?: (reason: unknown) => void);
}
