import type { SerializedSplatPostDecode } from "./postDecode";

/** Shared input contract for worker-side decoding. */
export type SplatLoadArgs = {
  url?: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  file?: Blob;
  fileBytes?: Uint8Array;
  fileType?: string;
  pathName?: string;
  baseUrl?: string;
  postDecode?: SerializedSplatPostDecode;
  expectedSogCount?: number;
  signal?: AbortSignal;
};

export type SplatLoadStatus =
  | { loaded: number; total: number }
  | { assetRequest: number; url: string };
