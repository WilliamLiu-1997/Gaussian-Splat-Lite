/** @internal */
export const Opcode = {
  Constant: 1,
  InputField: 2,
  InputAttribute: 3,
  Negate: 10,
  Abs: 11,
  Sqrt: 12,
  Log: 13,
  Exp: 14,
  Floor: 15,
  Ceil: 16,
  Round: 17,
  Normalize: 18,
  Length: 19,
  IsFinite: 20,
  Not: 22,
  Sin: 23,
  Cos: 24,
  Acos: 25,
  Tan: 26,
  Asin: 27,
  Atan: 28,
  Add: 30,
  Subtract: 31,
  Multiply: 32,
  Divide: 33,
  Min: 34,
  Max: 35,
  Pow: 36,
  Dot: 37,
  Cross: 38,
  Equal: 39,
  NotEqual: 40,
  Less: 41,
  LessEqual: 42,
  Greater: 43,
  GreaterEqual: 44,
  And: 45,
  Or: 46,
  QuaternionMultiply: 47,
  RotateVector: 48,
  Atan2: 49,
  Select: 60,
  Clamp: 61,
  Mix: 62,
  // Preserve float32 rounding between the two operations (not hardware FMA).
  MultiplyAdd: 63,
  AddMultiply: 64,
  Vec2: 70,
  Vec3: 71,
  Vec4: 72,
  Component: 74,
  MaxComponentIndex: 75,
};
/** @internal */
export const InputField = {
  Position: 1,
  Scale: 2,
  Quaternion: 3,
  Opacity: 4,
  Alpha: 5,
  Color: 6,
  Sh0: 7,
};
/** @internal */
export const SH_COEFFICIENT_COUNT = 15;
/** @internal */
export const TYPE_WIDTHS = {
  float: 1,
  bool: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  quaternion: 4,
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
export const ATTRIBUTE_FORMAT_BYTES = {
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
