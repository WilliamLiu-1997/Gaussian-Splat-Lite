import type { resolveAsset } from "../../workerDecode.js";
import type { createLccStreamHandlers } from "./workerHandlers.js";
export type LccStreamRpcHandlers = ReturnType<
  typeof createLccStreamHandlers
> & { resolveAsset: typeof resolveAsset };
