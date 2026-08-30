import { fromHalf, toHalf } from "./float16";
import {
  ATTRIBUTE_FORMAT_BYTES,
  InputField,
  Opcode,
  SH_COEFFICIENT_COUNT,
  SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION,
  SPLAT_POST_DECODE_FLOW_STAGE_ON_FALSE,
  SPLAT_POST_DECODE_FLOW_STAGE_ON_TRUE,
  SPLAT_POST_DECODE_FLOW_STAGE_REGISTER,
  SPLAT_POST_DECODE_FLOW_STAGE_START,
  SPLAT_POST_DECODE_FLOW_STAGE_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0,
  SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_COUNT,
  SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE,
  SPLAT_POST_DECODE_INSTRUCTION_OPCODE,
  SPLAT_POST_DECODE_INSTRUCTION_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_WIDTH,
  SPLAT_POST_DECODE_MISSING_ARGUMENT,
  type SerializedSplatPostDecode,
  type SerializedSplatPostDecodeAttribute,
} from "./postDecode";
import {
  decodeQuatOctXy1010R12ToArray,
  decodeSplatOpacity,
  encodeSplatOpacity,
  tryEncodeQuatOctXy1010R12,
} from "./splatCodec";

export type PostDecodeSplatData = {
  numSplats: number;
  splat0: Uint32Array;
  splat1: Uint32Array;
  sortCenters: Float32Array;
  sh1?: Uint32Array;
  sh2?: Uint32Array;
  sh3a?: Uint32Array;
  sh3b?: Uint32Array;
};

const MAX_BLOCK_SIZE = 512;
// Keep each worker's temporary register file bounded for very large programs.
const MAX_REGISTER_BYTES = 4 * 1024 * 1024;
const CONDITION_CARRY_EVENT_OFFSET_MASK = 0xffff;
const CONDITION_CARRY_EVENT_REMOVAL = 0x1_0000;
const CONDITION_CARRY_EVENT_STAGE_SHIFT = 17;

function getInstructionCount(instructions: Uint16Array) {
  const count = instructions.length / SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
  if (!Number.isInteger(count)) {
    throw new Error("Invalid packed postDecode instructions");
  }
  return count;
}

function getBlockSize(registerValueCount: number, processCount: number) {
  const bytesPerSplat = registerValueCount * Float32Array.BYTES_PER_ELEMENT;
  return Math.min(
    processCount,
    MAX_BLOCK_SIZE,
    Math.max(1, Math.floor(MAX_REGISTER_BYTES / bytesPerSplat)),
  );
}

type FreeRegisterRange = {
  offset: number;
  width: number;
};

/** @internal */
export function allocateSplatPostDecodeRegisters(
  program: SerializedSplatPostDecode,
) {
  const { instructions, outputs } = program;
  const { condition } = program;
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
  // `when` is consumed at the condition boundary before its range may be
  // reused by the output suffix; only values written back must reach the end.
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
  // Constants are initialized before instruction evaluation and only once for
  // all blocks, so their physical ranges span the entire program.
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

  const releases: FreeRegisterRange[][] = Array.from(
    { length: instructionCount + 1 },
    () => [],
  );
  const freeRanges: FreeRegisterRange[] = [];

  const release = (released: FreeRegisterRange) => {
    let insertIndex = 0;
    while (
      insertIndex < freeRanges.length &&
      freeRanges[insertIndex].offset < released.offset
    ) {
      insertIndex += 1;
    }

    let offset = released.offset;
    let width = released.width;
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
    if (range.width === width) {
      freeRanges.splice(bestIndex, 1);
    } else {
      range.offset += width;
      range.width -= width;
    }
    return offset;
  };

  for (let index = 0; index < instructionCount; index += 1) {
    for (const range of releases[index]) release(range);
    if (constantRegisters[index]) continue;
    const width =
      instructions[
        index * SPLAT_POST_DECODE_INSTRUCTION_STRIDE +
          SPLAT_POST_DECODE_INSTRUCTION_WIDTH
      ];
    const offset = allocate(width);
    registerOffsets[index] = offset;
    const releaseIndex = lastUses[index] + 1;
    if (releaseIndex <= instructionCount) {
      releases[releaseIndex].push({ offset, width });
    }
  }

  const conditionStageCount = packedConditionStages
    ? packedConditionStages.length / SPLAT_POST_DECODE_FLOW_STAGE_STRIDE
    : 0;
  if (!Number.isInteger(conditionStageCount)) {
    throw new Error("Invalid packed postDecode condition flow");
  }
  let conditionCarryEvents = new Uint32Array();
  if (packedConditionStages && conditionStageCount !== 0) {
    // Programs are limited to 4096 instructions with at most four lanes each,
    // so every physical register offset fits losslessly in a Uint16.
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
            (endStage << CONDITION_CARRY_EVENT_STAGE_SHIFT) |
            CONDITION_CARRY_EVENT_REMOVAL |
            carryOffset;
          removalCursors[endStage] += 1;
        }
        conditionCarryEvents[additionCursors[firstStage]] =
          (firstStage << CONDITION_CARRY_EVENT_STAGE_SHIFT) | carryOffset;
        additionCursors[firstStage] += 1;
      }
    }
  }

  return {
    registerOffsets,
    registerValueCount,
    conditionCarryEvents,
  };
}

function rustMin(left: number, right: number) {
  if (Number.isNaN(left)) return right;
  if (Number.isNaN(right)) return left;
  return Math.min(left, right);
}

function rustMax(left: number, right: number) {
  if (Number.isNaN(left)) return right;
  if (Number.isNaN(right)) return left;
  return Math.max(left, right);
}

