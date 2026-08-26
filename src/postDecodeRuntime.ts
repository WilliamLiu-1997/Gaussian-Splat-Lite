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

function getBlockSize(instructionCount: number, processCount: number) {
  const bytesPerSplat = instructionCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  return Math.min(
    processCount,
    MAX_BLOCK_SIZE,
    Math.max(1, Math.floor(MAX_REGISTER_BYTES / bytesPerSplat)),
  );
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
) {
  const componentBytes = ATTRIBUTE_FORMAT_BYTES[attribute.format];
  const read = ATTRIBUTE_READERS[attribute.format];
  for (let component = 0; component < attribute.components; component += 1) {
    let inputOffset =
      attribute.byteOffset +
      blockStart * attribute.byteStride +
      component * componentBytes;
    const componentOutput = outputBase + component * blockSize;
    for (let index = 0; index < blockCount; index += 1) {
      registers[componentOutput + index] = read(data, inputOffset);
      inputOffset += attribute.byteStride;
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
) {
  switch (field) {
    case InputField.Position:
      for (let index = 0; index < blockCount; index += 1) {
        const wordBase = (blockStart + index) * 4;
        registers[outputBase + index] = splat0Float[wordBase];
        registers[outputBase + blockSize + index] = splat0Float[wordBase + 1];
        registers[outputBase + blockSize * 2 + index] =
          splat0Float[wordBase + 2];
      }
      break;
    case InputField.Scale:
      for (let index = 0; index < blockCount; index += 1) {
        const wordBase = (blockStart + index) * 4;
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
        const wordBase = (blockStart + index) * 4;
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
        registers[outputBase + index] = decodeSplatOpacity(
          data.splat0[(blockStart + index) * 4 + 3],
        );
      }
      break;
    case InputField.Alpha:
      for (let index = 0; index < blockCount; index += 1) {
        registers[outputBase + index] = fromHalf(
          data.splat0[(blockStart + index) * 4 + 3] & 0xffff,
        );
      }
      break;
    case InputField.Color:
      for (let index = 0; index < blockCount; index += 1) {
        const wordBase = (blockStart + index) * 4;
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
          decodeSh(
            location[0][(blockStart + index) * 4 + location[1]],
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

function evaluateProgram(
  data: PostDecodeSplatData,
  program: SerializedSplatPostDecode,
  attributeData: DataView,
  splat0Float: Float32Array,
  registers: Float32Array,
  processCount: number,
  blockSize: number,
) {
  const { attributes, constants, instructions } = program;
  const registerStride = blockSize * 4;
  // SoA layout: each vector lane owns blockSize contiguous register values.
  for (
    let instructionIndex = 0;
    instructionIndex < instructions.length;
    instructionIndex += 1
  ) {
    const instruction = instructions[instructionIndex];
    if (instruction.opcode !== Opcode.Constant) continue;
    const outputBase = instructionIndex * registerStride;
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
    const blockCount = Math.min(blockSize, processCount - blockStart);
    for (
      let instructionIndex = 0;
      instructionIndex < instructions.length;
      instructionIndex += 1
    ) {
      const instruction = instructions[instructionIndex];
      const { args, immediate, opcode, type } = instruction;
      if (opcode === Opcode.Constant) continue;
      const outputBase = instructionIndex * registerStride;
      const width = TYPE_WIDTHS[type];
      const arg0 = (args[0] ?? 0) * registerStride;
      const arg1 = (args[1] ?? 0) * registerStride;
      const arg2 = (args[2] ?? 0) * registerStride;
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
                registers[(args[3] ?? 0) * registerStride + index];
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
    for (let index = 0; index < blockCount; index += 1) {
      writeOutputs(
        data,
        splat0Float,
        program,
        registers,
        blockSize,
        index,
        blockStart + index,
      );
    }
  }
}

function writeOutputs(
  data: PostDecodeSplatData,
  splat0Float: Float32Array,
  program: SerializedSplatPostDecode,
  registers: Float32Array,
  blockSize: number,
  blockIndex: number,
  splatIndex: number,
) {
  const { outputs } = program;
  const registerStride = blockSize * 4;
  if (
    outputs.when !== undefined &&
    registers[outputs.when * registerStride + blockIndex] === 0
  ) {
    return;
  }

  const wordBase = splatIndex * 4;
  if (outputs.position !== undefined) {
    const base = outputs.position * registerStride + blockIndex;
    splat0Float[wordBase] = registers[base];
    splat0Float[wordBase + 1] = registers[base + blockSize];
    splat0Float[wordBase + 2] = registers[base + blockSize * 2];
  }
  if (outputs.scale !== undefined) {
    const base = outputs.scale * registerStride + blockIndex;
    const first = data.splat1[wordBase + 1] & 0xffff;
    data.splat1[wordBase + 1] =
      (first | (toHalf(Math.log(registers[base])) << 16)) >>> 0;
    data.splat1[wordBase + 2] =
      (toHalf(Math.log(registers[base + blockSize])) |
        (toHalf(Math.log(registers[base + blockSize * 2])) << 16)) >>>
      0;
  }
  if (outputs.quaternion !== undefined) {
    const base = outputs.quaternion * registerStride + blockIndex;
    const encoded = encodeQuaternion(registers, base, blockSize);
    if (encoded !== undefined) data.splat1[wordBase + 3] = encoded;
  }
  if (outputs.opacity !== undefined) {
    const base = outputs.opacity * registerStride + blockIndex;
    data.splat0[wordBase + 3] = encodeSplatOpacity(registers[base]);
  }
  if (outputs.alpha !== undefined) {
    const base = outputs.alpha * registerStride + blockIndex;
    data.splat0[wordBase + 3] =
      ((data.splat0[wordBase + 3] & 0xffff_0000) |
        toHalf(clamp(registers[base], 0, 1))) >>>
      0;
  }
  if (outputs.color !== undefined) {
    const base = outputs.color * registerStride + blockIndex;
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
        const base = outputs.sh[coefficient] * registerStride + blockIndex;
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

  const blockSize = getBlockSize(program.instructions.length, processCount);
  const registers = new Float32Array(
    program.instructions.length * 4 * blockSize,
  );
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
    processCount,
    blockSize,
  );
}
