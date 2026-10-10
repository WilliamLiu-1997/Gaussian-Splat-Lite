import type { resolveAsset } from "../../workerDecode.js";
import type { createSogStreamHandlers } from "./workerHandlers.js";

export type SogStreamRpcHandlers = ReturnType<
  typeof createSogStreamHandlers
> & {
  resolveAsset: typeof resolveAsset;
};
