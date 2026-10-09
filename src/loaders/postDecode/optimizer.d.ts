import type { PostDecodeSource, SplatPostDecodeOutputs } from "./protocol.js";
/** Fuse only single-use intermediates; shared values must still run once. */
export declare function fuseArithmetic(
  source: PostDecodeSource,
  outputs: SplatPostDecodeOutputs,
): PostDecodeSource;
