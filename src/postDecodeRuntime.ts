import { fromHalf, toHalf } from "./float16";
import {
  ATTRIBUTE_FORMAT_BYTES,
  InputField,
  Opcode,
  SH_COEFFICIENT_COUNT,
  type SerializedSplatPostDecode,
  type SerializedSplatPostDecodeAttribute,
  TYPE_WIDTHS,
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
  const instructionCount = instructions.length;
  const lastUses = new Uint32Array(instructionCount);
  for (let index = 0; index < instructionCount; index += 1) {
    lastUses[index] = index;
    for (const argument of instructions[index].args) {
      lastUses[argument] = index;
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
    if (instructions[index].opcode === Opcode.Constant) {
      constantRegisters[index] = 1;
      lastUses[index] = programEnd;
      registerOffsets[index] = registerValueCount;
      registerValueCount += TYPE_WIDTHS[instructions[index].type];
    }
  }

  const releases: FreeRegisterRange[][] = Array.from(
    { length: instructionCount },
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
    const width = TYPE_WIDTHS[instructions[index].type];
    const offset = allocate(width);
    registerOffsets[index] = offset;
    const releaseIndex = lastUses[index] + 1;
    if (releaseIndex < instructionCount) {
      releases[releaseIndex].push({ offset, width });
    }
  }

  const conditionCarryOffsets: number[] = [];
  const conditionEnd = outputs.when === undefined ? 0 : outputs.when + 1;
  for (let index = 0; index < conditionEnd; index += 1) {
    if (constantRegisters[index] || lastUses[index] < conditionEnd) continue;
    const offset = registerOffsets[index];
    const width = TYPE_WIDTHS[instructions[index].type];
    for (let lane = 0; lane < width; lane += 1) {
      conditionCarryOffsets.push(offset + lane);
    }
  }

  return {
    registerOffsets,
    registerValueCount,
    conditionCarryOffsets: new Uint32Array(conditionCarryOffsets),
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

function filterConditionBlock(
  registers: Float32Array,
  conditionBase: number,
  carryOffsets: Uint32Array,
  sourceIndices: Uint16Array,
  blockCount: number,
  blockSize: number,
) {
  let activeCount = 0;
  for (let index = 0; index < blockCount; index += 1) {
    if (registers[conditionBase + index] !== 0) {
      sourceIndices[activeCount++] = index;
    }
  }
  if (activeCount === 0 || activeCount === blockCount) return activeCount;

  for (const offset of carryOffsets) {
    const base = offset * blockSize;
    // Matches are collected in ascending order, so this forward in-place copy
    // never overwrites a source lane that has not been read yet.
    for (let index = 0; index < activeCount; index += 1) {
      registers[base + index] = registers[base + sourceIndices[index]];
    }
  }
  return activeCount;
}

function evaluateProgram(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  attributeData: DataView,
  splat0Float: Float32Array,
  registers: Float32Array,
  registerOffsets: Uint32Array,
  conditionCarryOffsets: Uint32Array,
  processCount: number,
  blockSize: number,
) {
  const { attributes, constants, instructions, outputs } = program;
  const whenRegister = outputs.when;
  const activeIndices =
    whenRegister === undefined ? undefined : new Uint16Array(blockSize);
  // SoA layout: each vector lane owns blockSize contiguous register values.
  for (
    let instructionIndex = 0;
    instructionIndex < instructions.length;
    instructionIndex += 1
  ) {
    const instruction = instructions[instructionIndex];
    if (instruction.opcode !== Opcode.Constant) continue;
    const outputBase = registerOffsets[instructionIndex] * blockSize;
    const width = TYPE_WIDTHS[instruction.type];
    for (let lane = 0; lane < width; lane += 1) {
      registers.fill(
        constants[instruction.immediate + lane],
        outputBase + lane * blockSize,
        outputBase + (lane + 1) * blockSize,
      );
    }
  }

  for (let blockStart = 0; blockStart < processCount; blockStart += blockSize) {
    let blockCount = Math.min(blockSize, processCount - blockStart);
    let sourceIndices: Uint16Array | undefined;
    for (
      let instructionIndex = 0;
      instructionIndex < instructions.length;
      instructionIndex += 1
    ) {
      const instruction = instructions[instructionIndex];
      const { args, immediate, opcode, type } = instruction;
      if (opcode === Opcode.Constant) continue;
      const outputBase = registerOffsets[instructionIndex] * blockSize;
      const width = TYPE_WIDTHS[type];
      const arg0 = registerOffsets[args[0] ?? 0] * blockSize;
      const arg1 = registerOffsets[args[1] ?? 0] * blockSize;
      const arg2 = registerOffsets[args[2] ?? 0] * blockSize;
      const arg0Width =
        args[0] === undefined ? 0 : TYPE_WIDTHS[instructions[args[0]].type];
      const arg1Width =
        args[1] === undefined ? 0 : TYPE_WIDTHS[instructions[args[1]].type];
      const arg2Width =
        args[2] === undefined ? 0 : TYPE_WIDTHS[instructions[args[2]].type];

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
              registers[output + index] = Math.sqrt(registers[input + index]);
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
                  ? rustMin(registers[left + index], registers[right + index])
                  : rustMax(registers[left + index], registers[right + index]);
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
              registers[arg0 + index] * registers[arg1 + blockSize * 2 + index];
            registers[outputBase + blockSize * 2 + index] =
              registers[arg0 + index] * registers[arg1 + blockSize + index] -
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
                ? registers[arg0 + index] !== 0 && registers[arg1 + index] !== 0
                : registers[arg0 + index] !== 0 || registers[arg1 + index] !== 0
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
              leftW * rightX + leftX * rightW + leftY * rightZ - leftZ * rightY;
            registers[outputBase + blockSize + index] =
              leftW * rightY - leftX * rightZ + leftY * rightW + leftZ * rightX;
            registers[outputBase + blockSize * 2 + index] =
              leftW * rightZ + leftX * rightY - leftY * rightX + leftZ * rightW;
            registers[outputBase + blockSize * 3 + index] =
              leftW * rightW - leftX * rightX - leftY * rightY - leftZ * rightZ;
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
            const crossX = 2 * (quaternionY * vectorZ - quaternionZ * vectorY);
            const crossY = 2 * (quaternionZ * vectorX - quaternionX * vectorZ);
            const crossZ = 2 * (quaternionX * vectorY - quaternionY * vectorX);
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
            registers[outputBase + blockSize + index] = registers[arg1 + index];
            if (width >= 3) {
              registers[outputBase + blockSize * 2 + index] =
                registers[arg2 + index];
            }
            if (width === 4) {
              registers[outputBase + blockSize * 3 + index] =
                registers[registerOffsets[args[3] ?? 0] * blockSize + index];
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

      // Serialization guarantees that the dynamic condition and all of its
      // dependencies form the prefix ending at `whenRegister`.
      if (instructionIndex === whenRegister && activeIndices) {
        const conditionBase = registerOffsets[whenRegister] * blockSize;
        const activeCount = filterConditionBlock(
          registers,
          conditionBase,
          conditionCarryOffsets,
          activeIndices,
          blockCount,
          blockSize,
        );
        if (activeCount !== blockCount) {
          if (activeCount !== 0) sourceIndices = activeIndices;
          blockCount = activeCount;
          if (blockCount === 0) break;
        }
      }
    }
    for (let index = 0; index < blockCount; index += 1) {
      writeOutputs(
        data,
        splat0Float,
        program,
        registers,
        registerOffsets,
        blockSize,
        index,
        blockStart + (sourceIndices?.[index] ?? index),
      );
    }
  }
}

function writeOutputs(
  data: PostDecodeSplatData,
  splat0Float: Float32Array,
  program: SerializedSplatPostDecode,
  registers: Float32Array,
  registerOffsets: Uint32Array,
  blockSize: number,
  blockIndex: number,
  splatIndex: number,
) {
  const { outputs } = program;
  const wordBase = splatIndex * 4;
  if (outputs.position !== undefined) {
    const base = registerOffsets[outputs.position] * blockSize + blockIndex;
    splat0Float[wordBase] = registers[base];
    splat0Float[wordBase + 1] = registers[base + blockSize];
    splat0Float[wordBase + 2] = registers[base + blockSize * 2];
  }
  if (outputs.scale !== undefined) {
    const base = registerOffsets[outputs.scale] * blockSize + blockIndex;
    const first = data.splat1[wordBase + 1] & 0xffff;
    data.splat1[wordBase + 1] =
      (first | (toHalf(Math.log(registers[base])) << 16)) >>> 0;
    data.splat1[wordBase + 2] =
      (toHalf(Math.log(registers[base + blockSize])) |
        (toHalf(Math.log(registers[base + blockSize * 2])) << 16)) >>>
      0;
  }
  if (outputs.quaternion !== undefined) {
    const base = registerOffsets[outputs.quaternion] * blockSize + blockIndex;
    const encoded = encodeQuaternion(registers, base, blockSize);
    if (encoded !== undefined) data.splat1[wordBase + 3] = encoded;
  }
  if (outputs.opacity !== undefined) {
    const base = registerOffsets[outputs.opacity] * blockSize + blockIndex;
    data.splat0[wordBase + 3] = encodeSplatOpacity(registers[base]);
  }
  if (outputs.alpha !== undefined) {
    const base = registerOffsets[outputs.alpha] * blockSize + blockIndex;
    data.splat0[wordBase + 3] =
      ((data.splat0[wordBase + 3] & 0xffff_0000) |
        toHalf(clamp(registers[base], 0, 1))) >>>
      0;
  }
  if (outputs.color !== undefined) {
    const base = registerOffsets[outputs.color] * blockSize + blockIndex;
    data.splat1[wordBase] =
      (toHalf(registers[base]) |
        (toHalf(registers[base + blockSize]) << 16)) >>>
      0;
    data.splat1[wordBase + 1] =
      ((data.splat1[wordBase + 1] & 0xffff_0000) |
        toHalf(registers[base + blockSize * 2])) >>>
      0;
  }
  if (outputs.sh) {
    for (
      let coefficient = 0;
      coefficient < SH_COEFFICIENT_COUNT;
      coefficient += 1
    ) {
      const location = shWord(data, coefficient);
      if (location) {
        const base =
          registerOffsets[outputs.sh[coefficient]] * blockSize + blockIndex;
        location[0][wordBase + location[1]] = encodeSh(
          registers,
          base,
          blockSize,
        );
      }
    }
  }

  if (outputs.position !== undefined || outputs.scale !== undefined) {
    const disabled =
      data.splat1[wordBase + 1] >>> 16 === 0xfc00 &&
      (data.splat1[wordBase + 2] & 0xffff) === 0xfc00 &&
      data.splat1[wordBase + 2] >>> 16 === 0xfc00;
    const centerBase = splatIndex * 3;
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

export function applySplatPostDecode(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
) {
  let processCount = data.numSplats;
  for (const attribute of program.attributes) {
    processCount = Math.min(processCount, attribute.count);
  }
  if (processCount === 0 || program.instructions.length === 0) return;

  const { registerOffsets, registerValueCount, conditionCarryOffsets } =
    allocateSplatPostDecodeRegisters(program);
  const blockSize = getBlockSize(registerValueCount, processCount);
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
    registerOffsets,
    conditionCarryOffsets,
    processCount,
    blockSize,
  );
}
