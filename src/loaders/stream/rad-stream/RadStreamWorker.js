import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import BundledWorker from "./worker.js?worker&inline";
/** Worker assigned either LOD ownership or a persistent page decoder. */
export class RadStreamWorker extends WorkerRpc {
  constructor(onDispose) {
    super(new BundledWorker(), onDispose);
  }
}
