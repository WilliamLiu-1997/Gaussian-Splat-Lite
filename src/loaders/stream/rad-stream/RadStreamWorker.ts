import { WorkerRpc } from "../../../runtime/WorkerRpc";
import type { RadStreamRpcHandlers } from "./worker";
import BundledWorker from "./worker?worker&inline";

/** Dataset worker with a persistent decoder and optional LOD tree ownership. */
export class RadStreamWorker extends WorkerRpc<RadStreamRpcHandlers> {
  constructor(onDispose?: () => void) {
    super(new BundledWorker(), onDispose);
  }
}