function roundAwayFromZero(value: number) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const ATTRIBUTE_READERS = {
  f32: (data, offset) => data.getFloat32(offset, true),
  f16: (data, offset) => fromHalf(data.getUint16(offset, true)),
  u8: (data, offset) => data.getUint8(offset),
  unorm8: (data, offset) => data.getUint8(offset) / 0xff,
  i8: (data, offset) => data.getInt8(offset),
  snorm8: (data, offset) => Math.max(-1, data.getInt8(offset) / 0x7f),
  u16: (data, offset) => data.getUint16(offset, true),
  unorm16: (data, offset) => data.getUint16(offset, true) / 0xffff,
  i16: (data, offset) => data.getInt16(offset, true),
  snorm16: (data, offset) => Math.max(-1, data.getInt16(offset, true) / 0x7fff),
  u32: (data, offset) => data.getUint32(offset, true),
  i32: (data, offset) => data.getInt32(offset, true),
} satisfies Record<
  SerializedSplatPostDecodeAttribute["format"],
  (data: DataView, offset: number) => number
>;

function readAttributeBlock(
  data: DataView,
  attribute: SerializedSplatPostDecodeAttribute,
  blockStart: number,
  blockCount: number,
  blockSize: number,
  registers: Float32Array,
  outputBase: number,
  sourceIndices?: Uint16Array,
) {
  const componentBytes = ATTRIBUTE_FORMAT_BYTES[attribute.format];
  const read = ATTRIBUTE_READERS[attribute.format];
  for (let component = 0; component < attribute.components; component += 1) {
    const componentOutput = outputBase + component * blockSize;
    if (sourceIndices) {
      for (let index = 0; index < blockCount; index += 1) {
        const inputOffset =
          attribute.byteOffset +
          (blockStart + sourceIndices[index]) * attribute.byteStride +
          component * componentBytes;
        registers[componentOutput + index] = read(data, inputOffset);
      }
    } else {
      let inputOffset =
        attribute.byteOffset +
        blockStart * attribute.byteStride +
        component * componentBytes;
      for (let index = 0; index < blockCount; index += 1) {
        registers[componentOutput + index] = read(data, inputOffset);
        inputOffset += attribute.byteStride;
      }
    }
  }
}

function encodeQuaternion(
  registers: Float32Array,
  base: number,
  stride: number,
) {
  return tryEncodeQuatOctXy1010R12(
    registers[base],
    registers[base + stride],
    registers[base + stride * 2],
    registers[base + stride * 3],
  );
}

function decodeSh(
  word: number,
  output: Float32Array,
  base: number,
  stride: number,
) {
  const exponentAndSigns = word >>> 24;
  const multiplier = 2 ** ((exponentAndSigns >>> 3) - 15) / 255;
  for (let component = 0; component < 3; component += 1) {
    const magnitude = ((word >>> (component * 8)) & 0xff) * multiplier;
    output[base + component * stride] =
      exponentAndSigns & (1 << component) ? -magnitude : magnitude;
  }
}

function encodeSh(registers: Float32Array, base: number, stride: number) {
  const red = registers[base];
  const green = registers[base + stride];
  const blue = registers[base + stride * 2];
  const maxAbsolute = rustMax(
    Math.abs(red),
    rustMax(Math.abs(green), Math.abs(blue)),
  );
  const exponent = roundAwayFromZero(
    clamp(Math.floor(Math.log2(maxAbsolute)) + 15, 0, 31),
  );
  const divisor = 2 ** (exponent - 15) / 255;
  const encodeComponent = (value: number) =>
    roundAwayFromZero(clamp(Math.abs(value) / divisor, 0, 255));
  const signs = (red < 0 ? 1 : 0) | (green < 0 ? 2 : 0) | (blue < 0 ? 4 : 0);
  return (
    (encodeComponent(red) |
      (encodeComponent(green) << 8) |
      (encodeComponent(blue) << 16) |
      (((exponent << 3) | signs) << 24)) >>>
    0
  );
}

function shWord(
  data: PostDecodeSplatData,
  coefficient: number,
): [Uint32Array, number] | undefined {
  if (coefficient <= 2 && data.sh1) return [data.sh1, coefficient];
  if (coefficient === 3 && data.sh1 && data.sh2) return [data.sh1, 3];
  if (coefficient <= 7 && data.sh2) return [data.sh2, coefficient - 4];
  if (coefficient <= 11 && data.sh3a) return [data.sh3a, coefficient - 8];
  if (coefficient <= 14 && data.sh3b) return [data.sh3b, coefficient - 12];
  return undefined;
}

const OUTPUT_POSITION = 0;
const OUTPUT_SCALE = 1;
const OUTPUT_QUATERNION = 2;
const OUTPUT_OPACITY = 3;
const OUTPUT_ALPHA = 4;
const OUTPUT_COLOR = 5;
const OUTPUT_COUNT = 6;
const MISSING_OUTPUT_BASE = 0xffff_ffff;

type OutputWritePlan = {
  outputBases: Uint32Array;
  shTargetArrays: readonly Uint32Array[];
  shWordOffsets: Uint8Array;
  shRegisterBases: Uint32Array;
  updatesSortCenter: boolean;
  writesOutputs: boolean;
};

function createOutputWritePlan(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  registerBases: Uint32Array,
): OutputWritePlan {
  const { outputs } = program;
  const outputBases = new Uint32Array(OUTPUT_COUNT);
  outputBases.fill(MISSING_OUTPUT_BASE);
  let outputFieldCount = 0;
  const setOutputBase = (slot: number, register: number | undefined) => {
    if (register !== undefined) {
      outputBases[slot] = registerBases[register];
      outputFieldCount += 1;
    }
  };
  setOutputBase(OUTPUT_POSITION, outputs.position);
  setOutputBase(OUTPUT_SCALE, outputs.scale);
  setOutputBase(OUTPUT_QUATERNION, outputs.quaternion);
  setOutputBase(OUTPUT_OPACITY, outputs.opacity);
  setOutputBase(OUTPUT_ALPHA, outputs.alpha);
  setOutputBase(OUTPUT_COLOR, outputs.color);

  const shTargetArrays: Uint32Array[] = [];
  const shWordOffsets: number[] = [];
  const shRegisterBases: number[] = [];
  if (outputs.sh) {
    for (
      let coefficient = 0;
      coefficient < SH_COEFFICIENT_COUNT;
      coefficient += 1
    ) {
      const location = shWord(data, coefficient);
      if (!location) continue;
      shTargetArrays.push(location[0]);
      shWordOffsets.push(location[1]);
      shRegisterBases.push(registerBases[outputs.sh[coefficient]]);
    }
  }

  return {
    outputBases,
    shTargetArrays,
    shWordOffsets: new Uint8Array(shWordOffsets),
    shRegisterBases: new Uint32Array(shRegisterBases),
    updatesSortCenter:
      outputs.position !== undefined || outputs.scale !== undefined,
    writesOutputs: outputFieldCount !== 0 || shTargetArrays.length !== 0,
  };
}

