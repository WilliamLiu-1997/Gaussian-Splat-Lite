import type { Loader } from "three";
import type { ReorderedSplatResult, SplatFileType } from "../data/defines.js";
import type { SplatFileResolver, SplatProgressEvent } from "./loadTypes.js";
import type { SplatPostDecodeProgram } from "./postDecode/program.js";
export type SplatDataLoadOptions = {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  resolveFile?: SplatFileResolver;
  postDecode?: SplatPostDecodeProgram;
  signal?: AbortSignal;
  onProgress?: (event: SplatProgressEvent) => void;
  onLoad?: (decoded: ReorderedSplatResult) => void;
  onError?: (error: unknown) => void;
};
type SplatLoadContext = Pick<
  Loader,
  "manager" | "path" | "requestHeader" | "withCredentials"
>;
/** Loads packed data without constructing scene objects or GPU textures. */
export declare function loadSplatData(
  {
    url,
    file,
    fileBytes,
    fileType,
    fileName,
    resolveFile,
    postDecode,
    signal,
    onLoad,
    onProgress,
    onError,
  }: SplatDataLoadOptions,
  context?: SplatLoadContext,
): Promise<ReorderedSplatResult>;
export {};
