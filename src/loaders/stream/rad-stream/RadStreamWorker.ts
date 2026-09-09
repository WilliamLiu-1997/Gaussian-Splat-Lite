import { WorkerRpc } from "../../../runtime/WorkerRpc";
import type { RadStreamRpcHandlers } from "./worker";
import BundledWorker from "./worker?worker&inline";

/** Worker assigned either LOD ownership or a persistent page decoder. */
export class RadStreamWorker extends WorkerRpc<RadStreamRpcHandlers> {
  constructor(onDispose?: () => void) {
    super(new BundledWorker(), onDispose);
  }
}
