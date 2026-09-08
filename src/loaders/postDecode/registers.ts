import {
  Opcode,
  SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION,
  SPLAT_POST_DECODE_FLOW_STAGE_REGISTER,
  SPLAT_POST_DECODE_FLOW_STAGE_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0,
  SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_COUNT,
  SPLAT_POST_DECODE_INSTRUCTION_OPCODE,
  SPLAT_POST_DECODE_INSTRUCTION_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_WIDTH,
  SPLAT_POST_DECODE_MISSING_ARGUMENT,
  type SerializedSplatPostDecode,
} from "./protocol";

export const CONDITION_CARRY_EVENT_OFFSET_MASK = 0x7fff_ffff;

export const CONDITION_CARRY_EVENT_REMOVAL = 0x8000_0000;

export function getInstructionCount(instructions: Uint16Array) {
  const count = instructions.length / SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
  if (!Number.isInteger(count)) {
    throw new Error("Invalid packed postDecode instructions");
  }
  return count;
}

export function instructionWidth(instructions: Uint16Array, index: number) {
  return instructions[
    index * SPLAT_POST_DECODE_INSTRUCTION_STRIDE +
      SPLAT_POST_DECODE_INSTRUCTION_WIDTH
  ];
}

type FreeRegisterRange = {
  offset: number;
  width: number;
};

