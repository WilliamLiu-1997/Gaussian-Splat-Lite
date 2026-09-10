import { fuseArithmetic } from "./optimizer";
import {
  ATTRIBUTE_FORMAT_BYTES,
  type AttributeBinding,
  Opcode,
  type PostDecodeSource,
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
  type SerializedSplatPostDecodeAttribute,
  type SerializedSplatPostDecodeCondition,
  type SplatPostDecodeInstruction,
  type SplatPostDecodeOutputs,
  TYPE_WIDTHS,
} from "./protocol";

class GenerationRegisterMap {
  private readonly values: Int32Array;
  private readonly generations: Uint32Array;
  private generation = 1;

  constructor(size: number) {
    this.values = new Int32Array(size);
    this.generations = new Uint32Array(size);
  }

  clear() {
    if (this.generation === 0xffff_ffff) {
      this.generations.fill(0);
      this.generation = 1;
    } else {
      this.generation += 1;
    }
  }

  has(source: number) {
    return this.generations[source] === this.generation;
  }

  get(source: number) {
    return this.has(source) ? this.values[source] : undefined;
  }

  set(source: number, target: number) {
    this.generations[source] = this.generation;
    this.values[source] = target;
  }

  delete(source: number) {
    this.generations[source] = 0;
  }
}

type CompiledProgram = {
  instructions: SplatPostDecodeInstruction[];
  constants: number[];
  outputs: Omit<SplatPostDecodeOutputs, "when">;
  condition?: SerializedSplatPostDecodeCondition;
  attributes: AttributeBinding[];
};

function markDependencies(
  builder: PostDecodeSource,
  roots: readonly (number | undefined)[],
  marked: Uint8Array,
) {
  const pending: number[] = [];
  for (const root of roots) {
    if (root === undefined || marked[root]) continue;
    marked[root] = 1;
    pending.push(root);
  }
  while (pending.length !== 0) {
    const register = pending.pop();
    if (register === undefined) break;
    for (const argument of builder.instructions[register].args) {
      if (marked[argument]) continue;
      marked[argument] = 1;
      pending.push(argument);
    }
  }
}

/**
 * Serializes source instructions while remapping only live registers. A
 * generation map represents the current straight-line path. Branch merges
 * advance its generation in O(1), while unique predecessors reuse it. One
 * generation array is also shared by every dependency walk.
 */
class InstructionSerializer {
  readonly instructions: SplatPostDecodeInstruction[] = [];
  readonly constants: number[] = [];
  readonly attributes: AttributeBinding[] = [];

  private readonly constantMap = new Map<number, number>();
  private readonly attributeMap = new Map<number, number>();
  private readonly dependencyMarks: Uint32Array;
  private dependencyGeneration = 0;

  constructor(private readonly builder: PostDecodeSource) {
    this.dependencyMarks = new Uint32Array(builder.instructions.length);
  }

  appendDependencies(
    roots: readonly (number | undefined)[],
    registers: GenerationRegisterMap,
    forceRoots = false,
  ) {
    if (forceRoots) {
      for (const root of roots) {
        if (
          root !== undefined &&
          this.builder.instructions[root].opcode !== Opcode.Constant
        ) {
          registers.delete(root);
        }
      }
    }

    this.dependencyGeneration += 1;
    const generation = this.dependencyGeneration;
    const pending: number[] = [];
    const sourceOrder: number[] = [];
    for (const root of roots) {
      if (root !== undefined && !registers.has(root)) pending.push(root);
    }
    while (pending.length !== 0) {
      const source = pending.pop();
      if (
        source === undefined ||
        registers.has(source) ||
        this.dependencyMarks[source] === generation
      ) {
        continue;
      }
      this.dependencyMarks[source] = generation;
      sourceOrder.push(source);
      for (const argument of this.builder.instructions[source].args) {
        if (!registers.has(argument)) pending.push(argument);
      }
    }

    sourceOrder.sort((left, right) => left - right);
    this.append(sourceOrder, registers);
    return registers;
  }

