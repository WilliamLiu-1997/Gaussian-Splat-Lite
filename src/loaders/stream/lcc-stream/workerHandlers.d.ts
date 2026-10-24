import type {
  ReorderedSplatResult,
  SplatResult,
} from "../../../data/defines.js";
import type { SplatLoadArgs, SplatLoadStatus } from "../../loadTypes.js";
import type { LccNodeTable } from "./lccIndex.js";
import type { LccBoundsUpdate, LccSelectionRequest } from "./lccSelection.js";
export type LccFileInfo = {
  numSplats: number;
  numSh: number;
  byteLength: number;
};
/** The node table without per-node bounds, which stay in the LOD worker. */
export type LccPublishedTable = Omit<LccNodeTable, "bounds" | "cullBounds"> & {
  retainedIndexBytes: number;
};
export type LccRangeSource = {
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
};
type StatusOptions = { sendStatus: (data: SplatLoadStatus) => void };
/** The LOD worker owns the node table and cuts; decoder workers own loads and LCC2 file caches. */
export declare function createLccStreamHandlers(
  decodeSplats: (
    args: SplatLoadArgs,
    options: StatusOptions,
  ) => Promise<SplatResult>,
): {
  /** LCC2 returns its node table; LCC needs index.bin next. */
  parseLccManifest: (args: {
    bytes: ArrayBuffer;
    baseUrl: string;
  }) =>
    | LccPublishedTable
    | {
        format: "lcc";
        levels: number;
        hasSh: boolean;
        ranges: Float32Array;
        environmentRanges: Float32Array;
      };
  parseLccUnits: (args: { bytes: ArrayBuffer }) => LccPublishedTable;
  selectLcc: (request: LccSelectionRequest) => Uint32Array;
  setLccBounds: (args: { updates: LccBoundsUpdate[] }) => void;
  /** One LCC node: its data.bin records and, for SH scenes, shcoef.bin records. */
  loadLccRecords: (
    args: {
      id: number;
      data: string;
      sh?: string;
      count: number;
      ranges: Float32Array;
      sourceBase: number;
      source: LccRangeSource;
    },
    options: StatusOptions,
  ) => Promise<ReorderedSplatResult>;
  /** environment.bin interleaves SH with base records; absent files return undefined. */
  loadLccEnvironment: (
    args: {
      id: number;
      url: string;
      hasSh: boolean;
      ranges: Float32Array;
      source: LccRangeSource;
    },
    options: StatusOptions,
  ) => Promise<ReorderedSplatResult | undefined>;
  /** Decode an LCC2 splat file in file order and keep it for node extraction. */
  loadLccFile: (
    args: SplatLoadArgs & { id: number; required: number },
    options: StatusOptions,
  ) => Promise<LccFileInfo>;
  extractLccNodes: (args: {
    id: number;
    ranges: { start: number; count: number }[];
  }) => ReorderedSplatResult[];
  cancelLccLoad: (args: { id: number }) => void;
  releaseLccFile: (args: { id: number }) => void;
};
export {};
