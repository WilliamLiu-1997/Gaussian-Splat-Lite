import type {
  SplatPostDecodeContext,
  SplatPostDecodePatch,
} from "./builder.js";
import type { SerializedSplatPostDecode } from "./protocol.js";
declare const SPLAT_POST_DECODE_PROGRAM: unique symbol;
export type SplatPostDecodeProgram = {
  readonly [SPLAT_POST_DECODE_PROGRAM]: true;
};
/** @internal */
export declare function serializeSplatPostDecode(
  program: SplatPostDecodeProgram,
): SerializedSplatPostDecode;
declare function defineSplatPostDecode(
  build: (context: SplatPostDecodeContext) => SplatPostDecodePatch,
): SplatPostDecodeProgram;
export declare const postDecode: {
  define: typeof defineSplatPostDecode;
};
export {};
