import type { RadReadRequest, RadResourceState } from "../../rad/RadSource.js";
import type { RadHeader, RadStreamChunk } from "../../rad/radFormat.js";
import type {
  RadSelectionReply,
  RadSelectionRequest,
} from "./RadSelectionState.js";
import type { RadStreamMetadata } from "./RadStreamLoader.js";
import type {
  RadSelectionChunk,
  RadSelectionPreparation,
  prepareRadSelection,
} from "./prepareRadSelection.js";
import type { RadLodChunk } from "./radLod.js";
/** Workers own LOD traversal, display preparation, or a persistent page decoder. */
export declare function createRadStreamHandlers(): {
  prepareRadSelection(
    request: Parameters<typeof prepareRadSelection>[0],
  ): RadSelectionPreparation;
  initializeRad(request: { bytes: Uint8Array[]; maxSh: number }): {
    meta: RadStreamMetadata;
    headers: RadHeader[];
    roots: number[];
  };
  initializeRadDecoder(request: {
    header: RadHeader;
    maxSh: number;
    codebooks?: (Uint32Array | undefined)[];
  }): void;
  loadRadChunk(
    args: {
      index: number;
      generation: number;
      request: RadReadRequest;
    },
    options: {
      sendStatus: (data: {
        loaded: number;
      }) => void;
    },
  ): Promise<{
    data: RadStreamChunk;
    tree: RadLodChunk;
    state: RadResourceState | undefined;
    codebooks: (Uint32Array | undefined)[] | undefined;
  }>;
  cancelRadLoad(request: { generation: number }): void;
  retainRadChunk(request: {
    index: number;
    generation: number;
    tree: Omit<RadLodChunk, keyof RadSelectionChunk>;
  }): void;
  retainRadSelectionChunk(request: {
    index: number;
    generation: number;
    chunk: RadSelectionChunk;
  }): number;
  selectRadLod(request: RadSelectionRequest): RadSelectionReply;
  releaseRadChunk(request: {
    index: number;
    generation?: number;
  }): void;
  releaseRadSelectionChunk(request: {
    index: number;
    generation?: number;
  }): number;
};
