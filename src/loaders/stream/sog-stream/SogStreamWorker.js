import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import BundledWorker from "./worker.js?worker&inline";
/** Worker assigned either LOD traversal or retained chunk decoding. */
export class SogStreamWorker extends WorkerRpc {
  constructor(onDispose) {
    super(new BundledWorker(), onDispose);
  }
}
