import {
  encodeShRgb,
  encodeSplatOpacity,
  tryEncodeQuatOctXy1010R12,
} from "../../data/splatCodec";
import { toHalf } from "../../utils/numeric";
import { executeRange, shWord } from "./operations";
import {
  Opcode,
  type PostDecodeSplatData,
  SH_COEFFICIENT_COUNT,
  SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION,
  SPLAT_POST_DECODE_FLOW_STAGE_ON_FALSE,
  SPLAT_POST_DECODE_FLOW_STAGE_ON_TRUE,
  SPLAT_POST_DECODE_FLOW_STAGE_REGISTER,
  SPLAT_POST_DECODE_FLOW_STAGE_START,
  SPLAT_POST_DECODE_FLOW_STAGE_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE,
  SPLAT_POST_DECODE_INSTRUCTION_OPCODE,
  SPLAT_POST_DECODE_INSTRUCTION_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_WIDTH,
  type SerializedSplatPostDecode,
} from "./protocol";
import {
  CONDITION_CARRY_EVENT_OFFSET_MASK,
  CONDITION_CARRY_EVENT_REMOVAL,
  allocateSplatPostDecodeRegisters,
  getInstructionCount,
} from "./registers";

const MAX_BLOCK_SIZE = 512;

const MAX_REGISTER_BYTES = 4 * 1024 ** 2;

function getBlockSize(registerValueCount: number, processCount: number) {
  const bytesPerSplat = registerValueCount * Float32Array.BYTES_PER_ELEMENT;
  return Math.min(
    processCount,
    MAX_BLOCK_SIZE,
    Math.max(1, Math.floor(MAX_REGISTER_BYTES / bytesPerSplat)),
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

function encodeSh(registers: Float32Array, base: number, stride: number) {
  return encodeShRgb(
    registers[base],
    registers[base + stride],
    registers[base + stride * 2],
  );
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

type RuntimePlan = {
  outputPlan: OutputWritePlan;
  registerBases: Uint32Array;
  conditionStages?: Uint16Array;
  conditionStageCount: number;
  outputInstructionStart: number;
  conditionCarryStageStarts: Uint32Array;
  conditionCarryEvents: Uint32Array;
  blockSize: number;
  registerValueCount: number;
};

function prepareProgram(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  processCount: number,
): RuntimePlan {
  const {
    registerOffsets: registerBases,
    registerValueCount,
    conditionCarryStageStarts,
    conditionCarryEvents,
  } = allocateSplatPostDecodeRegisters(program);
  const blockSize = getBlockSize(registerValueCount, processCount);
  for (let index = 0; index < registerBases.length; index += 1) {
    registerBases[index] *= blockSize;
  }
  const conditionStages = program.condition?.stages;
  const conditionStageCount =
    (conditionStages?.length ?? 0) / SPLAT_POST_DECODE_FLOW_STAGE_STRIDE;
  const outputInstructionStart =
    (conditionStages?.[
      conditionStages.length -
        SPLAT_POST_DECODE_FLOW_STAGE_STRIDE +
        SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION
    ] ?? -1) + 1;
  return {
    outputPlan: createOutputWritePlan(data, program, registerBases),
    registerBases,
    conditionStages,
    conditionStageCount,
    outputInstructionStart,
    conditionCarryStageStarts,
    conditionCarryEvents,
    blockSize,
    registerValueCount,
  };
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
    // Ascending lanes make this forward in-place copy safe.
    for (let index = 0; index < nextCount; index += 1) {
      registers[base + index] = registers[base + laneIndices[index]];
    }
  }
}

type ConditionCarryState = {
  stageStarts: Uint32Array;
  events: Uint32Array;
  nextStage: number;
  activeOffsets: Uint16Array;
  activePositions: Int32Array;
  activeCount: number;
};

function applyConditionCarryEvents(carry: ConditionCarryState, stage: number) {
  while (carry.nextStage <= stage) {
    const eventStart = carry.stageStarts[carry.nextStage];
    const eventEnd = carry.stageStarts[carry.nextStage + 1];
    for (let eventIndex = eventStart; eventIndex < eventEnd; eventIndex += 1) {
      const event = carry.events[eventIndex];
      const offset = event & CONDITION_CARRY_EVENT_OFFSET_MASK;
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
    carry.nextStage += 1;
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
  if (stage < 0 || stage >= heads.length) return;
  nextIndices[sourceIndex] = heads[stage];
  heads[stage] = sourceIndex;
}

function runProgram(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  plan: RuntimePlan,
  attributeData: DataView,
  splat0Float: Float32Array,
  registers: Float32Array,
  processCount: number,
) {
  const { constants, instructions } = program;
  const {
    registerBases,
    conditionStages: packedStages,
    conditionStageCount,
    outputInstructionStart,
    conditionCarryStageStarts,
    conditionCarryEvents,
    blockSize,
    outputPlan,
  } = plan;
  const instructionCount = getInstructionCount(instructions);

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
          stageStarts: conditionCarryStageStarts,
          events: conditionCarryEvents,
          nextStage: 0,
          activeOffsets: new Uint16Array(registers.length / blockSize),
          activePositions: new Int32Array(registers.length / blockSize).fill(
            -1,
          ),
          activeCount: 0,
        };
  const outputWordBases = outputPlan.writesOutputs
    ? new Uint32Array(blockSize)
    : undefined;

  for (let instruction = 0; instruction < instructionCount; instruction += 1) {
    const instructionOffset =
      instruction * SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
    if (
      instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_OPCODE] !==
      Opcode.Constant
    ) {
      continue;
    }
    const outputBase = registerBases[instruction];
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
      carry.nextStage = 0;
      carry.activeCount = 0;
    }

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
        executeRange(
          data,
          program,
          attributeData,
          splat0Float,
          registers,
          registerBases,
          instructionStart,
          instructionEnd,
          blockStart,
          blockCount,
          blockSize,
          sourceIndices,
        );
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
          // laneIndices may be the first compacted source map; routing then
          // switches to the separately preserved sourceIndices map.
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

  const plan = prepareProgram(data, program, processCount);
  const registers = new Float32Array(plan.registerValueCount * plan.blockSize);
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

  runProgram(
    data,
    program,
    plan,
    attributeData,
    splat0Float,
    registers,
    processCount,
  );
}
