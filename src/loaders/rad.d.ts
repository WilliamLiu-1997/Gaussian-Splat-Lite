import type { SplatSourceArgs as LoadRadArgs } from "./loadTypes.js";
import type { PostDecodeSplatData } from "./postDecode/protocol.js";
export { isRadPrefix } from "./rad/radFormat.js";
type RadOutput = PostDecodeSplatData & {
  sourceIds: Uint32Array;
};
/** Complete-file RAD decode with validated chunk coverage and LOD trees. */
export declare function loadRad(args: LoadRadArgs): Promise<RadOutput>;