function evaluateInputFieldBlock(
  field: number,
  blockStart: number,
  blockCount: number,
  blockSize: number,
  data: PostDecodeSplatData,
  splat0Float: Float32Array,
  registers: Float32Array,
  outputBase: number,
  sourceIndices?: Uint16Array,
) {
  switch (field) {
    case InputField.Position:
      for (let index = 0; index < blockCount; index += 1) {
        const sourceIndex = sourceIndices?.[index] ?? index;
        const wordBase = (blockStart + sourceIndex) * 4;
        registers[outputBase + index] = splat0Float[wordBase];
        registers[outputBase + blockSize + index] = splat0Float[wordBase + 1];
        registers[outputBase + blockSize * 2 + index] =
          splat0Float[wordBase + 2];
      }
      break;
    case InputField.Scale:
      for (let index = 0; index < blockCount; index += 1) {
        const sourceIndex = sourceIndices?.[index] ?? index;
        const wordBase = (blockStart + sourceIndex) * 4;
        const word1 = data.splat1[wordBase + 1];
        const word2 = data.splat1[wordBase + 2];
        registers[outputBase + index] = Math.exp(fromHalf(word1 >>> 16));
        registers[outputBase + blockSize + index] = Math.exp(
          fromHalf(word2 & 0xffff),
        );
        registers[outputBase + blockSize * 2 + index] = Math.exp(
          fromHalf(word2 >>> 16),
        );
      }
      break;
    case InputField.Quaternion:
      for (let index = 0; index < blockCount; index += 1) {
        const sourceIndex = sourceIndices?.[index] ?? index;
        const wordBase = (blockStart + sourceIndex) * 4;
        decodeQuatOctXy1010R12ToArray(
          data.splat1[wordBase + 3],
          registers,
          outputBase + index,
          blockSize,
        );
      }
      break;
    case InputField.Opacity:
      for (let index = 0; index < blockCount; index += 1) {
        const sourceIndex = sourceIndices?.[index] ?? index;
        registers[outputBase + index] = decodeSplatOpacity(
          data.splat0[(blockStart + sourceIndex) * 4 + 3],
        );
      }
      break;
    case InputField.Alpha:
      for (let index = 0; index < blockCount; index += 1) {
        const sourceIndex = sourceIndices?.[index] ?? index;
        registers[outputBase + index] = fromHalf(
          data.splat0[(blockStart + sourceIndex) * 4 + 3] & 0xffff,
        );
      }
      break;
    case InputField.Color:
      for (let index = 0; index < blockCount; index += 1) {
        const sourceIndex = sourceIndices?.[index] ?? index;
        const wordBase = (blockStart + sourceIndex) * 4;
        const word0 = data.splat1[wordBase];
        const word1 = data.splat1[wordBase + 1];
        registers[outputBase + index] = fromHalf(word0 & 0xffff);
        registers[outputBase + blockSize + index] = fromHalf(word0 >>> 16);
        registers[outputBase + blockSize * 2 + index] = fromHalf(
          word1 & 0xffff,
        );
      }
      break;
    default: {
      const coefficient = field - InputField.Sh0;
      const location = shWord(data, coefficient);
      if (location) {
        for (let index = 0; index < blockCount; index += 1) {
          const sourceIndex = sourceIndices?.[index] ?? index;
          decodeSh(
            location[0][(blockStart + sourceIndex) * 4 + location[1]],
            registers,
            outputBase + index,
            blockSize,
          );
        }
      } else {
        registers.fill(0, outputBase, outputBase + blockCount);
        registers.fill(
          0,
          outputBase + blockSize,
          outputBase + blockSize + blockCount,
        );
        registers.fill(
          0,
          outputBase + blockSize * 2,
          outputBase + blockSize * 2 + blockCount,
        );
      }
    }
  }
}

function compactRegisterBlock(
  registers: Float32Array,
  activeOffsets: Uint16Array,
  activeCount: number,
  laneIndices: Uint16Array,
  nextCount: number,
  blockSize: number,
) {
  for (let carryIndex = 0; carryIndex < activeCount; carryIndex += 1) {
    const offset = activeOffsets[carryIndex];
    const base = offset * blockSize;
    // Lanes are collected in ascending order, so this forward in-place copy
    // never overwrites a source lane that has not been read yet.
    for (let index = 0; index < nextCount; index += 1) {
      registers[base + index] = registers[base + laneIndices[index]];
    }
  }
}

type ConditionCarryState = {
  events: Uint32Array;
  eventIndex: number;
  activeOffsets: Uint16Array;
  activePositions: Int32Array;
  activeCount: number;
};

function applyConditionCarryEvents(carry: ConditionCarryState, stage: number) {
  while (
    carry.eventIndex < carry.events.length &&
    carry.events[carry.eventIndex] >>> CONDITION_CARRY_EVENT_STAGE_SHIFT <=
      stage
  ) {
    const event = carry.events[carry.eventIndex];
    const offset = event & CONDITION_CARRY_EVENT_OFFSET_MASK;
    carry.eventIndex += 1;
    if (event & CONDITION_CARRY_EVENT_REMOVAL) {
      const position = carry.activePositions[offset];
      if (position === -1) {
        throw new Error("Invalid postDecode condition carry removal");
      }
      const lastPosition = carry.activeCount - 1;
      const lastOffset = carry.activeOffsets[lastPosition];
      if (position !== lastPosition) {
        carry.activeOffsets[position] = lastOffset;
        carry.activePositions[lastOffset] = position;
      }
      carry.activePositions[offset] = -1;
      carry.activeCount = lastPosition;
    } else {
      if (carry.activePositions[offset] !== -1) {
        throw new Error("Invalid postDecode condition carry addition");
      }
      carry.activePositions[offset] = carry.activeCount;
      carry.activeOffsets[carry.activeCount] = offset;
      carry.activeCount += 1;
    }
  }
}

