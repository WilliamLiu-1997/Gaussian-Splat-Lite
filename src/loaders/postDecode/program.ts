import {
  ProgramBuilder,
  type SplatPostDecodeContext,
  type SplatPostDecodePatch,
  buildOutputs,
} from "./builder";
import {
  compileProgram,
  packInstructions,
  snapshotAttributes,
} from "./compiler";
import type {
  SerializedSplatPostDecode,
  SplatPostDecodeOutputs,
} from "./protocol";

const SPLAT_POST_DECODE_PROGRAM = Symbol("SplatPostDecodeProgram");

export type SplatPostDecodeProgram = {
  readonly [SPLAT_POST_DECODE_PROGRAM]: true;
};

class SplatPostDecodeProgramImpl implements SplatPostDecodeProgram {
  readonly [SPLAT_POST_DECODE_PROGRAM] = true as const;

  constructor(
    private readonly builder: ProgramBuilder,
    private readonly outputs: SplatPostDecodeOutputs,
  ) {}

  static serialize(program: SplatPostDecodeProgram): SerializedSplatPostDecode {
    if (!(program instanceof SplatPostDecodeProgramImpl)) {
      throw new Error("Invalid postDecode program");
    }
    const compiled = compileProgram(program.builder, program.outputs);
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
export function serializeSplatPostDecode(
  program: SplatPostDecodeProgram,
): SerializedSplatPostDecode {
  return SplatPostDecodeProgramImpl.serialize(program);
}

function defineSplatPostDecode(
  build: (context: SplatPostDecodeContext) => SplatPostDecodePatch,
): SplatPostDecodeProgram {
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
