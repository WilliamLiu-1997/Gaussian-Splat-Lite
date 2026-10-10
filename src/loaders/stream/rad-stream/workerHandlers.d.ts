import type { RadReadRequest } from "../../rad/RadSource.js";
import type { RadHeader } from "../../rad/radFormat.js";
import type {
  RadSelectionReply,
  RadSelectionRequest,
} from "./RadSelectionState.js";
import type { prepareRadSelection } from "./prepareRadSelection.js";
import type { RadLodChunk } from "./radLod.js";
/** Each worker initializes once as either the dataset LOD tree or a page decoder. */
export declare function createRadStreamHandlers(): {
  prepareRadSelection(request: Parameters<typeof prepareRadSelection>[0]): {
    selection: {
      indices: Uint32Array;
      wantedChunks: Uint32Array;
      touchedChunks: Uint32Array;
      selectionId: number;
      changedChunks: Uint32Array;
    };
    fade: boolean;
    pools: import("../../../data/RadPagedSplats.js").RadPreparedSelection[];
  };
  initializeRad({
    bytes,
  }: {
    bytes: Uint8Array;
  }): RadHeader;
  initializeRadDecoder({
    header: value,
    rootBytes,
  }: {
    header: RadHeader;
    rootBytes?: Uint8Array;
  }): void;
  loadRadChunk(
    {
      index,
      generation,
      request,
    }: {
      index: number;
      generation: number;
      request: RadReadRequest;
    },
    {
      sendStatus,
    }: {
      sendStatus: (data: {
        loaded: number;
      }) => void;
    },
  ): Promise<{
    data: {
      numSplats: number;
      splatArrays: [Uint32Array<ArrayBufferLike>, Uint32Array<ArrayBufferLike>];
      extra: import("../../../data/defines.js").SplatExtra;
      rootRadius: number | undefined;
    } & import("../../../data/defines.js").SplatResult & {
        sourceIds: Uint32Array;
        centerOnlyBoundingBox: Float32Array;
        boundingBox: Float32Array;
        spatialBounds: Float32Array;
      };
    tree: RadLodChunk;
    state: import("../../rad/RadSource.js").RadResourceState | undefined;
    rootBytes: Uint8Array<ArrayBufferLike> | undefined;
  }>;
  cancelRadLoad({
    generation,
  }: {
    generation: number;
  }): void;
  retainRadChunk({
    index,
    generation,
    tree,
  }: {
    index: number;
    generation: number;
    tree: RadLodChunk;
  }): void;
  selectRadLod(request: RadSelectionRequest): RadSelectionReply;
  releaseRadChunk({
    index,
    generation,
  }: {
    index: number;
    generation?: number;
  }): void;
};
