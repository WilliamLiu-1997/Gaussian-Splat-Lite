import { fuseArithmetic } from "./optimizer.js";
import {
  ATTRIBUTE_FORMAT_BYTES,
  Opcode,
  SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION,
  SPLAT_POST_DECODE_FLOW_STAGE_ON_FALSE,
  SPLAT_POST_DECODE_FLOW_STAGE_ON_TRUE,
  SPLAT_POST_DECODE_FLOW_STAGE_REGISTER,
  SPLAT_POST_DECODE_FLOW_STAGE_START,
  SPLAT_POST_DECODE_FLOW_STAGE_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0,
  SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE,
  SPLAT_POST_DECODE_INSTRUCTION_OPCODE,
  SPLAT_POST_DECODE_INSTRUCTION_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_WIDTH,
  SPLAT_POST_DECODE_MISSING_ARGUMENT,
  TYPE_WIDTHS,
} from "./protocol.js";
class GenerationRegisterMap {
  constructor(size) {
    this.generation = 1;
    this.values = new Int32Array(size);
    this.generations = new Uint32Array(size);
  }
  clear() {
    // A map lives for one compilation, capped at 4096 condition stages.
    this.generation += 1;
  }
  has(source) {
    return this.generations[source] === this.generation;
  }
  get(source) {
    return this.values[source];
  }
  set(source, target) {
    this.generations[source] = this.generation;
    this.values[source] = target;
  }
  delete(source) {
    this.generations[source] = 0;
  }
}
function markDependencies(builder, roots, marked) {
  const pending = [];
  for (const root of roots) {
    if (root === undefined || marked[root]) continue;
    marked[root] = 1;
    pending.push(root);
  }
  while (pending.length !== 0) {
    const register = pending.pop();
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
  constructor(builder) {
    this.builder = builder;
    this.instructions = [];
    this.constants = [];
    this.attributes = [];
    this.constantMap = new Map();
    this.attributeMap = new Map();
    this.dependencyGeneration = 0;
    this.dependencyMarks = new Uint32Array(builder.instructions.length);
  }
  appendDependencies(roots, registers, forceRoots = false) {
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
    const pending = [];
    const sourceOrder = [];
    for (const root of roots) {
      if (root !== undefined && !registers.has(root)) pending.push(root);
    }
    while (pending.length !== 0) {
      const source = pending.pop();
      if (
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
  append(sourceOrder, registers) {
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
      const args = source.args.map((argument) => registers.get(argument));
      registers.set(sourceIndex, this.instructions.length);
      this.instructions.push({ ...source, args, immediate });
    }
  }
  reserveInstruction() {
    if (this.instructions.length >= 4096) {
      throw new Error("postDecode compiled program exceeds 4096 instructions");
    }
  }
}
function emptyCompiledProgram() {
  return {
    instructions: [],
    constants: [],
    outputs: {},
    condition: undefined,
    attributes: [],
  };
}
function remapOutputs(outputs, registers) {
  const remap = (register) =>
    register === undefined ? undefined : registers.get(register);
  return {
    position: remap(outputs.position),
    scale: remap(outputs.scale),
    quaternion: remap(outputs.quaternion),
    opacity: remap(outputs.opacity),
    alpha: remap(outputs.alpha),
    color: remap(outputs.color),
    sh: outputs.sh?.map((register) => registers.get(register)),
  };
}
function compileConditionFlow(builder, outputs, outputRoots, whenRegister) {
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
  const reverseNodes = [];
  const FLOW_AND_LEFT = 0;
  const FLOW_OR_LEFT = 1;
  const FLOW_CONTINUATION_SIZE = 3;
  const continuations = new Int32Array(
    (whenRegister + 1) * FLOW_CONTINUATION_SIZE,
  );
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
  const acceptTarget = stageCount;
  const rejectTarget = acceptTarget + 1;
  const stages = new Uint16Array(
    stageCount * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE,
  );
  const predecessors = new Int32Array(stageCount).fill(-1);
  let acceptPredecessor = -1;
  const recordPredecessor = (target, predecessor) => {
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
  const remapTarget = (target) =>
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
    stages[offset + SPLAT_POST_DECODE_FLOW_STAGE_REGISTER] = pathRegisters.get(
      node.register,
    );
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
export function compileProgram(builder, sourceOutputs) {
  return compileSource(fuseArithmetic(builder, sourceOutputs), sourceOutputs);
}
function compileSource(builder, sourceOutputs) {
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
  const instructionOrder = [];
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
export function packInstructions(instructions) {
  // The builder and compiler cap programs at 4096 instructions with at most
  // four arguments/components each, so registers and immediates fit Uint16.
  const packed = new Uint16Array(
    instructions.length * SPLAT_POST_DECODE_INSTRUCTION_STRIDE,
  );
  packed.fill(SPLAT_POST_DECODE_MISSING_ARGUMENT);
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
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
export function snapshotAttributes(bindings) {
  const attributes = bindings.map(
    ({ format, components, byteStride, count }) => ({
      format,
      components,
      byteOffset: 0,
      byteStride,
      count,
    }),
  );
  const rangesByBuffer = new Map();
  for (const [index, binding] of bindings.entries()) {
    if (binding.count === 0) continue;
    const packedBytes =
      ATTRIBUTE_FORMAT_BYTES[binding.format] * binding.components;
    const start = binding.data.byteOffset + binding.byteOffset;
    const end = start + (binding.count - 1) * binding.byteStride + packedBytes;
    const ranges = rangesByBuffer.get(binding.data.buffer) ?? [];
    ranges.push({ start, end, attribute: attributes[index] });
    rangesByBuffer.set(binding.data.buffer, ranges);
  }
  const regions = [];
  let byteLength = 0;
  for (const [buffer, ranges] of rangesByBuffer) {
    ranges.sort((left, right) => left.start - right.start);
    let region;
    for (const { start, end, attribute } of ranges) {
      if (region && start <= region.end) {
        byteLength += Math.max(0, end - region.end);
        region.end = Math.max(region.end, end);
      } else {
        region = { buffer, start, end, outputOffset: byteLength };
        regions.push(region);
        byteLength += end - start;
      }
      attribute.byteOffset = region.outputOffset + start - region.start;
    }
  }
  const data = new Uint8Array(byteLength);
  for (const region of regions) {
    data.set(
      new Uint8Array(region.buffer, region.start, region.end - region.start),
      region.outputOffset,
    );
  }
  return { data, attributes };
}
