import type { SplatLoadArgs, SplatSourceArgs } from "./loadTypes.js";
import type { PostDecodeSplatData } from "./postDecode/protocol.js";
export { isRadPrefix } from "./rad/radFormat.js";
type LoadRadArgs = SplatSourceArgs & Pick<SplatLoadArgs, "postDecode">;
/** Complete-file RAD decode with validated chunk coverage and LOD trees. */
export declare function loadRad(
  args: LoadRadArgs,
): Promise<PostDecodeSplatData>;
