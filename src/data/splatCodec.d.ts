export declare function decodeSplatOpacity(word: number): number;
export declare function encodeSplatOpacity(opacity: number): number;
type CodecOutput = Float32Array | number[];
export declare function decodeShRgbToArray(
  word: number,
  output: CodecOutput,
  base?: number,
  stride?: number,
): void;
export declare function decodeQuatSmallestThree32ToArray(
  word: number,
  output: CodecOutput,
  base?: number,
  stride?: number,
): void;
export declare function encodeQuatSmallestThree32(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): number;
export declare function tryEncodeQuatSmallestThree32(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): number | undefined;
export {};