/** @internal */
export function allocateSplatPostDecodeRegisters(
  program: SerializedSplatPostDecode,
) {
  const { instructions, outputs, condition } = program;
  const instructionCount = getInstructionCount(instructions);
  const lastUses = new Uint32Array(instructionCount);
  for (let index = 0; index < instructionCount; index += 1) {
    lastUses[index] = index;
    const instructionOffset = index * SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
    for (
      let argumentIndex = 0;
      argumentIndex < SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_COUNT;
      argumentIndex += 1
    ) {
      const argument =
        instructions[
          instructionOffset +
            SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0 +
            argumentIndex
        ];
      if (argument === SPLAT_POST_DECODE_MISSING_ARGUMENT) break;
      lastUses[argument] = index;
    }
  }
  const packedConditionStages = condition?.stages;
  if (packedConditionStages) {
    for (
      let stageOffset = 0;
      stageOffset < packedConditionStages.length;
      stageOffset += SPLAT_POST_DECODE_FLOW_STAGE_STRIDE
    ) {
      const register =
        packedConditionStages[
          stageOffset + SPLAT_POST_DECODE_FLOW_STAGE_REGISTER
        ];
      const instruction =
        packedConditionStages[
          stageOffset + SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION
        ];
      lastUses[register] = Math.max(lastUses[register], instruction);
    }
  }

  const programEnd = instructionCount;
  for (const output of [
    outputs.position,
    outputs.scale,
    outputs.quaternion,
    outputs.opacity,
    outputs.alpha,
    outputs.color,
    ...(outputs.sh ?? []),
  ]) {
    if (output !== undefined) lastUses[output] = programEnd;
  }

  const registerOffsets = new Uint32Array(instructionCount);
  const constantRegisters = new Uint8Array(instructionCount);
  let registerValueCount = 0;
  for (let index = 0; index < instructionCount; index += 1) {
    const instructionOffset = index * SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
    if (
      instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_OPCODE] ===
      Opcode.Constant
    ) {
      constantRegisters[index] = 1;
      lastUses[index] = programEnd;
      registerOffsets[index] = registerValueCount;
      registerValueCount +=
        instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_WIDTH];
    }
  }

  const releaseHeads = new Int32Array(instructionCount + 1).fill(-1);
  const releaseNext = new Int32Array(instructionCount).fill(-1);
  const freeRanges: FreeRegisterRange[] = [];

  const release = (releasedOffset: number, releasedWidth: number) => {
    let offset = releasedOffset;
    let width = releasedWidth;
    let insertIndex = 0;
    while (
      insertIndex < freeRanges.length &&
      freeRanges[insertIndex].offset < offset
    ) {
      insertIndex += 1;
    }

    const previous = freeRanges[insertIndex - 1];
    if (previous && previous.offset + previous.width === offset) {
      offset = previous.offset;
      width += previous.width;
      freeRanges.splice(insertIndex - 1, 1);
      insertIndex -= 1;
    }
    const next = freeRanges[insertIndex];
    if (next && offset + width === next.offset) {
      width += next.width;
      freeRanges.splice(insertIndex, 1);
    }
    freeRanges.splice(insertIndex, 0, { offset, width });
  };

  const allocate = (width: number) => {
    let bestIndex = -1;
    for (let index = 0; index < freeRanges.length; index += 1) {
      const range = freeRanges[index];
      if (
        range.width >= width &&
        (bestIndex === -1 || range.width < freeRanges[bestIndex].width)
      ) {
        bestIndex = index;
      }
    }
    if (bestIndex === -1) {
      const offset = registerValueCount;
      registerValueCount += width;
      return offset;
    }

    const range = freeRanges[bestIndex];
    const offset = range.offset;
    if (range.width === width) freeRanges.splice(bestIndex, 1);
    else {
      range.offset += width;
      range.width -= width;
    }
    return offset;
  };

  for (let index = 0; index < instructionCount; index += 1) {
    for (
      let released = releaseHeads[index];
      released !== -1;
      released = releaseNext[released]
    ) {
      release(
        registerOffsets[released],
        instructionWidth(instructions, released),
      );
    }
    if (constantRegisters[index]) continue;
    const width = instructionWidth(instructions, index);
    const offset = allocate(width);
    registerOffsets[index] = offset;
    const releaseIndex = lastUses[index] + 1;
    if (releaseIndex <= instructionCount) {
      releaseNext[index] = releaseHeads[releaseIndex];
      releaseHeads[releaseIndex] = index;
    }
  }
  const conditionStageCount = packedConditionStages
    ? packedConditionStages.length / SPLAT_POST_DECODE_FLOW_STAGE_STRIDE
    : 0;
  if (!Number.isInteger(conditionStageCount)) {
    throw new Error("Invalid packed postDecode condition flow");
  }
  let conditionCarryStageStarts = new Uint32Array();
  let conditionCarryEvents = new Uint32Array();
  if (packedConditionStages && conditionStageCount !== 0) {
    if (registerValueCount > 0x1_0000) {
      throw new Error("postDecode register offsets exceed Uint16 capacity");
    }

    const stageBoundaries = new Uint16Array(conditionStageCount);
    for (let stage = 0; stage < conditionStageCount; stage += 1) {
      const boundary =
        packedConditionStages[
          stage * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE +
            SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION
        ] + 1;
      if (
        boundary > instructionCount ||
        (stage !== 0 && boundary <= stageBoundaries[stage - 1])
      ) {
        throw new Error("Invalid postDecode condition stage boundary");
      }
      stageBoundaries[stage] = boundary;
    }

    const stageAfterInstruction = (instruction: number) => {
      let start = 0;
      let end = conditionStageCount;
      while (start < end) {
        const middle = (start + end) >>> 1;
        if (stageBoundaries[middle] <= instruction) start = middle + 1;
        else end = middle;
      }
      return start;
    };
    const firstStages = new Uint16Array(instructionCount);
    const endStages = new Uint16Array(instructionCount);
    const eventCounts = new Uint32Array(conditionStageCount);
    const removalCounts = new Uint32Array(conditionStageCount);
    for (let index = 0; index < instructionCount; index += 1) {
      if (constantRegisters[index]) continue;
      const firstStage = stageAfterInstruction(index);
      const endStage = stageAfterInstruction(lastUses[index]);
      if (firstStage >= endStage) continue;
      firstStages[index] = firstStage;
      endStages[index] = endStage;
      const width =
        instructions[
          index * SPLAT_POST_DECODE_INSTRUCTION_STRIDE +
            SPLAT_POST_DECODE_INSTRUCTION_WIDTH
        ];
      eventCounts[firstStage] += width;
      if (endStage < conditionStageCount) {
        eventCounts[endStage] += width;
        removalCounts[endStage] += width;
      }
    }
    const eventStarts = new Uint32Array(conditionStageCount + 1);
    for (let stage = 0; stage < conditionStageCount; stage += 1) {
      eventStarts[stage + 1] = eventStarts[stage] + eventCounts[stage];
    }
    conditionCarryStageStarts = eventStarts;

    conditionCarryEvents = new Uint32Array(eventStarts[conditionStageCount]);
    const removalCursors = new Uint32Array(
      eventStarts.subarray(0, conditionStageCount),
    );
    const additionCursors = new Uint32Array(conditionStageCount);
    for (let stage = 0; stage < conditionStageCount; stage += 1) {
      additionCursors[stage] = eventStarts[stage] + removalCounts[stage];
    }
    for (let index = 0; index < instructionCount; index += 1) {
      const firstStage = firstStages[index];
      const endStage = endStages[index];
      if (firstStage >= endStage) continue;
      const width =
        instructions[
          index * SPLAT_POST_DECODE_INSTRUCTION_STRIDE +
            SPLAT_POST_DECODE_INSTRUCTION_WIDTH
        ];
      const offset = registerOffsets[index];
      for (let lane = 0; lane < width; lane += 1) {
        const carryOffset = offset + lane;
        if (endStage < conditionStageCount) {
          conditionCarryEvents[removalCursors[endStage]] =
            CONDITION_CARRY_EVENT_REMOVAL | carryOffset;
          removalCursors[endStage] += 1;
        }
        conditionCarryEvents[additionCursors[firstStage]] = carryOffset;
        additionCursors[firstStage] += 1;
      }
    }
  }

  return {
    registerOffsets,
    registerValueCount,
    conditionCarryStageStarts,
    conditionCarryEvents,
  };
}
