import type {
  AttributeBinding,
  PostDecodeSource,
  SerializedSplatPostDecodeAttribute,
  SerializedSplatPostDecodeCondition,
  SplatPostDecodeInstruction,
  SplatPostDecodeOutputs,
} from "./protocol.js";
type CompiledProgram = {
  instructions: SplatPostDecodeInstruction[];
  constants: number[];
  outputs: Omit<SplatPostDecodeOutputs, "when">;
  condition?: SerializedSplatPostDecodeCondition;
  attributes: AttributeBinding[];
};
export declare function compileProgram(
  builder: PostDecodeSource,
  sourceOutputs: SplatPostDecodeOutputs,
): CompiledProgram;
export declare function packInstructions(
  instructions: readonly SplatPostDecodeInstruction[],
): Uint16Array;
export declare function snapshotAttributes(
  bindings: readonly AttributeBinding[],
): {
  data: Uint8Array<ArrayBuffer>;
  attributes: SerializedSplatPostDecodeAttribute[];
};
export {};
