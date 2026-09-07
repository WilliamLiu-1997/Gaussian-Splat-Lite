import { WorkerRpc } from "../../../runtime/WorkerRpc";
import type { SogStreamRpcHandlers } from "./worker";
import BundledWorker from "./worker?worker&inline";

/** Dedicated entry point; its RPC contract contains only streaming operations. */
export class SogStreamWorker extends WorkerRpc<SogStreamRpcHandlers> {
  constructor(onDispose?: () => void) {
    super(new BundledWorker(), onDispose);
  }
}
