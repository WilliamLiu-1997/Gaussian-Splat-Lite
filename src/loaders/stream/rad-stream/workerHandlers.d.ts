import type { RadReadRequest, RadResourceState } from "../../rad/RadSource.js";
import type { RadHeader, RadStreamChunk } from "../../rad/radFormat.js";
import type {
  RadSelectionReply,
  RadSelectionRequest,
} from "./RadSelectionState.js";
import type { RadStreamSourceMetadata } from "./RadStreamLoader.js";
import type {
  RadSelectionChunk,
  RadSelectionPreparation,
  prepareRadMerge,
  prepareRadSelection,
} from "./prepareRadSelection.js";
import type { RadLodChunk, RadSourceCut } from "./radLod.js";
/** Workers own LOD traversal, display preparation, or a persistent page decoder. */
export declare function createRadStreamHandlers(): {
  allocateRadStorage(request: { numSh: number }): Uint32Array<ArrayBuffer>[];
  prepareRadSelection(
    request: Parameters<typeof prepareRadSelection>[0],
  ): RadSelectionPreparation;
  snapshotRadSelection(request: { id: number }): RadSourceCut[];
  prepareRadMerge(
    request: Parameters<typeof prepareRadMerge>[0],
  ): ReturnType<typeof prepareRadMerge>;
  addRadSource(request: {
    id: number;
    bytes: Uint8Array;
  }): RadStreamSourceMetadata;
  removeRadSource(request: { id: number }): number;
  addRadSelectionSource(request: { source: number }): void;
  removeRadSelectionSource(request: { source: number }): number;
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
    source: number;
    tree: Omit<RadLodChunk, keyof RadSelectionChunk>;
  }): void;
  retainRadSelectionChunk(request: {
    index: number;
    generation: number;
    source: number;
    chunk: RadSelectionChunk;
  }): number;
  selectRadLod(request: RadSelectionRequest): RadSelectionReply;
  releaseRadChunk(request: {
    index: number;
    generation?: number;
    source: number;
  }): void;
  releaseRadSelectionChunk(request: {
    index: number;
    generation?: number;
    source: number;
  }): number;
};
