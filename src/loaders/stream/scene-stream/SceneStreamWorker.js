import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import BundledWorker from "./worker.js?worker&inline";
export class SceneStreamWorker extends WorkerRpc {
  constructor(onDispose) {
    super(new BundledWorker(), onDispose);
  }
}
