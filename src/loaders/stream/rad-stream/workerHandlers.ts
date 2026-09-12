import { RadDecoder, RadLodTree, decode_rad_header } from "gaussian-splat-rs";
import { type RadReadRequest, RadSource } from "../../rad/RadSource";
import {
  type RadDecodedChunk,
  type RadHeader,
  type RadStreamChunk,
  getRadChunkSpan,
  unpackRadChunk,
} from "../../rad/radFormat";
import {
  type RadSelectionReply,
  type RadSelectionRequest,
  RadSelectionState,
} from "./RadSelectionState";
import type { RadLodChunk, RadLodSelection } from "./radLod";

/** Workers initialize either the dataset LOD tree or a page decoder. */
export function createRadStreamHandlers() {
  let header: RadHeader | undefined;
  let decoder: RadDecoder | undefined;
  let lod: RadLodTree | undefined;
  let selections = new RadSelectionState();
  const loads = new Map<number, AbortController>();
  function initialize(value: RadHeader) {
    decoder?.free();
    decoder = undefined;
    header = value;
    lod?.free();
    lod = undefined;
    selections = new RadSelectionState();
  }
  return {
    initializeRad({ bytes }: { bytes: Uint8Array }) {
      const value = decode_rad_header(bytes) as RadHeader | undefined;
      if (!value) throw new Error("RAD: truncated header");
      initialize(value);
      lod = new RadLodTree(JSON.stringify(value.meta));
      return value;
    },
    initializeRadDecoder({
      header,
      rootBytes,
    }: { header: RadHeader; rootBytes?: Uint8Array }) {
      initialize(header);
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
      if (!header || !decoder)
        throw new Error("RAD: decoder is not initialized");
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
        if (decoded.base !== span.base || decoded.numSplats !== span.count)
          throw new Error(
            "RAD: decoded chunk does not match its directory entry",
          );
        if (index === 0 && header.meta.count > 1 && !decoded.childCount?.[0])
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
        const { lodRadii: radii, childStart, childCount } = decoded;
        if (radii?.length !== decoded.numSplats)
          throw new Error("RAD: decoded radii are missing");
        // Only packed render records stay on the main thread after registration.
        const data: RadStreamChunk = {
          numSplats: decoded.numSplats,
          splatArrays: decoded.splatArrays,
          extra: decoded.extra,
          rootRadius: index === 0 ? radii[0] : undefined,
        };
        const tree = {
          centers,
          radii,
          childStart,
          childCount,
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
      if (!lod) throw new Error("RAD: LOD tree is not initialized");
      lod.retain_chunk(
        index,
        generation,
        tree.centers,
        tree.radii,
        tree.childStart ?? new Uint32Array(0),
        tree.childCount ?? new Uint16Array(0),
      );
    },
    selectRadLod(request: RadSelectionRequest): RadSelectionReply {
      if (!header || !lod) throw new Error("RAD: LOD tree is not initialized");
      if (!Number.isSafeInteger(request.splatBudget) || request.splatBudget < 1)
        throw new Error("Invalid RAD LOD request");
      // 16 model-view values, pixel scale, projection type, 8 X/Y projection values.
      const stride = 26;
      const views = new Float64Array(request.views.length * stride);
      request.views.forEach((view, index) => {
        if (
          view.viewFromObject.length !== 16 ||
          view.projectionRows.length !== 8
        )
          throw new Error("Invalid RAD LOD request");
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
      return selections.prepare(header.meta, selected, request);
    },
    releaseRadChunk({
      index,
      generation,
    }: { index: number; generation?: number }) {
      lod?.release_chunk(index, generation);
    },
  };
}
