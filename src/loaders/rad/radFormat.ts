import type { SplatResult } from "../../data/defines";
import type { PostDecodeSplatData } from "../postDecode/protocol";

export type RadChunkRange = {
  offset: number;
  bytes: number;
  base?: number;
  count?: number;
  filename?: string;
};

/** Spark RAD version 1 directory. Child references use file-global indices. */
export type RadMeta = {
  version: number;
  type: "gsplat";
  count: number;
  maxSh?: number;
  lodTree?: boolean;
  chunkSize?: number;
  allChunkBytes: number;
  chunks: RadChunkRange[];
  shCodeCount?: number;
  splatEncoding?: Record<string, unknown>;
  comment?: string;
};

export type RadHeader = { meta: RadMeta; chunksStart: number };

export type RadChunkData = SplatResult & {
  base: number;
  childStart?: Uint32Array;
  childCount?: Uint16Array;
  lodRadii?: Float32Array;
};

/** Render records for streaming; tree arrays are transferred to the LOD worker. */
export type RadStreamChunk = Omit<SplatResult, "sortCenters"> & {
  /** Root-page radius used when its initial bounds collapse to one point. */
  rootRadius?: number;
};

export type RadDecodedChunk = PostDecodeSplatData & {
  base: number;
  childStart?: Uint32Array;
  childCount?: Uint16Array;
  lodRadii?: Float32Array;
};

export function unpackRadChunk(decoded: RadDecodedChunk): RadChunkData {
  return {
    base: decoded.base,
    numSplats: decoded.numSplats,
    splatArrays: [decoded.splat0, decoded.splat1],
    sortCenters: decoded.sortCenters,
    extra: {
      sh1: decoded.sh1,
      sh2: decoded.sh2,
      sh3a: decoded.sh3a,
      sh3b: decoded.sh3b,
    },
    childStart: decoded.childStart,
    childCount: decoded.childCount,
    lodRadii: decoded.lodRadii,
  };
}

/** Without chunkSize, Spark treats the dataset as one chunk. */
export function getRadChunkSpan(meta: RadMeta, index: number) {
  const chunk = meta.chunks[index];
  if (!chunk) throw new Error(`RAD: missing chunk ${index}`);
  const base = chunk.base ?? index * (meta.chunkSize ?? meta.count);
  const count =
    chunk.count ?? Math.min(meta.chunkSize ?? meta.count, meta.count - base);
  return { base, count };
}

export function isRadPrefix(bytes: Uint8Array) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x41 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x30
  );
}

export function getRadHeaderSize(prefix: Uint8Array) {
  if (!isRadPrefix(prefix)) throw new Error("RAD: missing RAD0 magic");
  const jsonLength = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  ).getUint32(4, true);
  return { jsonLength, headerLength: 8 + Math.ceil(jsonLength / 8) * 8 };
}

/** Validate the header as soon as a full-response fallback supplies it. */
export function collectRadHeader(complete: (bytes: Uint8Array) => void) {
  let header = new Uint8Array(8);
  let received = 0;
  let done = false;
  return (bytes: Uint8Array) => {
    if (done) return;
    let offset = 0;
    if (received < 8) {
      const count = Math.min(bytes.length, 8 - received);
      header.set(bytes.subarray(0, count), received);
      received += count;
      offset += count;
    }
    if (received === 8 && header.length === 8) {
      const expanded = new Uint8Array(getRadHeaderSize(header).headerLength);
      expanded.set(header);
      header = expanded;
    }
    if (received >= 8) {
      const count = Math.min(bytes.length - offset, header.length - received);
      header.set(bytes.subarray(offset, offset + count), received);
      received += count;
      if (received === header.length) {
        done = true;
        complete(header);
      }
    }
  };
}
