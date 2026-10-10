import type { SerializedSplatPostDecode } from "./protocol.js";
export declare const CONDITION_CARRY_EVENT_OFFSET_MASK = 2147483647;
export declare const CONDITION_CARRY_EVENT_REMOVAL = 2147483648;
export declare function getInstructionCount(instructions: Uint16Array): number;
export declare function instructionWidth(
  instructions: Uint16Array,
  index: number,
): number;
/** @internal */
export declare function allocateSplatPostDecodeRegisters(
  program: SerializedSplatPostDecode,
): {
  registerOffsets: Uint32Array<ArrayBuffer>;
  registerValueCount: number;
  conditionCarryStageStarts: Uint32Array<ArrayBuffer>;
  conditionCarryEvents: Uint32Array<ArrayBuffer>;
};