  append(sourceOrder: readonly number[], registers: GenerationRegisterMap) {
    for (const sourceIndex of sourceOrder) {
      const source = this.builder.instructions[sourceIndex];
      if (source.opcode === Opcode.Constant) {
        let target = this.constantMap.get(sourceIndex);
        if (target === undefined) {
          this.reserveInstruction();
          target = this.instructions.length;
          this.constantMap.set(sourceIndex, target);
          const immediate = this.constants.length;
          this.constants.push(
            ...this.builder.constants.slice(
              source.immediate,
              source.immediate + TYPE_WIDTHS[source.type],
            ),
          );
          this.instructions.push({ ...source, immediate });
        }
        registers.set(sourceIndex, target);
        continue;
      }

      this.reserveInstruction();
      let immediate = source.immediate;
      if (source.opcode === Opcode.InputAttribute) {
        let target = this.attributeMap.get(immediate);
        if (target === undefined) {
          target = this.attributes.length;
          this.attributeMap.set(immediate, target);
          this.attributes.push(this.builder.attributes[immediate]);
        }
        immediate = target;
      }
      const args = source.args.map((argument) => {
        const target = registers.get(argument);
        if (target === undefined) {
          throw new Error("Invalid postDecode instruction dependency");
        }
        return target;
      });
      registers.set(sourceIndex, this.instructions.length);
      this.instructions.push({ ...source, args, immediate });
    }
  }

  private reserveInstruction() {
    if (this.instructions.length >= 4096) {
      throw new Error("postDecode compiled program exceeds 4096 instructions");
    }
  }
}

function emptyCompiledProgram(): CompiledProgram {
  return {
    instructions: [],
    constants: [],
    outputs: {},
    condition: undefined,
    attributes: [],
  };
}

function remapOutputs(
  outputs: SplatPostDecodeOutputs,
  registers: GenerationRegisterMap,
): Omit<SplatPostDecodeOutputs, "when"> {
  const remap = (register: number | undefined) =>
    register === undefined ? undefined : registers.get(register);
  return {
    position: remap(outputs.position),
    scale: remap(outputs.scale),
    quaternion: remap(outputs.quaternion),
    opacity: remap(outputs.opacity),
    alpha: remap(outputs.alpha),
    color: remap(outputs.color),
    sh: outputs.sh?.map((register) => {
      const target = registers.get(register);
      if (target === undefined) {
        throw new Error("Invalid postDecode output dependency");
      }
      return target;
    }),
  };
}

type FlowNode = {
  register: number;
  onTrue: number;
  onFalse: number;
};

