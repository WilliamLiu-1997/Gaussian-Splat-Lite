import {
  decodeQuatOctXy1010R12ToArray,
  decodeShRgbToArray,
  decodeSplatOpacity,
} from "../../data/splatCodec";
import { fromHalf } from "../../utils/numeric";
import {
  ATTRIBUTE_FORMAT_BYTES,
  InputField,
  Opcode,
  type PostDecodeSplatData,
  SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0,
  SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE,
  SPLAT_POST_DECODE_INSTRUCTION_OPCODE,
  SPLAT_POST_DECODE_INSTRUCTION_STRIDE,
  SPLAT_POST_DECODE_INSTRUCTION_WIDTH,
  SPLAT_POST_DECODE_MISSING_ARGUMENT,
  type SerializedSplatPostDecode,
  type SerializedSplatPostDecodeAttribute,
} from "./protocol";
import { instructionWidth } from "./registers";

// Packed log-scales have only 65536 possible inputs. Populate on demand so
// small pages do not pay for a full table, and reuse it across worker loads.
let scaleValues: Float32Array | undefined;
let scaleValuesReady: Uint8Array | undefined;

function decodeScale(word: number) {
  scaleValues ??= new Float32Array(0x1_0000);
  scaleValuesReady ??= new Uint8Array(0x1_0000);
  const values = scaleValues;
  const ready = scaleValuesReady;
  if (!ready[word]) {
    values[word] = Math.exp(fromHalf(word));
    ready[word] = 1;
  }
  return values[word];
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

export function shWord(
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
        registers[outputBase + index] = decodeScale(word1 >>> 16);
        registers[outputBase + blockSize + index] = decodeScale(word2 & 0xffff);
        registers[outputBase + blockSize * 2 + index] = decodeScale(
          word2 >>> 16,
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
          decodeShRgbToArray(
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

function evaluateUnaryBlock(
  opcode: Opcode,
  registers: Float32Array,
  outputBase: number,
  inputBase: number,
  width: number,
  blockSize: number,
  blockCount: number,
) {
  for (let component = 0; component < width; component += 1) {
    const output = outputBase + component * blockSize;
    const input = inputBase + component * blockSize;
    switch (opcode) {
      case Opcode.Negate:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = -registers[input + lane];
        }
        break;
      case Opcode.Abs:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.abs(registers[input + lane]);
        }
        break;
      case Opcode.Log:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.log(registers[input + lane]);
        }
        break;
      case Opcode.Exp:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.exp(registers[input + lane]);
        }
        break;
      case Opcode.Floor:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.floor(registers[input + lane]);
        }
        break;
      case Opcode.Ceil:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.ceil(registers[input + lane]);
        }
        break;
      case Opcode.Round:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = roundAwayFromZero(registers[input + lane]);
        }
        break;
      case Opcode.Sin:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.sin(registers[input + lane]);
        }
        break;
      case Opcode.Cos:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.cos(registers[input + lane]);
        }
        break;
      case Opcode.Acos:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.acos(registers[input + lane]);
        }
        break;
      case Opcode.Tan:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.tan(registers[input + lane]);
        }
        break;
      case Opcode.Asin:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.asin(registers[input + lane]);
        }
        break;
      case Opcode.Atan:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.atan(registers[input + lane]);
        }
        break;
    }
  }
}

function evaluateBinaryBlock(
  opcode: Opcode,
  registers: Float32Array,
  outputBase: number,
  arg0: number,
  arg1: number,
  width: number,
  arg1Width: number,
  blockSize: number,
  blockCount: number,
) {
  for (let component = 0; component < width; component += 1) {
    const output = outputBase + component * blockSize;
    const left = arg0 + component * blockSize;
    const right = arg1 + (arg1Width === 1 ? 0 : component * blockSize);
    switch (opcode) {
      case Opcode.Add:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] =
            registers[left + lane] + registers[right + lane];
        }
        break;
      case Opcode.Subtract:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] =
            registers[left + lane] - registers[right + lane];
        }
        break;
      case Opcode.Multiply:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] =
            registers[left + lane] * registers[right + lane];
        }
        break;
      case Opcode.Divide:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] =
            registers[left + lane] / registers[right + lane];
        }
        break;
      case Opcode.Pow:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] =
            registers[left + lane] ** registers[right + lane];
        }
        break;
      case Opcode.Min:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = rustMin(
            registers[left + lane],
            registers[right + lane],
          );
        }
        break;
      case Opcode.Max:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = rustMax(
            registers[left + lane],
            registers[right + lane],
          );
        }
        break;
      case Opcode.Atan2:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[output + lane] = Math.atan2(
            registers[left + lane],
            registers[right + lane],
          );
        }
        break;
    }
  }
}

