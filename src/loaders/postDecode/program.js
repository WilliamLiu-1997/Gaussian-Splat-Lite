let _a;
import { ProgramBuilder, buildOutputs } from "./builder.js";
import {
  compileProgram,
  packInstructions,
  snapshotAttributes,
} from "./compiler.js";
const SPLAT_POST_DECODE_PROGRAM = Symbol("SplatPostDecodeProgram");
class SplatPostDecodeProgramImpl {
  static {
    _a = SPLAT_POST_DECODE_PROGRAM;
  }
  constructor(builder, outputs) {
    this[_a] = true;
    this.compiled = compileProgram(builder, outputs);
  }
  static serialize(program) {
    if (!(program instanceof SplatPostDecodeProgramImpl)) {
      throw new Error("Invalid postDecode program");
    }
    const compiled = program.compiled;
    const snapshot = snapshotAttributes(compiled.attributes);
    return {
      instructions: packInstructions(compiled.instructions),
      constants: new Float32Array(compiled.constants),
      outputs: compiled.outputs,
      condition: compiled.condition,
      attributeData: snapshot.data,
      attributes: snapshot.attributes,
    };
  }
}
/** @internal */
export function serializeSplatPostDecode(program) {
  return SplatPostDecodeProgramImpl.serialize(program);
}
function defineSplatPostDecode(build) {
  const builder = new ProgramBuilder();
  const patch = build({
    splat: builder.splat,
    op: builder.op,
    attribute: (options) => builder.attribute(options),
  });
  if (!patch || typeof patch !== "object") {
    throw new Error("postDecode builder must return a splat patch object");
  }
  return new SplatPostDecodeProgramImpl(builder, buildOutputs(builder, patch));
}
export const postDecode = {
  define: defineSplatPostDecode,
};
