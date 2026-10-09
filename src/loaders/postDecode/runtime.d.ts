import type {
  PostDecodeSplatData,
  SerializedSplatPostDecode,
} from "./protocol.js";
export declare function applySplatPostDecode(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  onProgress?: (loaded: number, total: number) => void,
): void;
