import type { resolveAsset } from "../../workerDecode.js";
import type { createChunkStreamHandlers } from "./workerHandlers.js";

export type ChunkStreamRpcHandlers = ReturnType<
  typeof createChunkStreamHandlers
> & {
  resolveAsset: typeof resolveAsset;
};
