import type { SplatSourceArgs } from "./loadTypes.js";
import type { PostDecodeSplatData } from "./postDecode/protocol.js";
import type { DecoderLimits } from "./workerDecode.js";
type LoadArgs = SplatSourceArgs & {
  expectedSogCount?: number;
  decoderLimits?: DecoderLimits;
};
export declare function isSogPrefix(bytes: Uint8Array): boolean;
/** @internal Loads SOG with range reads and grouped property decoding. */
export declare function loadSog(args: LoadArgs): Promise<PostDecodeSplatData>;
export {};
