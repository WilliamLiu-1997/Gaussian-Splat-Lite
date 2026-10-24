import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import type { resolveAsset, resolveFile } from "../../workerDecode.js";
import type { createSceneStreamHandlers } from "./workerHandlers.js";
export declare class SceneStreamWorker extends WorkerRpc<
  ReturnType<typeof createSceneStreamHandlers> & {
    resolveAsset: typeof resolveAsset;
    resolveFile: typeof resolveFile;
  }
> {
  constructor(onDispose?: () => void);
}
