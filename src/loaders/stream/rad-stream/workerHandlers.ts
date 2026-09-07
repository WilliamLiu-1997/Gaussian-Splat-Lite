import { RadDecoder, decode_rad_header } from "gaussian-splat-rs";
import { fromHalf } from "../../../utils/numeric";
import {
  type RadDecodedChunk,
  type RadHeader,
  unpackRadChunk,
} from "../../rad/radFormat";
import { getRadChunkSpan } from "../../rad/radFormat";
import {
  type RadStreamSelection,
  changedRadChunks,
  mergeRadFade,
} from "./radFade";
import { type RadLodChunk, type RadLodRequest, selectRadLod } from "./radLod";

/** Per-worker decoders; the first worker owns the dataset's complete LOD tree. */
export function createRadStreamHandlers() {
  let header: RadHeader | undefined;
  let decoder: RadDecoder | undefined;
  const trees = new Map<number, RadLodChunk & { generation: number }>();
  let previousRefined = new Set<number>();
  function initializeDecoder(value: RadHeader) {
    decoder?.free();
    decoder = undefined;
    header = value;
    trees.clear();
    previousRefined.clear();
    decoder = new RadDecoder(
      JSON.stringify(header.meta),
      header.meta.maxSh ?? 0,
    );
  }
  function retainTree(index: number, generation: number, tree: RadLodChunk) {
    if ((trees.get(index)?.generation ?? -1) > generation) return;
    trees.set(index, { ...tree, generation });
  }
  return {
    initializeRad({ bytes }: { bytes: Uint8Array }) {
      const value = decode_rad_header(bytes) as RadHeader | undefined;
      if (!value) throw new Error("RAD: truncated header");
      initializeDecoder(value);
      return value;
    },
    initializeRadDecoder({
      header,
      rootBytes,
    }: { header: RadHeader; rootBytes?: Uint8Array }) {
      initializeDecoder(header);
      // Seed shared SH codebooks once per decoder, discarding root geometry.
      if (rootBytes) (decoder as RadDecoder).decode_chunk(rootBytes);
    },
    decodeRadChunk({
      index,
      bytes,
      generation = 0,
      retain = true,
    }: {
      index: number;
      bytes: Uint8Array;
      generation?: number;
      retain?: boolean;
    }) {
      if (!header || !decoder)
        throw new Error("RAD: decoder is not initialized");
      const data = unpackRadChunk(
        decoder.decode_chunk(bytes) as RadDecodedChunk,
      );
      const span = getRadChunkSpan(header.meta, index);
      if (data.base !== span.base || data.numSplats !== span.count)
        throw new Error(
          "RAD: decoded chunk does not match its directory entry",
        );
      if (
        index === 0 &&
        header.meta.lodTree &&
        header.meta.count > 1 &&
        !data.childCount?.[0]
      )
        throw new Error(
          "RAD: streaming requires a root at index 0 with child nodes",
        );
      const centers = new Float32Array(data.numSplats * 3);
      const positions = new Float32Array(
        data.splatArrays[0].buffer,
        data.splatArrays[0].byteOffset,
        data.splatArrays[0].length,
      );
      for (let index = 0; index < data.numSplats; index++)
        for (let axis = 0; axis < 3; axis++)
          centers[index * 3 + axis] = positions[index * 4 + axis];
      if (header.meta.lodTree && data.lodRadii?.length !== data.numSplats)
        throw new Error("RAD: decoded radii are missing");
      const radii = data.lodRadii?.slice() ?? new Float32Array(data.numSplats);
      if (!data.lodRadii) {
        const scales = data.splatArrays[1];
        for (let index = 0; index < data.numSplats; index++) {
          const offset = index * 4;
          radii[index] = Math.exp(
            Math.max(
              fromHalf(scales[offset + 1] >>> 16),
              fromHalf(scales[offset + 2] & 0xffff),
              fromHalf(scales[offset + 2] >>> 16),
            ),
          );
        }
      }
      const childStart = data.childStart?.slice();
      const childCount = data.childCount?.slice();
      const tree = {
        base: data.base,
        numSplats: data.numSplats,
        centers,
        radii,
        childStart,
        childCount,
      };
      if (retain) retainTree(index, generation, tree);
      data.retainedTreeBytes =
        centers.byteLength +
        radii.byteLength +
        (childStart?.byteLength ?? 0) +
        (childCount?.byteLength ?? 0);
      return { data, tree: retain ? undefined : tree };
    },
    retainRadChunk({
      index,
      generation,
      tree,
    }: { index: number; generation: number; tree: RadLodChunk }) {
      retainTree(index, generation, tree);
    },
    selectRadLod(
      request: RadLodRequest & { previous?: Uint32Array; fade?: boolean },
    ): RadStreamSelection {
      if (!header) throw new Error("RAD: decoder is not initialized");
      const { refinedNodes, ...selected } = selectRadLod(
        header.meta,
        trees,
        request,
        previousRefined,
      );
      previousRefined = refinedNodes;
      const previous = request.previous ?? new Uint32Array(0);
      const changedChunks = changedRadChunks(
        header.meta,
        previous,
        selected.indices,
      );
      const fade =
        request.fade && changedChunks.length
          ? mergeRadFade(previous, selected.indices)
          : undefined;
      return { ...selected, changedChunks, fade };
    },
    releaseRadChunk({
      index,
      generation,
    }: { index: number; generation?: number }) {
      if (
        generation === undefined ||
        trees.get(index)?.generation === generation
      ) {
        trees.delete(index);
      }
    },
  };
}
