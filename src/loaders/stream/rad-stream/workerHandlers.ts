import { RadDecoder, RadLodTree, decode_rad_header } from "gaussian-splat-rs";
import { fromHalf } from "../../../utils/numeric";
import {
  type RadDecodedChunk,
  type RadHeader,
  getRadChunkSpan,
  unpackRadChunk,
} from "../../rad/radFormat";
import {
  type RadStreamSelection,
  changedRadChunks,
  mergeRadFade,
} from "./radFade";
import type { RadLodChunk, RadLodRequest, RadLodSelection } from "./radLod";

/** Workers initialize either the dataset LOD tree or a page decoder. */
export function createRadStreamHandlers() {
  let header: RadHeader | undefined;
  let decoder: RadDecoder | undefined;
  let lod: RadLodTree | undefined;
  function initialize(value: RadHeader) {
    decoder?.free();
    decoder = undefined;
    header = value;
    lod?.free();
    lod = undefined;
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
      // Seed shared SH codebooks once per decoder, discarding root geometry.
      if (rootBytes) decoder.decode_chunk(rootBytes);
    },
    decodeRadChunk({
      index,
      bytes,
    }: {
      index: number;
      bytes: Uint8Array;
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
        centers,
        radii,
        childStart,
        childCount,
      };
      return { data, tree };
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
    selectRadLod(
      request: RadLodRequest & { previous?: Uint32Array; fade?: boolean },
    ): RadStreamSelection {
      if (!header || !lod) throw new Error("RAD: LOD tree is not initialized");
      if (!Number.isSafeInteger(request.splatBudget) || request.splatBudget < 1)
        throw new Error("Invalid RAD LOD request");
      const views = new Float64Array(request.views.length * 18);
      request.views.forEach((view, index) => {
        if (view.viewFromObject.length !== 16)
          throw new Error("Invalid RAD LOD request");
        views.set(view.viewFromObject, index * 18);
        views[index * 18 + 16] = view.pixelScale;
        views[index * 18 + 17] = Number(view.orthographic);
      });
      const selected = lod.select(
        views,
        Uint32Array.from(request.residentChunks),
        Math.min(request.splatBudget, header.meta.count || 1),
        request.pixelThreshold,
        request.hysteresis ?? 0.15,
      ) as RadLodSelection;
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
      lod?.release_chunk(index, generation);
    },
  };
}
