import type { SerializedSplatPostDecode } from "./postDecode/protocol";

export type SplatLoadStage = "download" | "postDecode" | "optimize";

/** loaded/total describe the current stage; only download uses bytes. */
export type SplatProgressEvent = ProgressEvent & {
  readonly stage: SplatLoadStage;
};

export type SplatFileInput = string | Blob | Uint8Array | ArrayBuffer;
/** Resolves an external SOG image or RAD page named by its metadata. */
export type SplatFileResolver = (
  filename: string,
  signal: AbortSignal,
) => SplatFileInput | Promise<SplatFileInput>;

export type SplatRequestOptions = {
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
};

/** Format loaders share transport and resolver inputs; decoding stays format-specific. */
export type SplatSourceArgs = SplatRequestOptions & {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array;
  readChunk?: () => Promise<Uint8Array | undefined>;
  baseUrl?: string;
  resolveFile?: SplatFileResolver;
  resolveAsset?: (url: string) => Promise<string>;
  signal?: AbortSignal;
  sendStatus: (status: { loaded: number; total: number }) => void;
};

/** Shared input contract for worker-side decoding. */
export type SplatLoadArgs = SplatRequestOptions & {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array;
  fileType?: string;
  pathName?: string;
  baseUrl?: string;
  postDecode?: SerializedSplatPostDecode;
  expectedSogCount?: number;
  hasFileResolver?: boolean;
  /** Request processing progress; streaming loaders only track downloaded bytes. */
  reportProcessingProgress?: boolean;
  signal?: AbortSignal;
};

export type SplatLoadStatus =
  | { loaded: number; total: number; stage?: SplatLoadStage }
  | { assetRequest: number; url: string }
  | { fileRequest: number; filename: string };
