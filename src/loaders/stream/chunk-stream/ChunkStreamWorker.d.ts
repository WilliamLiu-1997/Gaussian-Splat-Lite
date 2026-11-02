import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import type { ChunkStreamRpcHandlers } from "./worker.js";
/** Worker assigned either LOD traversal or retained chunk decoding. */
export declare class ChunkStreamWorker extends WorkerRpc<ChunkStreamRpcHandlers> {
  constructor(onDispose?: () => void);
}