export function executeRange(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  attributeData: DataView,
  splat0Float: Float32Array,
  registers: Float32Array,
  registerBases: Uint32Array,
  instructionStart: number,
  instructionEnd: number,
  blockStart: number,
  blockCount: number,
  blockSize: number,
  sourceIndices?: Uint16Array,
) {
  const { attributes, instructions } = program;
  for (
    let instructionIndex = instructionStart;
    instructionIndex < instructionEnd;
    instructionIndex += 1
  ) {
    const instructionOffset =
      instructionIndex * SPLAT_POST_DECODE_INSTRUCTION_STRIDE;
    const opcode =
      instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_OPCODE];
    if (opcode === Opcode.Constant) continue;
    const width =
      instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_WIDTH];
    const immediate =
      instructions[instructionOffset + SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE];
    const outputBase = registerBases[instructionIndex];
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
        : instructionWidth(instructions, arg0Register);
    const arg1Width =
      arg1Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
        ? 0
        : instructionWidth(instructions, arg1Register);
    const arg2Width =
      arg2Register === SPLAT_POST_DECODE_MISSING_ARGUMENT
        ? 0
        : instructionWidth(instructions, arg2Register);

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
      case Opcode.Tan:
      case Opcode.Asin:
      case Opcode.Atan:
        evaluateUnaryBlock(
          opcode,
          registers,
          outputBase,
          arg0,
          width,
          blockSize,
          blockCount,
        );
        break;
      case Opcode.Sqrt:
        for (let component = 0; component < width; component += 1) {
          const output = outputBase + component * blockSize;
          const input = arg0 + component * blockSize;
          for (let lane = 0; lane < blockCount; lane += 1) {
            registers[output + lane] = Math.sqrt(registers[input + lane]);
          }
        }
        break;
      case Opcode.Normalize:
        for (let lane = 0; lane < blockCount; lane += 1) {
          let lengthSquared = 0;
          for (let component = 0; component < width; component += 1) {
            const value = registers[arg0 + component * blockSize + lane];
            lengthSquared += value * value;
          }
          const length = Math.sqrt(lengthSquared);
          for (let component = 0; component < width; component += 1) {
            const input = registers[arg0 + component * blockSize + lane];
            registers[outputBase + component * blockSize + lane] =
              length === 0 || !Number.isFinite(length) ? input : input / length;
          }
        }
        break;
      case Opcode.Length:
        for (let lane = 0; lane < blockCount; lane += 1) {
          let lengthSquared = 0;
          for (let component = 0; component < arg0Width; component += 1) {
            const value = registers[arg0 + component * blockSize + lane];
            lengthSquared += value * value;
          }
          registers[outputBase + lane] = Math.sqrt(lengthSquared);
        }
        break;
      case Opcode.IsFinite:
        for (let lane = 0; lane < blockCount; lane += 1) {
          let finite = true;
          for (let component = 0; component < arg0Width; component += 1) {
            finite &&= Number.isFinite(
              registers[arg0 + component * blockSize + lane],
            );
          }
          registers[outputBase + lane] = finite ? 1 : 0;
        }
        break;
      case Opcode.Not:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] = registers[arg0 + lane] === 0 ? 1 : 0;
        }
        break;
      case Opcode.Add:
      case Opcode.Subtract:
      case Opcode.Multiply:
      case Opcode.Divide:
      case Opcode.Pow:
      case Opcode.Min:
      case Opcode.Max:
      case Opcode.Atan2:
        evaluateBinaryBlock(
          opcode,
          registers,
          outputBase,
          arg0,
          arg1,
          width,
          arg1Width,
          blockSize,
          blockCount,
        );
        break;
      case Opcode.MultiplyAdd:
      case Opcode.AddMultiply:
        for (let component = 0; component < width; component += 1) {
          const output = outputBase + component * blockSize;
          const left = arg0 + (arg0Width === 1 ? 0 : component * blockSize);
          const right = arg1 + (arg1Width === 1 ? 0 : component * blockSize);
          const last = arg2 + (arg2Width === 1 ? 0 : component * blockSize);
          if (opcode === Opcode.MultiplyAdd) {
            for (let lane = 0; lane < blockCount; lane += 1) {
              const intermediate = Math.fround(
                registers[left + lane] * registers[right + lane],
              );
              registers[output + lane] =
                immediate === 0
                  ? intermediate + registers[last + lane]
                  : registers[last + lane] + intermediate;
            }
          } else {
            for (let lane = 0; lane < blockCount; lane += 1) {
              const intermediate = Math.fround(
                registers[left + lane] + registers[right + lane],
              );
              registers[output + lane] =
                immediate === 0
                  ? intermediate * registers[last + lane]
                  : registers[last + lane] * intermediate;
            }
          }
        }
        break;
      case Opcode.Dot:
        for (let lane = 0; lane < blockCount; lane += 1) {
          let dot = 0;
          for (let component = 0; component < arg0Width; component += 1) {
            dot +=
              registers[arg0 + component * blockSize + lane] *
              registers[arg1 + component * blockSize + lane];
          }
          registers[outputBase + lane] = dot;
        }
        break;
      case Opcode.Cross:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] =
            registers[arg0 + blockSize + lane] *
              registers[arg1 + blockSize * 2 + lane] -
            registers[arg0 + blockSize * 2 + lane] *
              registers[arg1 + blockSize + lane];
          registers[outputBase + blockSize + lane] =
            registers[arg0 + blockSize * 2 + lane] * registers[arg1 + lane] -
            registers[arg0 + lane] * registers[arg1 + blockSize * 2 + lane];
          registers[outputBase + blockSize * 2 + lane] =
            registers[arg0 + lane] * registers[arg1 + blockSize + lane] -
            registers[arg0 + blockSize + lane] * registers[arg1 + lane];
        }
        break;
      case Opcode.Equal:
      case Opcode.NotEqual:
        for (let lane = 0; lane < blockCount; lane += 1) {
          let equal = true;
          for (let component = 0; component < arg0Width; component += 1) {
            equal &&=
              registers[arg0 + component * blockSize + lane] ===
              registers[arg1 + component * blockSize + lane];
          }
          registers[outputBase + lane] = (
            opcode === Opcode.Equal
              ? equal
              : !equal
          )
            ? 1
            : 0;
        }
        break;
      case Opcode.Less:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] =
            registers[arg0 + lane] < registers[arg1 + lane] ? 1 : 0;
        }
        break;
      case Opcode.LessEqual:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] =
            registers[arg0 + lane] <= registers[arg1 + lane] ? 1 : 0;
        }
        break;
      case Opcode.Greater:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] =
            registers[arg0 + lane] > registers[arg1 + lane] ? 1 : 0;
        }
        break;
      case Opcode.GreaterEqual:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] =
            registers[arg0 + lane] >= registers[arg1 + lane] ? 1 : 0;
        }
        break;
      case Opcode.And:
      case Opcode.Or:
        for (let lane = 0; lane < blockCount; lane += 1) {
          const result =
            opcode === Opcode.And
              ? registers[arg0 + lane] !== 0 && registers[arg1 + lane] !== 0
              : registers[arg0 + lane] !== 0 || registers[arg1 + lane] !== 0;
          registers[outputBase + lane] = result ? 1 : 0;
        }
        break;
      case Opcode.QuaternionMultiply:
        for (let lane = 0; lane < blockCount; lane += 1) {
          const leftX = registers[arg0 + lane];
          const leftY = registers[arg0 + blockSize + lane];
          const leftZ = registers[arg0 + blockSize * 2 + lane];
          const leftW = registers[arg0 + blockSize * 3 + lane];
          const rightX = registers[arg1 + lane];
          const rightY = registers[arg1 + blockSize + lane];
          const rightZ = registers[arg1 + blockSize * 2 + lane];
          const rightW = registers[arg1 + blockSize * 3 + lane];
          registers[outputBase + lane] =
            leftW * rightX + leftX * rightW + leftY * rightZ - leftZ * rightY;
          registers[outputBase + blockSize + lane] =
            leftW * rightY - leftX * rightZ + leftY * rightW + leftZ * rightX;
          registers[outputBase + blockSize * 2 + lane] =
            leftW * rightZ + leftX * rightY - leftY * rightX + leftZ * rightW;
          registers[outputBase + blockSize * 3 + lane] =
            leftW * rightW - leftX * rightX - leftY * rightY - leftZ * rightZ;
        }
        break;
      case Opcode.RotateVector:
        for (let lane = 0; lane < blockCount; lane += 1) {
          const quaternionX = registers[arg0 + lane];
          const quaternionY = registers[arg0 + blockSize + lane];
          const quaternionZ = registers[arg0 + blockSize * 2 + lane];
          const quaternionW = registers[arg0 + blockSize * 3 + lane];
          const vectorX = registers[arg1 + lane];
          const vectorY = registers[arg1 + blockSize + lane];
          const vectorZ = registers[arg1 + blockSize * 2 + lane];
          const crossX = 2 * (quaternionY * vectorZ - quaternionZ * vectorY);
          const crossY = 2 * (quaternionZ * vectorX - quaternionX * vectorZ);
          const crossZ = 2 * (quaternionX * vectorY - quaternionY * vectorX);
          registers[outputBase + lane] =
            vectorX +
            quaternionW * crossX +
            quaternionY * crossZ -
            quaternionZ * crossY;
          registers[outputBase + blockSize + lane] =
            vectorY +
            quaternionW * crossY +
            quaternionZ * crossX -
            quaternionX * crossZ;
          registers[outputBase + blockSize * 2 + lane] =
            vectorZ +
            quaternionW * crossZ +
            quaternionX * crossY -
            quaternionY * crossX;
        }
        break;
      case Opcode.Select:
        for (let component = 0; component < width; component += 1) {
          const output = outputBase + component * blockSize;
          const whenTrue = arg1 + component * blockSize;
          const whenFalse = arg2 + component * blockSize;
          for (let lane = 0; lane < blockCount; lane += 1) {
            registers[output + lane] =
              registers[arg0 + lane] !== 0
                ? registers[whenTrue + lane]
                : registers[whenFalse + lane];
          }
        }
        break;
      case Opcode.Clamp:
        for (let component = 0; component < width; component += 1) {
          const output = outputBase + component * blockSize;
          const value = arg0 + component * blockSize;
          const min = arg1 + (arg1Width === 1 ? 0 : component * blockSize);
          const max = arg2 + (arg2Width === 1 ? 0 : component * blockSize);
          for (let lane = 0; lane < blockCount; lane += 1) {
            registers[output + lane] = rustMin(
              rustMax(registers[value + lane], registers[min + lane]),
              registers[max + lane],
            );
          }
        }
        break;
      case Opcode.Mix:
        for (let component = 0; component < width; component += 1) {
          const output = outputBase + component * blockSize;
          const left = arg0 + component * blockSize;
          const right = arg1 + (arg1Width === 1 ? 0 : component * blockSize);
          const amount = arg2 + (arg2Width === 1 ? 0 : component * blockSize);
          for (let lane = 0; lane < blockCount; lane += 1) {
            const leftValue = registers[left + lane];
            registers[output + lane] =
              leftValue +
              (registers[right + lane] - leftValue) * registers[amount + lane];
          }
        }
        break;
      case Opcode.Vec2:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] = registers[arg0 + lane];
          registers[outputBase + blockSize + lane] = registers[arg1 + lane];
        }
        break;
      case Opcode.Vec3:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] = registers[arg0 + lane];
          registers[outputBase + blockSize + lane] = registers[arg1 + lane];
          registers[outputBase + blockSize * 2 + lane] = registers[arg2 + lane];
        }
        break;
      case Opcode.Vec4:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] = registers[arg0 + lane];
          registers[outputBase + blockSize + lane] = registers[arg1 + lane];
          registers[outputBase + blockSize * 2 + lane] = registers[arg2 + lane];
          registers[outputBase + blockSize * 3 + lane] = registers[arg3 + lane];
        }
        break;
      case Opcode.Component:
        for (let lane = 0; lane < blockCount; lane += 1) {
          registers[outputBase + lane] =
            registers[arg0 + immediate * blockSize + lane];
        }
        break;
      case Opcode.MaxComponentIndex:
        for (let lane = 0; lane < blockCount; lane += 1) {
          let largest = 0;
          let largestValue = registers[arg0 + lane];
          for (let component = 1; component < arg0Width; component += 1) {
            const value = registers[arg0 + component * blockSize + lane];
            if (value > largestValue) {
              largest = component;
              largestValue = value;
            }
          }
          registers[outputBase + lane] = largest;
        }
        break;
      default:
        throw new Error(`Unknown postDecode opcode: ${opcode}`);
    }
  }
}
