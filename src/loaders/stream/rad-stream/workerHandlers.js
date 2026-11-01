import { RadDecoder, RadLodTree, decode_rad_header } from "gaussian-splat-rs";
import {
  RAD_PAGE_SIZE,
  RAD_POOL_PAGE_COUNT,
  SPLAT_BOUNDS_BLOCK_SIZE,
} from "../../../data/defines.js";
import { createSplatTextureArrays } from "../../../data/splatData.js";
import { wasmCall } from "../../../runtime/wasmCall.js";
import { invertSplatOrder, reorderSplats } from "../../morton.js";
import { RadSource } from "../../rad/RadSource.js";
import { getRadChunkSpan, unpackRadChunk } from "../../rad/radFormat.js";
import { RadSelectionState } from "./RadSelectionState.js";
import { prepareRadMerge, prepareRadSelection } from "./prepareRadSelection.js";
/**
 * Column-major a × b, summed in Matrix4.multiplyMatrices order. Loading Three
 * here would delay every RAD worker's startup.
 */
function multiplyMatrices(a, b, target, offset) {
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      target[offset + column * 4 + row] =
        a[row] * b[column * 4] +
        a[row + 4] * b[column * 4 + 1] +
        a[row + 8] * b[column * 4 + 2] +
        a[row + 12] * b[column * 4 + 3];
}
/** Workers own LOD traversal, display preparation, or a persistent page decoder. */
export function createRadStreamHandlers() {
  // Page decoders keep only their current input's header.
  let decoderHeader;
  let decoder;
  let lod;
  const sources = new Map();
  const chunks = new Map();
  let chunkBytes = 0;
  const selections = new RadSelectionState();
  const loads = new Map();
  return {
    allocateRadStorage({ numSh }) {
      return createSplatTextureArrays(
        RAD_POOL_PAGE_COUNT * RAD_PAGE_SIZE,
        numSh,
      );
    },
    prepareRadSelection(request) {
      return prepareRadSelection(request, chunks);
    },
    snapshotRadSelection({ id }) {
      return selections.snapshot(id);
    },
    prepareRadMerge(request) {
      return prepareRadMerge(request, chunks);
    },
    addRadSource({ id, bytes }) {
      const header = wasmCall(() => decode_rad_header(bytes));
      if (!header) throw new Error("RAD: truncated header");
      if (header.meta.count && !header.meta.lodTree) {
        const error = new Error(
          "RAD streaming requires a LOD tree; load this file with SplatMesh instead",
        );
        error.name = "RadLodRequiredError";
        throw error;
      }
      header.meta.chunks.forEach((chunk, index) => {
        const span = getRadChunkSpan(header.meta, index);
        if (span.count > RAD_PAGE_SIZE)
          throw new Error(
            "RAD streaming chunk exceeds the 65,536-splat page limit",
          );
        // Normalize once in the worker; the main thread retains this source's header.
        chunk.base = span.base;
        chunk.count = span.count;
      });
      lod ??= wasmCall(() => new RadLodTree());
      wasmCall(() => lod.add_source(id, JSON.stringify(header.meta)));
      sources.set(id, header.meta);
      return { header };
    },
    removeRadSource({ id }) {
      if (sources.delete(id)) {
        wasmCall(() => lod.remove_source(id));
        selections.removeSource(id);
      }
      return selections.byteLength;
    },
    addRadSelectionSource({ source }) {
      chunks.set(source, new Map());
    },
    removeRadSelectionSource({ source }) {
      const pages = chunks.get(source);
      if (pages) {
        for (const chunk of pages.values()) chunkBytes -= chunk.bytes;
        chunks.delete(source);
      }
      return chunkBytes;
    },
    initializeRadDecoder({ header: value, maxSh, codebooks }) {
      decoder?.free();
      decoderHeader = value;
      decoder = wasmCall(
        () => new RadDecoder(JSON.stringify(decoderHeader.meta), maxSh),
      );
      if (codebooks)
        wasmCall(() =>
          decoder.set_codebooks(codebooks[0], codebooks[1], codebooks[2]),
        );
    },
    async loadRadChunk({ index, generation, request }, { sendStatus }) {
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
          wasmCall(() => decoder.decode_chunk(bytes)),
        );
        const span = getRadChunkSpan(decoderHeader.meta, index);
        // Rust matches the count to its directory entry; verify the requested page.
        if (decoded.base !== span.base)
          throw new Error(
            "RAD: decoded chunk does not match its directory entry",
          );
        const { lodRadii: radii, childStart, childCount } = decoded;
        if (!childStart || !childCount || radii?.length !== decoded.numSplats)
          throw new Error("RAD: decoded LOD arrays are missing or incomplete");
        if (index === 0 && decoderHeader.meta.count > 1 && !childCount[0])
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
        // Display preparation retains bounds separately from packed page data.
        const boundsBlocks = new Float32Array(
          Math.ceil(data.numSplats / SPLAT_BOUNDS_BLOCK_SIZE) * 12,
        );
        const storageOrder = new Uint32Array(data.numSplats);
        reorderSplats(data, { boundsBlocks, storageOrder });
        const sourceToStorage = invertSplatOrder(storageOrder);
        const tree = {
          centers,
          radii,
          childStart,
          childCount,
          sourceToStorage,
          boundsBlocks,
        };
        // The input owns this packed cache independently of worker decoders.
        const codebooks =
          index === 0 && decoderHeader.meta.shCodeCount && data.extra.shBlock0
            ? wasmCall(() => decoder.get_codebooks())
            : undefined;
        return { data, tree, state, codebooks };
      } finally {
        sendStatus({ loaded });
        loads.delete(generation);
      }
    },
    cancelRadLoad({ generation }) {
      loads.get(generation)?.abort();
    },
    retainRadChunk({ index, generation, source, tree }) {
      if (!sources.has(source)) return;
      wasmCall(() =>
        lod.retain_chunk(
          source,
          index,
          generation,
          tree.centers,
          tree.radii,
          tree.childStart,
          tree.childCount,
        ),
      );
    },
    retainRadSelectionChunk({ index, generation, source, chunk }) {
      const pages = chunks.get(source);
      if (!pages) return chunkBytes;
      const previous = pages.get(index);
      if (previous && previous.generation > generation) return chunkBytes;
      if (
        chunk.boundsBlocks.length !==
        Math.ceil(chunk.sourceToStorage.length / SPLAT_BOUNDS_BLOCK_SIZE) * 12
      )
        throw new Error("Incomplete RAD bounds blocks");
      const bytes =
        chunk.sourceToStorage.byteLength + chunk.boundsBlocks.byteLength;
      pages.set(index, { ...chunk, generation, bytes });
      chunkBytes += bytes - (previous?.bytes ?? 0);
      return chunkBytes;
    },
    selectRadLod(request) {
      // 16 model-view values, pixel scale, projection type, 8 X/Y projection values.
      const stride = 26;
      const views = new Float64Array(
        request.views.length * request.sources.length * stride,
      );
      const sourceIds = new Uint32Array(request.sources.length);
      const sourceSh = new Uint8Array(request.sources.length);
      const pageBytes = new Float64Array(request.sources.length * 2);
      let count = 0;
      // Each input's views include its model-to-group transform.
      request.sources.forEach(
        ({ id, numSh, transform, pageCpuBytes, pageGpuBytes }, source) => {
          sourceIds[source] = id;
          sourceSh[source] = numSh;
          count += sources.get(id).count;
          pageBytes.set([pageCpuBytes, pageGpuBytes], source * 2);
          request.views.forEach((view, index) => {
            const offset = (source * request.views.length + index) * stride;
            multiplyMatrices(view.viewFromObject, transform, views, offset);
            views[offset + 16] = view.pixelScale;
            views[offset + 17] = Number(view.orthographic);
            views.set(view.projectionRows, offset + 18);
          });
        },
      );
      const selected = wasmCall(() =>
        lod.select(
          views,
          sourceIds,
          sourceSh,
          pageBytes,
          Uint32Array.from(request.residentChunks),
          Math.min(request.splatBudget, count || 1, 0xffffffff),
          request.pixelThreshold,
          request.maxResidentCpuBytes,
          request.maxResidentGpuBytes,
          request.splatBudgetTolerance,
        ),
      );
      return selections.prepare(sources, selected, request);
    },
    releaseRadChunk({ index, generation, source }) {
      if (!sources.has(source)) return;
      wasmCall(() => lod.release_chunk(source, index, generation));
    },
    releaseRadSelectionChunk({ index, generation, source }) {
      const pages = chunks.get(source);
      if (!pages) return chunkBytes;
      const previous = pages.get(index);
      if (
        previous &&
        (generation === undefined || previous.generation === generation)
      ) {
        chunkBytes -= previous.bytes;
        pages.delete(index);
      }
      return chunkBytes;
    },
  };
}
