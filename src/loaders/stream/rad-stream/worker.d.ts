import type { createRadStreamHandlers } from "./workerHandlers.js";

export type RadStreamRpcHandlers = ReturnType<typeof createRadStreamHandlers>;
