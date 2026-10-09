/** @internal */
export const Opcode = {
  Constant: 1,
  1: "Constant",
  InputField: 2,
  2: "InputField",
  InputAttribute: 3,
  3: "InputAttribute",
  Negate: 10,
  10: "Negate",
  Abs: 11,
  11: "Abs",
  Sqrt: 12,
  12: "Sqrt",
  Log: 13,
  13: "Log",
  Exp: 14,
  14: "Exp",
  Floor: 15,
  15: "Floor",
  Ceil: 16,
  16: "Ceil",
  Round: 17,
  17: "Round",
  Normalize: 18,
  18: "Normalize",
  Length: 19,
  19: "Length",
  IsFinite: 20,
  20: "IsFinite",
  Not: 22,
  22: "Not",
  Sin: 23,
  23: "Sin",
  Cos: 24,
  24: "Cos",
  Acos: 25,
  25: "Acos",
  Tan: 26,
  26: "Tan",
  Asin: 27,
  27: "Asin",
  Atan: 28,
  28: "Atan",
  Add: 30,
  30: "Add",
  Subtract: 31,
  31: "Subtract",
  Multiply: 32,
  32: "Multiply",
  Divide: 33,
  33: "Divide",
  Min: 34,
  34: "Min",
  Max: 35,
  35: "Max",
  Pow: 36,
  36: "Pow",
  Dot: 37,
  37: "Dot",
  Cross: 38,
  38: "Cross",
  Equal: 39,
  39: "Equal",
  NotEqual: 40,
  40: "NotEqual",
  Less: 41,
  41: "Less",
  LessEqual: 42,
  42: "LessEqual",
  Greater: 43,
  43: "Greater",
  GreaterEqual: 44,
  44: "GreaterEqual",
  And: 45,
  45: "And",
  Or: 46,
  46: "Or",
  QuaternionMultiply: 47,
  47: "QuaternionMultiply",
  RotateVector: 48,
  48: "RotateVector",
  Atan2: 49,
  49: "Atan2",
  Select: 60,
  60: "Select",
  Clamp: 61,
  61: "Clamp",
  Mix: 62,
  62: "Mix",
  // Preserve float32 rounding between the two operations (not hardware FMA).
  MultiplyAdd: 63,
  63: "MultiplyAdd",
  AddMultiply: 64,
  64: "AddMultiply",
  Vec2: 70,
  70: "Vec2",
  Vec3: 71,
  71: "Vec3",
  Vec4: 72,
  72: "Vec4",
  Component: 74,
  74: "Component",
  MaxComponentIndex: 75,
  75: "MaxComponentIndex",
};
/** @internal */
export const InputField = {
  Position: 1,
  1: "Position",
  Scale: 2,
  2: "Scale",
  Quaternion: 3,
  3: "Quaternion",
  Opacity: 4,
  4: "Opacity",
  Alpha: 5,
  5: "Alpha",
  Color: 6,
  6: "Color",
  Sh0: 7,
  7: "Sh0",
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