function compileConditionFlow(
  builder: PostDecodeSource,
  outputs: SplatPostDecodeOutputs,
  outputRoots: readonly (number | undefined)[],
  whenRegister: number,
): CompiledProgram | undefined {
  const FLOW_ACCEPT = -1;
  const FLOW_REJECT = -2;
  const FLOW_DYNAMIC = 0;
  const FLOW_CONSTANT_FALSE = 1;
  const FLOW_CONSTANT_TRUE = 2;
  const constantValues = new Uint8Array(whenRegister + 1);
  for (let register = 0; register <= whenRegister; register += 1) {
    const instruction = builder.instructions[register];
    if (instruction.opcode === Opcode.Constant && instruction.type === "bool") {
      constantValues[register] = builder.constants[instruction.immediate]
        ? FLOW_CONSTANT_TRUE
        : FLOW_CONSTANT_FALSE;
      continue;
    }
    const left = constantValues[instruction.args[0]];
    if (instruction.opcode === Opcode.Not) {
      constantValues[register] =
        left === FLOW_CONSTANT_TRUE
          ? FLOW_CONSTANT_FALSE
          : left === FLOW_CONSTANT_FALSE
            ? FLOW_CONSTANT_TRUE
            : FLOW_DYNAMIC;
    } else if (instruction.opcode === Opcode.And) {
      const right = constantValues[instruction.args[1]];
      constantValues[register] =
        left === FLOW_CONSTANT_FALSE || right === FLOW_CONSTANT_FALSE
          ? FLOW_CONSTANT_FALSE
          : left === FLOW_CONSTANT_TRUE && right === FLOW_CONSTANT_TRUE
            ? FLOW_CONSTANT_TRUE
            : FLOW_DYNAMIC;
    } else if (instruction.opcode === Opcode.Or) {
      const right = constantValues[instruction.args[1]];
      constantValues[register] =
        left === FLOW_CONSTANT_TRUE || right === FLOW_CONSTANT_TRUE
          ? FLOW_CONSTANT_TRUE
          : left === FLOW_CONSTANT_FALSE && right === FLOW_CONSTANT_FALSE
            ? FLOW_CONSTANT_FALSE
            : FLOW_DYNAMIC;
    }
  }

  const reverseNodes: FlowNode[] = [];
  const FLOW_AND_LEFT = 0;
  const FLOW_OR_LEFT = 1;
  const FLOW_CONTINUATION_SIZE = 3;
  let continuations: Int32Array | undefined;
  let continuationEnd = 0;
  let register = whenRegister;
  let onTrue = FLOW_ACCEPT;
  let onFalse = FLOW_REJECT;
  let compiledTarget = FLOW_REJECT;
  while (true) {
    const constant = constantValues[register];
    if (constant !== FLOW_DYNAMIC) {
      compiledTarget = constant === FLOW_CONSTANT_TRUE ? onTrue : onFalse;
    } else {
      const instruction = builder.instructions[register];
      if (instruction.opcode === Opcode.Not) {
        register = instruction.args[0];
        const target = onTrue;
        onTrue = onFalse;
        onFalse = target;
        continue;
      }
      if (
        instruction.opcode === Opcode.And ||
        instruction.opcode === Opcode.Or
      ) {
        continuations ??= new Int32Array(
          (whenRegister + 1) * FLOW_CONTINUATION_SIZE,
        );
        if (continuationEnd === continuations.length) {
          throw new Error("Invalid postDecode condition depth");
        }
        const isAnd = instruction.opcode === Opcode.And;
        continuations[continuationEnd] = isAnd ? FLOW_AND_LEFT : FLOW_OR_LEFT;
        continuations[continuationEnd + 1] = instruction.args[0];
        continuations[continuationEnd + 2] = isAnd ? onFalse : onTrue;
        continuationEnd += FLOW_CONTINUATION_SIZE;
        register = instruction.args[1];
        continue;
      }
      if (reverseNodes.length >= 4096) {
        throw new Error("postDecode condition exceeds 4096 flow nodes");
      }
      compiledTarget = reverseNodes.length;
      reverseNodes.push({ register, onTrue, onFalse });
    }

    if (continuationEnd === 0) break;
    continuationEnd -= FLOW_CONTINUATION_SIZE;
    if (!continuations) {
      throw new Error("Invalid postDecode condition continuation");
    }
    const type = continuations[continuationEnd];
    register = continuations[continuationEnd + 1];
    const target = continuations[continuationEnd + 2];
    if (type === FLOW_AND_LEFT) {
      onTrue = compiledTarget;
      onFalse = target;
    } else {
      onTrue = target;
      onFalse = compiledTarget;
    }
  }

  const entry = compiledTarget;
  if (entry === FLOW_REJECT) return emptyCompiledProgram();
  if (entry === FLOW_ACCEPT) {
    outputs.when = undefined;
    return undefined;
  }

  const stageCount = reverseNodes.length;
  if (entry !== stageCount - 1) {
    throw new Error("Invalid postDecode condition flow");
  }

  const acceptTarget = stageCount;
  const rejectTarget = acceptTarget + 1;
  const stages = new Uint16Array(
    stageCount * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE,
  );
  const predecessors = new Int32Array(stageCount).fill(-1);
  let acceptPredecessor = -1;
  const recordPredecessor = (target: number, predecessor: number) => {
    if (target === rejectTarget) return;
    if (target === acceptTarget) {
      acceptPredecessor =
        acceptPredecessor === -1
          ? predecessor
          : acceptPredecessor === predecessor
            ? predecessor
            : -2;
      return;
    }
    predecessors[target] =
      predecessors[target] === -1
        ? predecessor
        : predecessors[target] === predecessor
          ? predecessor
          : -2;
  };
  const remapTarget = (target: number) =>
    target === FLOW_ACCEPT
      ? acceptTarget
      : target === FLOW_REJECT
        ? rejectTarget
        : stageCount - 1 - target;

  for (let stage = 0; stage < stageCount; stage += 1) {
    const node = reverseNodes[stageCount - 1 - stage];
    const offset = stage * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE;
    const onTrue = remapTarget(node.onTrue);
    const onFalse = remapTarget(node.onFalse);
    stages[offset + SPLAT_POST_DECODE_FLOW_STAGE_ON_TRUE] = onTrue;
    stages[offset + SPLAT_POST_DECODE_FLOW_STAGE_ON_FALSE] = onFalse;
    recordPredecessor(onTrue, stage);
    recordPredecessor(onFalse, stage);
  }

  const serializer = new InstructionSerializer(builder);
  const pathRegisters = new GenerationRegisterMap(builder.instructions.length);
  for (let stage = 0; stage < stageCount; stage += 1) {
    if (stage === 0 || predecessors[stage] !== stage - 1) {
      pathRegisters.clear();
    }
    const node = reverseNodes[stageCount - 1 - stage];
    const offset = stage * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE;
    stages[offset + SPLAT_POST_DECODE_FLOW_STAGE_START] =
      serializer.instructions.length;
    serializer.appendDependencies([node.register], pathRegisters, true);
    stages[offset + SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION] =
      serializer.instructions.length - 1;
    const predicateRegister = pathRegisters.get(node.register);
    if (predicateRegister === undefined) {
      throw new Error("Invalid postDecode condition register");
    }
    stages[offset + SPLAT_POST_DECODE_FLOW_STAGE_REGISTER] = predicateRegister;
  }

  if (acceptPredecessor !== stageCount - 1) pathRegisters.clear();
  serializer.appendDependencies(outputRoots, pathRegisters);
  return {
    instructions: serializer.instructions,
    constants: serializer.constants,
    outputs: remapOutputs(outputs, pathRegisters),
    condition: { stages },
    attributes: serializer.attributes,
  };
}

