import { RadDecoder, RadLodTree, decode_rad_header } from "gaussian-splat-rs";
import { SPLAT_BOUNDS_BLOCK_SIZE } from "../../../data/defines.js";
import { wasmCall } from "../../../runtime/wasmCall.js";
import { invertSplatOrder, reorderSplats } from "../../morton.js";
import { RadSource } from "../../rad/RadSource.js";
import { getRadChunkSpan, unpackRadChunk } from "../../rad/radFormat.js";
import { RadSelectionState } from "./RadSelectionState.js";
import { prepareRadSelection } from "./prepareRadSelection.js";
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
  let header;
  let decoder;
  let lod;
  const chunks = new Map();
  let chunkBytes = 0;
  const selections = new RadSelectionState();
  const loads = new Map();
  return {
    prepareRadSelection(request) {
      return prepareRadSelection(request, chunks);
    },
    initializeRad({ bytes, maxSh }) {
      const headers = bytes.map((bytes) => {
        const value = wasmCall(() => decode_rad_header(bytes));
        if (!value) throw new Error("RAD: truncated header");
        return value;
      });
      // Explicit chunk spans; chunkSize only speeds up the first input's lookups.
      const meta = {
        count: 0,
        lodTree: true,
        maxSh: 0,
        chunkSize: headers.find(({ meta }) => meta.count)?.meta.chunkSize,
        chunks: [],
      };
      const roots = [];
      lod = wasmCall(() => new RadLodTree());
      for (let source = 0; source < headers.length; source++) {
        const value = headers[source];
        wasmCall(() => lod.add_source(JSON.stringify(value.meta)));
        meta.maxSh = Math.max(meta.maxSh, value.meta.maxSh ?? 0);
        if (value.meta.count) {
          roots.push(meta.chunks.length);
          meta.lodTree &&= !!value.meta.lodTree;
        }
        value.meta.chunks.forEach((chunk, index) => {
          const span = getRadChunkSpan(value.meta, index);
          meta.chunks.push({
            ...chunk,
            base: meta.count + span.base,
            count: span.count,
            source,
          });
        });
        meta.count += value.meta.count;
      }
      meta.maxSh = Math.min(meta.maxSh, maxSh);
      header = { meta };
      return { meta, headers, roots };
    },
    initializeRadDecoder({ header: value, maxSh, codebooks }) {
      decoder?.free();
      header = value;
      decoder = wasmCall(
        () => new RadDecoder(JSON.stringify(header.meta), maxSh),
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
          index === 0 && header.meta.shCodeCount && data.extra.shBlock0
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
    retainRadChunk({ index, generation, tree }) {
      wasmCall(() =>
        lod.retain_chunk(
          index,
          generation,
          tree.centers,
          tree.radii,
          tree.childStart,
          tree.childCount,
        ),
      );
    },
    retainRadSelectionChunk({ index, generation, chunk }) {
      const previous = chunks.get(index);
      if (previous && previous.generation > generation) return chunkBytes;
      if (
        chunk.boundsBlocks.length !==
        Math.ceil(chunk.sourceToStorage.length / SPLAT_BOUNDS_BLOCK_SIZE) * 12
      )
        throw new Error("Incomplete RAD bounds blocks");
      const bytes =
        chunk.sourceToStorage.byteLength + chunk.boundsBlocks.byteLength;
      chunks.set(index, { ...chunk, generation, bytes });
      chunkBytes += bytes - (previous?.bytes ?? 0);
      return chunkBytes;
    },
    selectRadLod(request) {
      // 16 model-view values, pixel scale, projection type, 8 X/Y projection values.
      const stride = 26;
      const views = new Float64Array(
        request.views.length * request.transforms.length * stride,
      );
      // Each input's views include its model-to-group transform.
      request.transforms.forEach((transform, source) => {
        request.views.forEach((view, index) => {
          const offset = (source * request.views.length + index) * stride;
          multiplyMatrices(view.viewFromObject, transform, views, offset);
          views[offset + 16] = view.pixelScale;
          views[offset + 17] = Number(view.orthographic);
          views.set(view.projectionRows, offset + 18);
        });
      });
      const selected = wasmCall(() =>
        lod.select(
          views,
          Uint32Array.from(request.residentChunks),
          Math.min(request.splatBudget, header.meta.count || 1),
          request.pixelThreshold,
          request.pageBudget,
          request.splatBudgetTolerance,
        ),
      );
      return selections.prepare(header.meta, selected, request);
    },
    releaseRadChunk({ index, generation }) {
      wasmCall(() => lod.release_chunk(index, generation));
    },
    releaseRadSelectionChunk({ index, generation }) {
      const previous = chunks.get(index);
      if (
        previous &&
        (generation === undefined || previous.generation === generation)
      ) {
        chunkBytes -= previous.bytes;
        chunks.delete(index);
      }
      return chunkBytes;
    },
  };
}
