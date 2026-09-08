import { WorkerRpc } from "../../../runtime/WorkerRpc";
import type { SogStreamRpcHandlers } from "./worker";
import BundledWorker from "./worker?worker&inline";

/** Worker assigned either LOD traversal or retained chunk decoding. */
export class SogStreamWorker extends WorkerRpc<SogStreamRpcHandlers> {
  constructor(onDispose?: () => void) {
    super(new BundledWorker(), onDispose);
  }
}