export function compileProgram(
  builder: PostDecodeSource,
  sourceOutputs: SplatPostDecodeOutputs,
): CompiledProgram {
  return compileSource(fuseArithmetic(builder, sourceOutputs), sourceOutputs);
}

function compileSource(
  builder: PostDecodeSource,
  sourceOutputs: SplatPostDecodeOutputs,
): CompiledProgram {
  const outputs = { ...sourceOutputs };
  if (outputs.when !== undefined) {
    const condition = builder.instructions[outputs.when];
    if (condition.opcode === Opcode.Constant) {
      if (builder.constants[condition.immediate] === 0) {
        return emptyCompiledProgram();
      }
      outputs.when = undefined;
    }
  }

  const outputRoots = [
    outputs.position,
    outputs.scale,
    outputs.quaternion,
    outputs.opacity,
    outputs.alpha,
    outputs.color,
    ...(outputs.sh ?? []),
  ];
  if (outputs.when !== undefined) {
    const flow = compileConditionFlow(
      builder,
      outputs,
      outputRoots,
      outputs.when,
    );
    if (flow) return flow;
  }

  const live = new Uint8Array(builder.instructions.length);
  markDependencies(builder, outputRoots, live);
  const instructionOrder: number[] = [];
  for (let register = 0; register < live.length; register += 1) {
    if (live[register]) instructionOrder.push(register);
  }

  const serializer = new InstructionSerializer(builder);
  const registers = new GenerationRegisterMap(builder.instructions.length);
  serializer.append(instructionOrder, registers);
  return {
    instructions: serializer.instructions,
    constants: serializer.constants,
    outputs: remapOutputs(outputs, registers),
    attributes: serializer.attributes,
  };
}