function collectConditionFlowBlock(
  heads: Int32Array,
  nextIndices: Int32Array,
  sourceIndices: Uint16Array,
  stage: number,
  initialCount = 0,
) {
  let count = initialCount;
  let sourceIndex = heads[stage];
  while (sourceIndex !== -1) {
    sourceIndices[count] = sourceIndex;
    count += 1;
    sourceIndex = nextIndices[sourceIndex];
  }
  heads[stage] = -1;
  return count;
}

function enqueueConditionFlowBlock(
  heads: Int32Array,
  nextIndices: Int32Array,
  stage: number,
  sourceIndex: number,
) {
  // The array includes the accept terminal. The reject terminal is one past it
  // and intentionally has no queue because rejected Splats need no more work.
  if (stage < 0 || stage >= heads.length) return;
  nextIndices[sourceIndex] = heads[stage];
  heads[stage] = sourceIndex;
}

function evaluateProgram(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  attributeData: DataView,
  splat0Float: Float32Array,
  registers: Float32Array,
  registerBases: Uint32Array,
  conditionCarryEvents: Uint32Array,
  processCount: number,
  blockSize: number,
) {
  const { attributes, constants, instructions } = program;
  const instructionCount = getInstructionCount(instructions);
  const { condition } = program;
  const packedStages = condition?.stages;
  const conditionStageCount = packedStages
    ? packedStages.length / SPLAT_POST_DECODE_FLOW_STAGE_STRIDE
    : 0;
  if (!Number.isInteger(conditionStageCount)) {
    throw new Error("Invalid packed postDecode condition flow");
  }

  const flow = packedStages
    ? {
        stages: packedStages,
        sourceIndices: new Uint16Array(blockSize),
        laneIndices: new Uint16Array(blockSize),
        nextIndices: new Int32Array(blockSize).fill(-1),
        heads: new Int32Array(conditionStageCount + 1).fill(-1),
      }
    : undefined;
  const carry =
    conditionCarryEvents.length === 0
      ? undefined
      : {
          events: conditionCarryEvents,
          eventIndex: 0,
          activeOffsets: new Uint16Array(registers.length / blockSize),
          activePositions: new Int32Array(registers.length / blockSize).fill(
            -1,
          ),
          activeCount: 0,
        };
  const outputInstructionStart =
    flow && conditionStageCount !== 0
      ? flow.stages[
          (conditionStageCount - 1) * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE +
            SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION
        ] + 1
      : 0;
  const outputPlan = createOutputWritePlan(data, program, registerBases);
  const outputWordBases = outputPlan.writesOutputs
    ? new Uint32Array(blockSize)
    : undefined;

  // SoA layout: each vector lane owns blockSize contiguous register values.
  for (
    let instructionIndex = 0;
    instructionIndex < instructionCount;
    instructionIndex += 1
  ) {
    const instructionOffset =
      instructionIndex * SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
    if (
      instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_OPCODE] !==
      Opcode.Constant
    ) {
      continue;
    }
    const outputBase = registerBases[instructionIndex];
    const width =
      instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_WIDTH];
    const immediate =
      instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE];
    for (let lane = 0; lane < width; lane += 1) {
      registers.fill(
        constants[immediate + lane],
        outputBase + lane * blockSize,
        outputBase + (lane + 1) * blockSize,
      );
    }
  }

  for (let blockStart = 0; blockStart < processCount; blockStart += blockSize) {
    let blockCount = Math.min(blockSize, processCount - blockStart);
    let sourceIndices: Uint16Array | undefined;
    if (carry) {
      carry.eventIndex = 0;
      carry.activeCount = 0;
    }

    // Every condition stage owns one contiguous instruction range. The final
    // range evaluates patch outputs for the Splats routed to the accept node.
    for (
      let rangeIndex = 0;
      rangeIndex <= conditionStageCount;
      rangeIndex += 1
    ) {
      const isConditionStage = rangeIndex < conditionStageCount;
      if (flow && flow.heads[rangeIndex] !== -1) {
        if (sourceIndices !== flow.sourceIndices) {
          if (sourceIndices) {
            flow.sourceIndices.set(sourceIndices.subarray(0, blockCount), 0);
          } else {
            for (let index = 0; index < blockCount; index += 1) {
              flow.sourceIndices[index] = index;
            }
          }
        }
        blockCount = collectConditionFlowBlock(
          flow.heads,
          flow.nextIndices,
          flow.sourceIndices,
          rangeIndex,
          blockCount,
        );
        sourceIndices = flow.sourceIndices;
      }

      const stageOffset = rangeIndex * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE;
      const instructionStart =
        flow && isConditionStage
          ? flow.stages[stageOffset + SPLAT_POST_DECODE_FLOW_STAGE_START]
          : outputInstructionStart;
      const instructionEnd =
        flow && isConditionStage
          ? flow.stages[
              stageOffset + SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION
            ] + 1
          : instructionCount;

      if (blockCount !== 0) {
        for (
          let instructionIndex = instructionStart;
          instructionIndex < instructionEnd;
          instructionIndex += 1
        ) {
          const instructionOffset =
            instructionIndex * SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
          const opcode =
            instructions[
              instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_OPCODE
            ];
          const immediate =
            instructions[
              instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE
            ];
          if (opcode === Opcode.Constant) continue;
          const outputBase = registerBases[instructionIndex];
          const width =
            instructions[
              instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_WIDTH
            ];
          const argumentOffset =
            instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0;
          const arg0Register = instructions[argumentOffset];
          const arg1Register = instructions[argumentOffset + 1];
          const arg2Register = instructions[argumentOffset + 2];
          const arg3Register = instructions[argumentOffset + 3];
          const arg0 =
            arg0Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
              ? 0
              : registerBases[arg0Register];
          const arg1 =
            arg1Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
              ? 0
              : registerBases[arg1Register];
          const arg2 =
            arg2Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
              ? 0
              : registerBases[arg2Register];
          const arg3 =
            arg3Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
              ? 0
              : registerBases[arg3Register];
          const arg0Width =
            arg0Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
              ? 0
              : instructions[
                  arg0Register * SPLAT_POST_DECODE_INSTRUCTION_STRIDE +
                    SPLAT_POST_DECODE_INSTRUCTION_WIDTH
                ];
          const arg1Width =
            arg1Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
              ? 0
              : instructions[
                  arg1Register * SPLAT_POST_DECODE_INSTRUCTION_STRIDE +
                    SPLAT_POST_DECODE_INSTRUCTION_WIDTH
                ];
          const arg2Width =
            arg2Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
              ? 0
              : instructions[
                  arg2Register * SPLAT_POST_DECODE_INSTRUCTION_STRIDE +
                    SPLAT_POST_DECODE_INSTRUCTION_WIDTH
                ];

          switch (opcode) {
            case Opcode.InputField:
              evaluateInputFieldBlock(
                immediate,
                blockStart,
                blockCount,
                blockSize,
                data,
                splat0Float,
                registers,
                outputBase,
                sourceIndices,
              );
              break;
            case Opcode.InputAttribute:
              readAttributeBlock(
                attributeData,
                attributes[immediate],
                blockStart,
                blockCount,
                blockSize,
                registers,
                outputBase,
                sourceIndices,
              );
              break;
            case Opcode.Negate:
            case Opcode.Abs:
            case Opcode.Log:
            case Opcode.Exp:
            case Opcode.Floor:
            case Opcode.Ceil:
            case Opcode.Round:
            case Opcode.Sin:
            case Opcode.Cos:
            case Opcode.Acos:
              for (let lane = 0; lane < width; lane += 1) {
                const output = outputBase + lane * blockSize;
                const input = arg0 + lane * blockSize;
                for (let index = 0; index < blockCount; index += 1) {
                  const value = registers[input + index];
                  let result: number;
                  switch (opcode) {
                    case Opcode.Negate:
                      result = -value;
                      break;
                    case Opcode.Abs:
                      result = Math.abs(value);
                      break;
                    case Opcode.Log:
                      result = Math.log(value);
                      break;
                    case Opcode.Exp:
                      result = Math.exp(value);
                      break;
                    case Opcode.Floor:
                      result = Math.floor(value);
                      break;
                    case Opcode.Ceil:
                      result = Math.ceil(value);
                      break;
                    case Opcode.Round:
                      result = roundAwayFromZero(value);
                      break;
                    case Opcode.Sin:
                      result = Math.sin(value);
                      break;
                    case Opcode.Cos:
                      result = Math.cos(value);
                      break;
                    default:
                      result = Math.acos(value);
                  }
                  registers[output + index] = result;
                }
              }
              break;
            case Opcode.Sqrt:
              for (let lane = 0; lane < width; lane += 1) {
                const output = outputBase + lane * blockSize;
                const input = arg0 + lane * blockSize;
                for (let index = 0; index < blockCount; index += 1) {
                  registers[output + index] = Math.sqrt(
                    registers[input + index],
                  );
                }
              }
              break;
            case Opcode.Normalize: {
              for (let index = 0; index < blockCount; index += 1) {
                let lengthSquared = 0;
                for (let lane = 0; lane < width; lane += 1) {
                  const value = registers[arg0 + lane * blockSize + index];
                  lengthSquared += value * value;
                }
                const length = Math.sqrt(lengthSquared);
                for (let lane = 0; lane < width; lane += 1) {
                  const input = registers[arg0 + lane * blockSize + index];
                  registers[outputBase + lane * blockSize + index] =
                    length === 0 || !Number.isFinite(length)
                      ? input
                      : input / length;
                }
              }
              break;
            }
            case Opcode.Length: {
              const inputWidth = arg0Width;
              for (let index = 0; index < blockCount; index += 1) {
                let lengthSquared = 0;
                for (let lane = 0; lane < inputWidth; lane += 1) {
                  const value = registers[arg0 + lane * blockSize + index];
                  lengthSquared += value * value;
                }
                registers[outputBase + index] = Math.sqrt(lengthSquared);
              }
              break;
            }
            case Opcode.IsFinite: {
              const inputWidth = arg0Width;
              for (let index = 0; index < blockCount; index += 1) {
                let finite = true;
                for (let lane = 0; lane < inputWidth; lane += 1) {
                  finite &&= Number.isFinite(
                    registers[arg0 + lane * blockSize + index],
                  );
                }
                registers[outputBase + index] = finite ? 1 : 0;
              }
              break;
            }
            case Opcode.Not:
              for (let index = 0; index < blockCount; index += 1) {
                registers[outputBase + index] =
                  registers[arg0 + index] === 0 ? 1 : 0;
              }
              break;
            case Opcode.Add:
            case Opcode.Subtract:
            case Opcode.Multiply:
            case Opcode.Divide:
            case Opcode.Pow:
              for (let lane = 0; lane < width; lane += 1) {
                const output = outputBase + lane * blockSize;
                const left = arg0 + lane * blockSize;
                const right = arg1 + (arg1Width === 1 ? 0 : lane * blockSize);
                for (let index = 0; index < blockCount; index += 1) {
                  const leftValue = registers[left + index];
                  const rightValue = registers[right + index];
                  let result: number;
                  switch (opcode) {
                    case Opcode.Add:
                      result = leftValue + rightValue;
                      break;
                    case Opcode.Subtract:
                      result = leftValue - rightValue;
                      break;
                    case Opcode.Multiply:
                      result = leftValue * rightValue;
                      break;
                    case Opcode.Divide:
                      result = leftValue / rightValue;
                      break;
                    default:
                      result = leftValue ** rightValue;
                  }
                  registers[output + index] = result;
                }
              }
              break;
            case Opcode.Min:
            case Opcode.Max:
              for (let lane = 0; lane < width; lane += 1) {
                const output = outputBase + lane * blockSize;
                const left = arg0 + lane * blockSize;
                const right = arg1 + (arg1Width === 1 ? 0 : lane * blockSize);
                for (let index = 0; index < blockCount; index += 1) {
                  registers[output + index] =
                    opcode === Opcode.Min
                      ? rustMin(
                          registers[left + index],
                          registers[right + index],
                        )
                      : rustMax(
                          registers[left + index],
                          registers[right + index],
                        );
                }
              }
              break;
            case Opcode.Dot: {
              const inputWidth = arg0Width;
              for (let index = 0; index < blockCount; index += 1) {
                let dot = 0;
                for (let lane = 0; lane < inputWidth; lane += 1) {
                  dot +=
                    registers[arg0 + lane * blockSize + index] *
                    registers[arg1 + lane * blockSize + index];
                }
                registers[outputBase + index] = dot;
              }
              break;
            }
            case Opcode.Cross:
              for (let index = 0; index < blockCount; index += 1) {
                registers[outputBase + index] =
                  registers[arg0 + blockSize + index] *
                    registers[arg1 + blockSize * 2 + index] -
                  registers[arg0 + blockSize * 2 + index] *
                    registers[arg1 + blockSize + index];
                registers[outputBase + blockSize + index] =
                  registers[arg0 + blockSize * 2 + index] *
                    registers[arg1 + index] -
                  registers[arg0 + index] *
                    registers[arg1 + blockSize * 2 + index];
                registers[outputBase + blockSize * 2 + index] =
                  registers[arg0 + index] *
                    registers[arg1 + blockSize + index] -
                  registers[arg0 + blockSize + index] * registers[arg1 + index];
              }
              break;
            case Opcode.Equal:
            case Opcode.NotEqual: {
              const inputWidth = arg0Width;
              for (let index = 0; index < blockCount; index += 1) {
                let equal = true;
                for (let lane = 0; lane < inputWidth; lane += 1) {
                  equal &&=
                    registers[arg0 + lane * blockSize + index] ===
                    registers[arg1 + lane * blockSize + index];
                }
                registers[outputBase + index] = (
                  opcode === Opcode.Equal
                    ? equal
                    : !equal
                )
                  ? 1
                  : 0;
              }
              break;
            }
            case Opcode.Less:
            case Opcode.LessEqual:
            case Opcode.Greater:
            case Opcode.GreaterEqual:
              for (let index = 0; index < blockCount; index += 1) {
                const left = registers[arg0 + index];
                const right = registers[arg1 + index];
                registers[outputBase + index] = (
                  opcode === Opcode.Less
                    ? left < right
                    : opcode === Opcode.LessEqual
                      ? left <= right
                      : opcode === Opcode.Greater
                        ? left > right
                        : left >= right
                )
                  ? 1
                  : 0;
              }
              break;
            case Opcode.And:
            case Opcode.Or:
              for (let index = 0; index < blockCount; index += 1) {
                registers[outputBase + index] = (
                  opcode === Opcode.And
                    ? registers[arg0 + index] !== 0 &&
                      registers[arg1 + index] !== 0
                    : registers[arg0 + index] !== 0 ||
                      registers[arg1 + index] !== 0
                )
                  ? 1
                  : 0;
              }
              break;
            case Opcode.QuaternionMultiply:
              for (let index = 0; index < blockCount; index += 1) {
                const leftX = registers[arg0 + index];
                const leftY = registers[arg0 + blockSize + index];
                const leftZ = registers[arg0 + blockSize * 2 + index];
                const leftW = registers[arg0 + blockSize * 3 + index];
                const rightX = registers[arg1 + index];
                const rightY = registers[arg1 + blockSize + index];
                const rightZ = registers[arg1 + blockSize * 2 + index];
                const rightW = registers[arg1 + blockSize * 3 + index];
                registers[outputBase + index] =
                  leftW * rightX +
                  leftX * rightW +
                  leftY * rightZ -
                  leftZ * rightY;
                registers[outputBase + blockSize + index] =
                  leftW * rightY -
                  leftX * rightZ +
                  leftY * rightW +
                  leftZ * rightX;
                registers[outputBase + blockSize * 2 + index] =
                  leftW * rightZ +
                  leftX * rightY -
                  leftY * rightX +
                  leftZ * rightW;
                registers[outputBase + blockSize * 3 + index] =
                  leftW * rightW -
                  leftX * rightX -
                  leftY * rightY -
                  leftZ * rightZ;
              }
              break;
            case Opcode.RotateVector:
              for (let index = 0; index < blockCount; index += 1) {
                const quaternionX = registers[arg0 + index];
                const quaternionY = registers[arg0 + blockSize + index];
                const quaternionZ = registers[arg0 + blockSize * 2 + index];
                const quaternionW = registers[arg0 + blockSize * 3 + index];
                const vectorX = registers[arg1 + index];
                const vectorY = registers[arg1 + blockSize + index];
                const vectorZ = registers[arg1 + blockSize * 2 + index];
                const crossX =
                  2 * (quaternionY * vectorZ - quaternionZ * vectorY);
                const crossY =
                  2 * (quaternionZ * vectorX - quaternionX * vectorZ);
                const crossZ =
                  2 * (quaternionX * vectorY - quaternionY * vectorX);
                registers[outputBase + index] =
                  vectorX +
                  quaternionW * crossX +
                  quaternionY * crossZ -
                  quaternionZ * crossY;
                registers[outputBase + blockSize + index] =
                  vectorY +
                  quaternionW * crossY +
                  quaternionZ * crossX -
                  quaternionX * crossZ;
                registers[outputBase + blockSize * 2 + index] =
                  vectorZ +
                  quaternionW * crossZ +
                  quaternionX * crossY -
                  quaternionY * crossX;
              }
              break;
            case Opcode.Select: {
              for (let lane = 0; lane < width; lane += 1) {
                const output = outputBase + lane * blockSize;
                const whenTrue = arg1 + lane * blockSize;
                const whenFalse = arg2 + lane * blockSize;
                for (let index = 0; index < blockCount; index += 1) {
                  registers[output + index] =
                    registers[arg0 + index] !== 0
                      ? registers[whenTrue + index]
                      : registers[whenFalse + index];
                }
              }
              break;
            }
            case Opcode.Clamp: {
              const secondWidth = arg1Width;
              const thirdWidth = arg2Width;
              for (let lane = 0; lane < width; lane += 1) {
                const output = outputBase + lane * blockSize;
                const value = arg0 + lane * blockSize;
                const min = arg1 + (secondWidth === 1 ? 0 : lane * blockSize);
                const max = arg2 + (thirdWidth === 1 ? 0 : lane * blockSize);
                for (let index = 0; index < blockCount; index += 1) {
                  registers[output + index] = rustMin(
                    rustMax(registers[value + index], registers[min + index]),
                    registers[max + index],
                  );
                }
              }
              break;
            }
            case Opcode.Mix: {
              const secondWidth = arg1Width;
              const thirdWidth = arg2Width;
              for (let lane = 0; lane < width; lane += 1) {
                const output = outputBase + lane * blockSize;
                const left = arg0 + lane * blockSize;
                const right = arg1 + (secondWidth === 1 ? 0 : lane * blockSize);
                const amount = arg2 + (thirdWidth === 1 ? 0 : lane * blockSize);
                for (let index = 0; index < blockCount; index += 1) {
                  const leftValue = registers[left + index];
                  registers[output + index] =
                    leftValue +
                    (registers[right + index] - leftValue) *
                      registers[amount + index];
                }
              }
              break;
            }
            case Opcode.Vec2:
            case Opcode.Vec3:
            case Opcode.Vec4:
              for (let index = 0; index < blockCount; index += 1) {
                registers[outputBase + index] = registers[arg0 + index];
                registers[outputBase + blockSize + index] =
                  registers[arg1 + index];
                if (width >= 3) {
                  registers[outputBase + blockSize * 2 + index] =
                    registers[arg2 + index];
                }
                if (width === 4) {
                  registers[outputBase + blockSize * 3 + index] =
                    registers[arg3 + index];
                }
              }
              break;
            case Opcode.Component:
              for (let index = 0; index < blockCount; index += 1) {
                registers[outputBase + index] =
                  registers[arg0 + immediate * blockSize + index];
              }
              break;
            case Opcode.MaxComponentIndex: {
              const inputWidth = arg0Width;
              for (let index = 0; index < blockCount; index += 1) {
                let largest = 0;
                let largestValue = registers[arg0 + index];
                for (let lane = 1; lane < inputWidth; lane += 1) {
                  const value = registers[arg0 + lane * blockSize + index];
                  if (value > largestValue) {
                    largest = lane;
                    largestValue = value;
                  }
                }
                registers[outputBase + index] = largest;
              }
            }
          }
        }
      }

      if (flow && isConditionStage && blockCount !== 0) {
        const conditionRegister =
          flow.stages[stageOffset + SPLAT_POST_DECODE_FLOW_STAGE_REGISTER];
        const conditionBase = registerBases[conditionRegister];
        const nextStage = rangeIndex + 1;
        const currentSourceIndices = sourceIndices;
        const previousCount = blockCount;
        let nextStageCount = 0;
        const onTrue =
          flow.stages[stageOffset + SPLAT_POST_DECODE_FLOW_STAGE_ON_TRUE];
        const onFalse =
          flow.stages[stageOffset + SPLAT_POST_DECODE_FLOW_STAGE_ON_FALSE];
        const directOnTrue = onTrue === nextStage;
        const directOnFalse = onFalse === nextStage;
        const rejectTarget = flow.heads.length;
        if (
          (directOnTrue && onFalse === rejectTarget) ||
          (directOnFalse && onTrue === rejectTarget)
        ) {
          // A direct/reject edge is the common linear-chain case. It needs only
          // the same survivor compaction loop as a simple guard, regardless of
          // which truth value continues through the CFG.
          for (let index = 0; index < blockCount; index += 1) {
            const truthy = registers[conditionBase + index] !== 0;
            if (truthy !== directOnTrue) continue;
            const sourceIndex = currentSourceIndices?.[index];
            flow.laneIndices[nextStageCount] = index;
            if (sourceIndex !== undefined) {
              flow.sourceIndices[nextStageCount] = sourceIndex;
            }
            nextStageCount += 1;
          }
        } else {
          for (let index = 0; index < blockCount; index += 1) {
            const sourceIndex = currentSourceIndices?.[index] ?? index;
            const target =
              registers[conditionBase + index] !== 0 ? onTrue : onFalse;
            // The direct successor is compacted in place. More distant branch
            // targets are queued until their forward stage is reached.
            if (target === nextStage) {
              flow.laneIndices[nextStageCount] = index;
              if (currentSourceIndices) {
                flow.sourceIndices[nextStageCount] = sourceIndex;
              }
              nextStageCount += 1;
            } else {
              enqueueConditionFlowBlock(
                flow.heads,
                flow.nextIndices,
                target,
                sourceIndex,
              );
            }
          }
        }
        if (nextStageCount !== 0 && nextStageCount !== previousCount) {
          if (carry) {
            applyConditionCarryEvents(carry, rangeIndex);
            compactRegisterBlock(
              registers,
              carry.activeOffsets,
              carry.activeCount,
              flow.laneIndices,
              nextStageCount,
              blockSize,
            );
          }
        }
        if (
          nextStageCount !== previousCount ||
          currentSourceIndices === flow.laneIndices
        ) {
          // The lane buffer can temporarily double as the first compacted
          // source map. Routing writes new lane positions into that buffer, so
          // switch to the separately preserved source map even when all lanes
          // continued and the count itself did not change.
          sourceIndices =
            nextStageCount === 0
              ? undefined
              : currentSourceIndices
                ? flow.sourceIndices
                : flow.laneIndices;
        }
        blockCount = nextStageCount;
      }
    }
    if (outputWordBases && blockCount !== 0) {
      if (sourceIndices) {
        for (let index = 0; index < blockCount; index += 1) {
          outputWordBases[index] = (blockStart + sourceIndices[index]) * 4;
        }
      } else {
        let wordBase = blockStart * 4;
        for (let index = 0; index < blockCount; index += 1) {
          outputWordBases[index] = wordBase;
          wordBase += 4;
        }
      }
      writeOutputBlock(
        data,
        splat0Float,
        registers,
        outputPlan,
        outputWordBases,
        blockSize,
        blockCount,
      );
    }
    if (carry) {
      for (let index = 0; index < carry.activeCount; index += 1) {
        carry.activePositions[carry.activeOffsets[index]] = -1;
      }
    }
  }
}

