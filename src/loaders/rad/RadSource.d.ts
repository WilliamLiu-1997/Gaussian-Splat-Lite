import type { LoadingManager } from "three";
import type { SplatFileResolver, SplatRequestOptions } from "../loadTypes.js";
import type { RadHeader } from "./radFormat.js";
export type RadSourceOptions = SplatRequestOptions & {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array | ArrayBuffer;
  baseUrl?: string;
  manager?: LoadingManager;
  resolveFile?: SplatFileResolver;
  /** Internal bridge for LoadingManager URL modifiers in a decode worker. */
  resolveAsset?: (url: string) => Promise<string>;
  onProgress?: (downloadedBytes: number) => void;
  /** Validate ordinary metadata as soon as the full-response header arrives. */
  validateHeader?: (bytes: Uint8Array) => void;
};
type Remote = {
  url: string;
  resolved?: string;
  responseUrl?: string;
  total?: number;
  validator?: string;
  validatorHeader?: "ETag" | "Last-Modified";
  full?: Blob;
};
/** Small response snapshot shared across a dataset's download workers. */
export type RadResourceState = Pick<
  Remote,
  "responseUrl" | "total" | "validator" | "validatorHeader"
>;
/** Resolved page input. Local inputs contain only the requested Blob slice. */
export type RadReadRequest = {
  input: string | Blob;
  offset: number;
  length: number;
  wholeFile: boolean;
  resourceUrl?: string;
  state?: RadResourceState;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
};
/** Validated byte reads shared by ordinary RAD loading and paged loading. */
export declare class RadSource {
  readonly options: RadSourceOptions;
  private readonly allowFullDownload;
  readonly stats: {
    downloadedBytes: number;
    activeRequests: number;
    cachedBytes: number;
  };
  private readonly controller;
  private readonly remotes;
  private readonly root;
  private readonly origin?;
  constructor(options: RadSourceOptions, allowFullDownload?: boolean);
  get url(): string | undefined;
  readHeader(signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  readChunk(
    header: RadHeader,
    index: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBufferLike>>;
  private chunkRead;
  /** Resolve callbacks on their owning thread; workers read and validate bodies. */
  prepareChunk(
    header: RadHeader,
    index: number,
    signal?: AbortSignal,
  ): Promise<RadReadRequest>;
  /** Worker transport reuses all ordinary Range, size and encoding validation. */
  static readPreparedChunk(
    request: RadReadRequest,
    signal: AbortSignal,
    onProgress?: (downloadedBytes: number) => void,
  ): Promise<{
    bytes: Uint8Array<ArrayBufferLike>;
    state: RadResourceState | undefined;
  }>;
  /** Reconcile parallel responses before publishing a decoded page. */
  acceptChunkResponse(request: RadReadRequest, state?: RadResourceState): void;
  private resourceState;
  private remote;
  private resolveRemote;
  private requestController;
  private read;
  private readRemote;
  private cacheFullResponse;
  private readHeaderOnlyResponse;
  private readResponse;
  private progress;
  dispose(): void;
}
