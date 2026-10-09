export declare function decodeSplatOpacity(word: number): number;
export declare function encodeSplatOpacity(opacity: number): number;
type CodecOutput = Float32Array | number[];
export declare function encodeShRgb(
  red: number,
  green: number,
  blue: number,
): number;
export declare function decodeShRgbToArray(
  word: number,
  output: CodecOutput,
  base?: number,
  stride?: number,
): void;
export declare function decodeQuatOctXy1010R12ToArray(
  word: number,
  output: CodecOutput,
  base?: number,
  stride?: number,
): void;
export declare function encodeQuatOctXy1010R12(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): number;
export declare function tryEncodeQuatOctXy1010R12(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): number | undefined;