function writeOutputBlock(
  data: PostDecodeSplatData,
  splat0Float: Float32Array,
  registers: Float32Array,
  plan: OutputWritePlan,
  outputWordBases: Uint32Array,
  blockSize: number,
  blockCount: number,
) {
  const { outputBases } = plan;
  const positionBase = outputBases[OUTPUT_POSITION];
  if (positionBase !== MISSING_OUTPUT_BASE) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const wordBase = outputWordBases[blockIndex];
      const registerBase = positionBase + blockIndex;
      splat0Float[wordBase] = registers[registerBase];
      splat0Float[wordBase + 1] = registers[registerBase + blockSize];
      splat0Float[wordBase + 2] = registers[registerBase + blockSize * 2];
    }
  }

  const scaleBase = outputBases[OUTPUT_SCALE];
  if (scaleBase !== MISSING_OUTPUT_BASE) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const wordBase = outputWordBases[blockIndex];
      const registerBase = scaleBase + blockIndex;
      const first = data.splat1[wordBase + 1] & 0xffff;
      data.splat1[wordBase + 1] =
        (first | (toHalf(Math.log(registers[registerBase])) << 16)) >>> 0;
      data.splat1[wordBase + 2] =
        (toHalf(Math.log(registers[registerBase + blockSize])) |
          (toHalf(Math.log(registers[registerBase + blockSize * 2])) << 16)) >>>
        0;
    }
  }

  const quaternionBase = outputBases[OUTPUT_QUATERNION];
  if (quaternionBase !== MISSING_OUTPUT_BASE) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const wordBase = outputWordBases[blockIndex];
      const encoded = encodeQuaternion(
        registers,
        quaternionBase + blockIndex,
        blockSize,
      );
      if (encoded !== undefined) data.splat1[wordBase + 3] = encoded;
    }
  }

  const opacityBase = outputBases[OUTPUT_OPACITY];
  if (opacityBase !== MISSING_OUTPUT_BASE) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const wordBase = outputWordBases[blockIndex];
      data.splat0[wordBase + 3] = encodeSplatOpacity(
        registers[opacityBase + blockIndex],
      );
    }
  }

  const alphaBase = outputBases[OUTPUT_ALPHA];
  if (alphaBase !== MISSING_OUTPUT_BASE) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const wordIndex = outputWordBases[blockIndex] + 3;
      data.splat0[wordIndex] =
        ((data.splat0[wordIndex] & 0xffff_0000) |
          toHalf(clamp(registers[alphaBase + blockIndex], 0, 1))) >>>
        0;
    }
  }

  const colorBase = outputBases[OUTPUT_COLOR];
  if (colorBase !== MISSING_OUTPUT_BASE) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const wordBase = outputWordBases[blockIndex];
      const registerBase = colorBase + blockIndex;
      data.splat1[wordBase] =
        (toHalf(registers[registerBase]) |
          (toHalf(registers[registerBase + blockSize]) << 16)) >>>
        0;
      data.splat1[wordBase + 1] =
        ((data.splat1[wordBase + 1] & 0xffff_0000) |
          toHalf(registers[registerBase + blockSize * 2])) >>>
        0;
    }
  }

  for (let shIndex = 0; shIndex < plan.shTargetArrays.length; shIndex += 1) {
    const target = plan.shTargetArrays[shIndex];
    const wordOffset = plan.shWordOffsets[shIndex];
    const shRegisterBase = plan.shRegisterBases[shIndex];
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const wordBase = outputWordBases[blockIndex];
      target[wordBase + wordOffset] = encodeSh(
        registers,
        shRegisterBase + blockIndex,
        blockSize,
      );
    }
  }

  if (plan.updatesSortCenter) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const wordBase = outputWordBases[blockIndex];
      const disabled =
        data.splat1[wordBase + 1] >>> 16 === 0xfc00 &&
        (data.splat1[wordBase + 2] & 0xffff) === 0xfc00 &&
        data.splat1[wordBase + 2] >>> 16 === 0xfc00;
      const centerBase = (wordBase >>> 2) * 3;
      if (disabled) {
        data.sortCenters[centerBase] = Number.NaN;
        data.sortCenters[centerBase + 1] = Number.NaN;
        data.sortCenters[centerBase + 2] = Number.NaN;
      } else {
        data.sortCenters[centerBase] = splat0Float[wordBase];
        data.sortCenters[centerBase + 1] = splat0Float[wordBase + 1];
        data.sortCenters[centerBase + 2] = splat0Float[wordBase + 2];
      }
    }
  }
}

export function applySplatPostDecode(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
) {
  let processCount = data.numSplats;
  for (const attribute of program.attributes) {
    processCount = Math.min(processCount, attribute.count);
  }
  if (processCount === 0 || program.instructions.length === 0) return;

  const {
    registerOffsets: registerBases,
    registerValueCount,
    conditionCarryEvents,
  } = allocateSplatPostDecodeRegisters(program);
  const blockSize = getBlockSize(registerValueCount, processCount);
  for (let index = 0; index < registerBases.length; index += 1) {
    registerBases[index] *= blockSize;
  }
  const registers = new Float32Array(registerValueCount * blockSize);
  const attributeData = new DataView(
    program.attributeData.buffer,
    program.attributeData.byteOffset,
    program.attributeData.byteLength,
  );
  const splat0Float = new Float32Array(
    data.splat0.buffer,
    data.splat0.byteOffset,
    data.splat0.length,
  );

  evaluateProgram(
    data,
    program,
    attributeData,
    splat0Float,
    registers,
    registerBases,
    conditionCarryEvents,
    processCount,
    blockSize,
  );
}
