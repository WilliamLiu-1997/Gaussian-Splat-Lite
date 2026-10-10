import type {
  PostDecodeSplatData,
  SerializedSplatPostDecode,
} from "./protocol.js";
export declare function shWord(
  data: PostDecodeSplatData,
  coefficient: number,
): [Uint32Array, number] | undefined;
export declare function executeRange(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  attributeData: DataView,
  splat0Float: Float32Array,
  registers: Float32Array,
  registerBases: Uint32Array,
  instructionStart: number,
  instructionEnd: number,
  blockStart: number,
  blockCount: number,
  blockSize: number,
  sourceIndices?: Uint16Array,
): void;
