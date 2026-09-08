/** @internal */
export enum Opcode {
  Constant = 1,
  InputField = 2,
  InputAttribute = 3,
  Negate = 10,
  Abs = 11,
  Sqrt = 12,
  Log = 13,
  Exp = 14,
  Floor = 15,
  Ceil = 16,
  Round = 17,
  Normalize = 18,
  Length = 19,
  IsFinite = 20,
  Not = 22,
  Sin = 23,
  Cos = 24,
  Acos = 25,
  Tan = 26,
  Asin = 27,
  Atan = 28,
  Add = 30,
  Subtract = 31,
  Multiply = 32,
  Divide = 33,
  Min = 34,
  Max = 35,
  Pow = 36,
  Dot = 37,
  Cross = 38,
  Equal = 39,
  NotEqual = 40,
  Less = 41,
  LessEqual = 42,
  Greater = 43,
  GreaterEqual = 44,
  And = 45,
  Or = 46,
  QuaternionMultiply = 47,
  RotateVector = 48,
  Atan2 = 49,
  Select = 60,
  Clamp = 61,
  Mix = 62,
  Vec2 = 70,
  Vec3 = 71,
  Vec4 = 72,
  Component = 74,
  MaxComponentIndex = 75,
}

/** @internal */
export enum InputField {
  Position = 1,
  Scale = 2,
  Quaternion = 3,
  Opacity = 4,
  Alpha = 5,
  Color = 6,
  Sh0 = 7,
}

/** @internal */
export const SH_COEFFICIENT_COUNT = 15;

/** @internal */
export type SplatPostDecodeValueType =
  | "float"
  | "bool"
  | "vec2"
  | "vec3"
  | "vec4"
  | "quaternion";

/** @internal */
export const TYPE_WIDTHS: Record<SplatPostDecodeValueType, number> = {
  float: 1,
  bool: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  quaternion: 4,
};

/** @internal */
export type SplatPostDecodeInstruction = {
  opcode: Opcode;
  type: SplatPostDecodeValueType;
  args: readonly number[];
  immediate: number;
};

/** @internal */
export const SPLAT_POST_DECODE_INSTRUCTION_OPCODE = 0;

/** @internal */
export const SPLAT_POST_DECODE_INSTRUCTION_WIDTH = 1;

/** @internal */
export const SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE = 2;

/** @internal */
export const SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0 = 3;

/** @internal */
export const SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_COUNT = 4;

/** @internal */
export const SPLAT_POST_DECODE_INSTRUCTION_STRIDE = 7;

/** @internal */
export const SPLAT_POST_DECODE_MISSING_ARGUMENT = 0xffff;

/** @internal */
export type SplatPostDecodeAttributeFormat =
  | "f32"
  | "f16"
  | "u8"
  | "unorm8"
  | "i8"
  | "snorm8"
  | "u16"
  | "unorm16"
  | "i16"
  | "snorm16"
  | "u32"
  | "i32";

/** @internal */
export const ATTRIBUTE_FORMAT_BYTES: Record<
  SplatPostDecodeAttributeFormat,
  number
> = {
  f32: 4,
  f16: 2,
  u8: 1,
  unorm8: 1,
  i8: 1,
  snorm8: 1,
  u16: 2,
  unorm16: 2,
  i16: 2,
  snorm16: 2,
  u32: 4,
  i32: 4,
};

export type AttributeComponents = 1 | 2 | 3 | 4;

export type AttributeBinding = {
  data: ArrayBufferView;
  format: SplatPostDecodeAttributeFormat;
  count: number;
  components: AttributeComponents;
  byteOffset: number;
  byteStride: number;
};

/** @internal */
export type SerializedSplatPostDecodeAttribute = {
  format: SplatPostDecodeAttributeFormat;
  components: AttributeComponents;
  byteOffset: number;
  byteStride: number;
  count: number;
};

/** @internal */
export type SplatPostDecodeOutputs = {
  when?: number;
  position?: number;
  scale?: number;
  quaternion?: number;
  opacity?: number;
  alpha?: number;
  color?: number;
  sh?: readonly number[];
};

/** @internal */
export const SPLAT_POST_DECODE_FLOW_STAGE_START = 0;

/** @internal */
export const SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION = 1;

/** @internal */
export const SPLAT_POST_DECODE_FLOW_STAGE_REGISTER = 2;

/** @internal */
export const SPLAT_POST_DECODE_FLOW_STAGE_ON_TRUE = 3;

/** @internal */
export const SPLAT_POST_DECODE_FLOW_STAGE_ON_FALSE = 4;

/** @internal */
export const SPLAT_POST_DECODE_FLOW_STAGE_STRIDE = 5;

/** @internal */
export type SerializedSplatPostDecodeCondition = {
  mode: "flow";
  /** Packed start/instruction/register/onTrue/onFalse Uint16 records. */
  stages: Uint16Array;
};

/** @internal */
export type SerializedSplatPostDecode = {
  /** Packed opcode/width/immediate/arg0/arg1/arg2/arg3 Uint16 records. */
  instructions: Uint16Array;
  constants: Float32Array;
  outputs: Omit<SplatPostDecodeOutputs, "when">;
  condition?: SerializedSplatPostDecodeCondition;
  attributeData: Uint8Array;
  attributes: readonly SerializedSplatPostDecodeAttribute[];
};

export type PostDecodeSource = {
  instructions: readonly SplatPostDecodeInstruction[];
  constants: readonly number[];
  attributes: readonly AttributeBinding[];
};

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
