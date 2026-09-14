import { RadDecoder, RadLodTree, decode_rad_header } from "gaussian-splat-rs";
import { SPLAT_BOUNDS_BLOCK_SIZE } from "../../../data/defines";
import { invertSplatOrder, reorderSplats } from "../../morton";
import { type RadReadRequest, RadSource } from "../../rad/RadSource";
import {
  type RadDecodedChunk,
  type RadHeader,
  getRadChunkSpan,
  unpackRadChunk,
} from "../../rad/radFormat";
import {
  type RadSelectionReply,
  type RadSelectionRequest,
  RadSelectionState,
} from "./RadSelectionState";
import {
  type RadSelectionChunk,
  prepareRadSelection,
} from "./prepareRadSelection";
import type { RadLodChunk, RadLodSelection } from "./radLod";

/** Each worker initializes once as either the dataset LOD tree or a page decoder. */
export function createRadStreamHandlers() {
  let header: RadHeader;
  let decoder: RadDecoder;
  let lod: RadLodTree;
  const chunks = new Map<
    number,
    RadSelectionChunk & {
      generation: number;
      bytes: number;
    }
  >();
  let chunkBytes = 0;
  const selections = new RadSelectionState();
  const loads = new Map<number, AbortController>();
  return {
    prepareRadSelection(request: Parameters<typeof prepareRadSelection>[0]) {
      return prepareRadSelection(request, chunks);
    },
    initializeRad({ bytes }: { bytes: Uint8Array }) {
      const value = decode_rad_header(bytes) as RadHeader | undefined;
      if (!value) throw new Error("RAD: truncated header");
      header = value;
      lod = new RadLodTree(JSON.stringify(value.meta));
      return value;
    },
    initializeRadDecoder({
      header: value,
      rootBytes,
    }: { header: RadHeader; rootBytes?: Uint8Array }) {
      header = value;
      decoder = new RadDecoder(
        JSON.stringify(header.meta),
        header.meta.maxSh ?? 0,
      );
      // The first worker validated the root; other workers only need its codebooks.
      if (rootBytes) decoder.initialize_codebooks(rootBytes);
    },
    async loadRadChunk(
      {
        index,
        generation,
        request,
      }: {
        index: number;
        generation: number;
        request: RadReadRequest;
      },
      { sendStatus }: { sendStatus: (data: { loaded: number }) => void },
    ) {
      const controller = new AbortController();
      loads.set(generation, controller);
      let loaded = 0;
      let lastProgress = 0;
      try {
        const { bytes, state } = await RadSource.readPreparedChunk(
          request,
          controller.signal,
          (bytes) => {
            loaded = bytes;
            const now = performance.now();
            if (now - lastProgress >= 50) {
              lastProgress = now;
              sendStatus({ loaded });
            }
          },
        );
        controller.signal.throwIfAborted();
        const decoded = unpackRadChunk(
          decoder.decode_chunk(bytes) as RadDecodedChunk,
        );
        const span = getRadChunkSpan(header.meta, index);
        // Rust matches the count to its directory entry; verify the requested page.
        if (decoded.base !== span.base)
          throw new Error(
            "RAD: decoded chunk does not match its directory entry",
          );
        const { lodRadii: radii, childStart, childCount } = decoded;
        if (!childStart || !childCount || radii?.length !== decoded.numSplats)
          throw new Error("RAD: decoded LOD arrays are missing or incomplete");
        if (index === 0 && header.meta.count > 1 && !childCount[0])
          throw new Error(
            "RAD: streaming requires a root at index 0 with child nodes",
          );
        const centers = new Float32Array(decoded.numSplats * 3);
        const positions = new Float32Array(
          decoded.splatArrays[0].buffer,
          decoded.splatArrays[0].byteOffset,
          decoded.splatArrays[0].length,
        );
        for (let index = 0; index < decoded.numSplats; index++)
          for (let axis = 0; axis < 3; axis++)
            centers[index * 3 + axis] = positions[index * 4 + axis];
        // Only packed render records stay on the main thread after registration.
        const data = {
          numSplats: decoded.numSplats,
          splatArrays: decoded.splatArrays,
          extra: decoded.extra,
          rootRadius: index === 0 ? radii[0] : undefined,
        };
        // Bounds blocks belong to the LOD tree, not the packed page data.
        const boundsBlocks = new Float32Array(
          Math.ceil(data.numSplats / SPLAT_BOUNDS_BLOCK_SIZE) * 12,
        );
        reorderSplats(data, boundsBlocks);
        const sourceToStorage = invertSplatOrder(data.sourceIds);
        for (let i = 0; i < data.numSplats; i++)
          data.sourceIds[i] += decoded.base;
        const tree: RadLodChunk = {
          centers,
          radii,
          childStart,
          childCount,
          sourceToStorage,
          boundsBlocks,
        };
        // Only the root's compressed bytes seed codebooks in other workers.
        const rootBytes =
          index === 0 && header.meta.shCodeCount && header.meta.maxSh
            ? bytes
            : undefined;
        return { data, tree, state, rootBytes };
      } finally {
        sendStatus({ loaded });
        loads.delete(generation);
      }
    },
    cancelRadLoad({ generation }: { generation: number }) {
      loads.get(generation)?.abort();
    },
    retainRadChunk({
      index,
      generation,
      tree,
    }: { index: number; generation: number; tree: RadLodChunk }) {
      const previous = chunks.get(index);
      if (previous && previous.generation > generation) return;
      if (
        tree.boundsBlocks.length !==
        Math.ceil(tree.radii.length / SPLAT_BOUNDS_BLOCK_SIZE) * 12
      )
        throw new Error("Incomplete RAD bounds blocks");
      lod.retain_chunk(
        index,
        generation,
        tree.centers,
        tree.radii,
        tree.childStart,
        tree.childCount,
      );
      const bytes =
        tree.sourceToStorage.byteLength + tree.boundsBlocks.byteLength;
      chunks.set(index, {
        generation,
        sourceToStorage: tree.sourceToStorage,
        boundsBlocks: tree.boundsBlocks,
        bytes,
      });
      chunkBytes += bytes - (previous?.bytes ?? 0);
    },
    selectRadLod(request: RadSelectionRequest): RadSelectionReply {
      // 16 model-view values, pixel scale, projection type, 8 X/Y projection values.
      const stride = 26;
      const views = new Float64Array(request.views.length * stride);
      request.views.forEach((view, index) => {
        const offset = index * stride;
        views.set(view.viewFromObject, offset);
        views[offset + 16] = view.pixelScale;
        views[offset + 17] = Number(view.orthographic);
        views.set(view.projectionRows, offset + 18);
      });
      const selected = lod.select(
        views,
        Uint32Array.from(request.residentChunks),
        Math.min(request.splatBudget, header.meta.count || 1),
        request.pixelThreshold,
        request.hysteresis ?? 0.05,
      ) as RadLodSelection;
      const reply = selections.prepare(header.meta, selected, request);
      reply.retainedBytes += chunkBytes;
      return reply;
    },
    releaseRadChunk({
      index,
      generation,
    }: { index: number; generation?: number }) {
      lod.release_chunk(index, generation);
      const previous = chunks.get(index);
      if (
        previous &&
        (generation === undefined || previous.generation === generation)
      ) {
        chunkBytes -= previous.bytes;
        chunks.delete(index);
      }
    },
  };
}