export function packInstructions(
  instructions: readonly SplatPostDecodeInstruction[],
): Uint16Array {
  const packed = new Uint16Array(
    instructions.length * SPLAT_POST_DECODE_INSTRUCTION_STRIDE,
  );
  packed.fill(SPLAT_POST_DECODE_MISSING_ARGUMENT);
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (
      instruction.args.length > SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_COUNT ||
      !Number.isInteger(instruction.immediate) ||
      instruction.immediate < 0 ||
      instruction.immediate > 0xffff ||
      instruction.args.some(
        (argument) =>
          !Number.isInteger(argument) ||
          argument < 0 ||
          argument >= SPLAT_POST_DECODE_MISSING_ARGUMENT,
      )
    ) {
      throw new Error("postDecode instruction exceeds Uint16 bytecode limits");
    }
    const offset = index * SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
    packed[offset + SPLAT_POST_DECODE_INSTRUCTION_OPCODE] = instruction.opcode;
    packed[offset + SPLAT_POST_DECODE_INSTRUCTION_WIDTH] =
      TYPE_WIDTHS[instruction.type];
    packed[offset + SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE] =
      instruction.immediate;
    for (let argument = 0; argument < instruction.args.length; argument += 1) {
      packed[offset + SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0 + argument] =
        instruction.args[argument];
    }
  }
  return packed;
}

type AttributeRegion = {
  buffer: ArrayBufferLike;
  start: number;
  end: number;
  outputOffset: number;
};

export function snapshotAttributes(bindings: readonly AttributeBinding[]) {
  const rangesByBuffer = new Map<
    ArrayBufferLike,
    { start: number; end: number }[]
  >();
  for (const binding of bindings) {
    if (binding.count === 0) continue;
    const packedBytes =
      ATTRIBUTE_FORMAT_BYTES[binding.format] * binding.components;
    const start = binding.data.byteOffset + binding.byteOffset;
    const end = start + (binding.count - 1) * binding.byteStride + packedBytes;
    const ranges = rangesByBuffer.get(binding.data.buffer) ?? [];
    ranges.push({ start, end });
    rangesByBuffer.set(binding.data.buffer, ranges);
  }

  const regions: AttributeRegion[] = [];
  const regionsByBuffer = new Map<ArrayBufferLike, AttributeRegion[]>();
  for (const [buffer, ranges] of rangesByBuffer) {
    ranges.sort((left, right) => left.start - right.start);
    const bufferRegions: AttributeRegion[] = [];
    for (const range of ranges) {
      const previous = bufferRegions[bufferRegions.length - 1];
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        const region = { buffer, ...range, outputOffset: 0 };
        bufferRegions.push(region);
        regions.push(region);
      }
    }
    regionsByBuffer.set(buffer, bufferRegions);
  }

  let byteLength = 0;
  for (const region of regions) {
    region.outputOffset = byteLength;
    byteLength += region.end - region.start;
  }
  const data = new Uint8Array(byteLength);
  for (const region of regions) {
    data.set(
      new Uint8Array(region.buffer, region.start, region.end - region.start),
      region.outputOffset,
    );
  }

  const attributes: SerializedSplatPostDecodeAttribute[] = bindings.map(
    (binding) => {
      let byteOffset = 0;
      if (binding.count !== 0) {
        const sourceOffset = binding.data.byteOffset + binding.byteOffset;
        const region = regionsByBuffer
          .get(binding.data.buffer)
          ?.find(
            (candidate) =>
              sourceOffset >= candidate.start && sourceOffset < candidate.end,
          );
        if (!region) {
          throw new Error("postDecode attribute view was not serialized");
        }
        byteOffset = region.outputOffset + sourceOffset - region.start;
      }
      return {
        format: binding.format,
        components: binding.components,
        byteOffset,
        byteStride: binding.byteStride,
        count: binding.count,
      };
    },
  );
  return { data, attributes };
}
