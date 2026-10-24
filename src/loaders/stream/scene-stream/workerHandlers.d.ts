import type { decodeSplats } from "../../workerDecode.js";
import type { SceneSourceHandle } from "./SceneStreamLoader.js";
import type { BudgetedSceneSource, SourceDecodeLimits } from "./memory.js";
export declare function createSceneStreamHandlers(
  decode: typeof decodeSplats,
  decodeLcc: (base: Uint8Array, sh: Uint8Array, context: string) => unknown,
): {
  loadSceneSource(
    args: {
      id: number;
      source: BudgetedSceneSource;
      limits?: SourceDecodeLimits;
      admissionEnabled?: boolean;
      /** Wait for session-owned resource validation before decoding. */
      validateResources?: boolean;
      url: string;
      shUrl?: string;
      requestHeader?: Record<string, string>;
      withCredentials?: boolean;
      shRequestHeader?: Record<string, string>;
      shWithCredentials?: boolean;
      hasFileResolver?: boolean;
    },
    rpc: { sendStatus(data: unknown): void },
  ): Promise<SceneSourceHandle["info"]>;
  acceptSceneResource(args: { id: number }): void;
  releaseSceneSource(args: { id: number }): void;
  admitSceneSource(args: { id: number; limits: SourceDecodeLimits }): void;
  extractSceneRanges(args: {
    id: number;
    ranges: { start: number; count: number }[];
    sourceOffset?: number;
  }): ReturnType<SceneSourceHandle["extract"]>;
};
