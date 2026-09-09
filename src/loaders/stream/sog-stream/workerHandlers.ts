import type { SplatResult } from "../../../data/defines";
import { getSplatByteLength, getSplatShDegree } from "../../../data/splatData";
import { extractSplatRange } from "../../../data/splatRange";
import type { SplatLoadArgs, SplatLoadStatus } from "../../loadTypes";
import { packSogLodIndex, parseSogLodManifest } from "./sogLod";
import { type SogView, SogVisibility } from "./sogVisibility";

export type SogChunkInfo = {
  numSplats: number;
  numSh: number;
  byteLength: number;
};

/** Workers own either LOD traversal or decoded chunk caches. */
export function createSogStreamHandlers(
  loadSplats: (
    args: SplatLoadArgs,
    options: { sendStatus: (data: SplatLoadStatus) => void },
  ) => Promise<SplatResult>,
) {
  const sogChunks = new Map<number, SplatResult>();
  const sogLoads = new Map<number, AbortController>();
  let visibility: SogVisibility | undefined;

  function parseSogIndex({
    bytes,
    baseUrl,
  }: { bytes: ArrayBuffer; baseUrl: string }) {
    const index = packSogLodIndex(
      parseSogLodManifest(JSON.parse(new TextDecoder().decode(bytes)), baseUrl),
    );
    visibility = new SogVisibility(index);
    // RPC transfers the return buffers; traversal retains its own index.
    return {
      ...index,
      nodes: index.nodes.slice(),
      leafOffsets: index.leafOffsets.slice(),
      lods: index.lods.slice(),
      counts: index.counts.slice(),
    };
  }

  function selectSogLod({ view, budget }: { view: SogView; budget: number }) {
    if (!visibility) throw new Error("SOG LOD index is not initialized");
    return visibility.select(view, budget);
  }

  function cacheSogChunk({
    id,
    data,
  }: { id: number; data: SplatResult }): SogChunkInfo {
    sogChunks.set(id, data);
    return {
      numSplats: data.numSplats,
      numSh: getSplatShDegree(data.extra),
      byteLength: getSplatByteLength(data),
    };
  }

  async function loadSogChunk(
    { id, ...args }: SplatLoadArgs & { id: number },
    options: { sendStatus: (data: SplatLoadStatus) => void },
  ) {
    const controller = new AbortController();
    sogLoads.set(id, controller);
    try {
      const data = await loadSplats(
        { ...args, signal: controller.signal },
        options,
      );
      controller.signal.throwIfAborted();
      return cacheSogChunk({ id, data });
    } finally {
      sogLoads.delete(id);
    }
  }

  function extractSogRegions({
    id,
    ranges,
  }: {
    id: number;
    ranges: { start: number; count: number }[];
  }) {
    const source = sogChunks.get(id);
    if (!source) throw new Error("Streaming chunk is no longer cached");
    return ranges.map(({ start, count }) =>
      extractSplatRange(source, start, count),
    );
  }

  function releaseSogChunk({ id }: { id: number }) {
    sogLoads.get(id)?.abort();
    sogChunks.delete(id);
  }

  return {
    loadSogChunk,
    cacheSogChunk,
    extractSogRegions,
    releaseSogChunk,
    parseSogIndex,
    selectSogLod,
  };
}
