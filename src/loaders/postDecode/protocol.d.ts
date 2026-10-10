/** @internal */
export declare const Opcode: {
  readonly Constant: 1;
  readonly InputField: 2;
  readonly InputAttribute: 3;
  readonly Negate: 10;
  readonly Abs: 11;
  readonly Sqrt: 12;
  readonly Log: 13;
  readonly Exp: 14;
  readonly Floor: 15;
  readonly Ceil: 16;
  readonly Round: 17;
  readonly Normalize: 18;
  readonly Length: 19;
  readonly IsFinite: 20;
  readonly Not: 22;
  readonly Sin: 23;
  readonly Cos: 24;
  readonly Acos: 25;
  readonly Tan: 26;
  readonly Asin: 27;
  readonly Atan: 28;
  readonly Add: 30;
  readonly Subtract: 31;
  readonly Multiply: 32;
  readonly Divide: 33;
  readonly Min: 34;
  readonly Max: 35;
  readonly Pow: 36;
  readonly Dot: 37;
  readonly Cross: 38;
  readonly Equal: 39;
  readonly NotEqual: 40;
  readonly Less: 41;
  readonly LessEqual: 42;
  readonly Greater: 43;
  readonly GreaterEqual: 44;
  readonly And: 45;
  readonly Or: 46;
  readonly QuaternionMultiply: 47;
  readonly RotateVector: 48;
  readonly Atan2: 49;
  readonly Select: 60;
  readonly Clamp: 61;
  readonly Mix: 62;
  readonly MultiplyAdd: 63;
  readonly AddMultiply: 64;
  readonly Vec2: 70;
  readonly Vec3: 71;
  readonly Vec4: 72;
  readonly Component: 74;
  readonly MaxComponentIndex: 75;
};
/** @internal */
export type Opcode = (typeof Opcode)[keyof typeof Opcode];
/** @internal */
export declare const InputField: {
  readonly Position: 1;
  readonly Scale: 2;
  readonly Quaternion: 3;
  readonly Opacity: 4;
  readonly Alpha: 5;
  readonly Color: 6;
  readonly Sh0: 7;
};
/** @internal */
export type InputField = (typeof InputField)[keyof typeof InputField];
/** @internal */
export declare const SH_COEFFICIENT_COUNT = 15;
/** @internal */
export type SplatPostDecodeValueType =
  | "float"
  | "bool"
  | "vec2"
  | "vec3"
  | "vec4"
  | "quaternion";
/** @internal */
export declare const TYPE_WIDTHS: Record<SplatPostDecodeValueType, number>;
/** @internal */
export type SplatPostDecodeInstruction = {
  opcode: Opcode;
  type: SplatPostDecodeValueType;
  args: readonly number[];
  immediate: number;
};
/** @internal */
export declare const SPLAT_POST_DECODE_INSTRUCTION_OPCODE = 0;
/** @internal */
export declare const SPLAT_POST_DECODE_INSTRUCTION_WIDTH = 1;
/** @internal */
export declare const SPLAT_POST_DECODE_INSTRUCTION_IMMEDIATE = 2;
/** @internal */
export declare const SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0 = 3;
/** @internal */
export declare const SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_COUNT = 4;
/** @internal */
export declare const SPLAT_POST_DECODE_INSTRUCTION_STRIDE = 7;
/** @internal */
export declare const SPLAT_POST_DECODE_MISSING_ARGUMENT = 65535;
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
export declare const ATTRIBUTE_FORMAT_BYTES: Record<
  SplatPostDecodeAttributeFormat,
  number
>;
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
export declare const SPLAT_POST_DECODE_FLOW_STAGE_START = 0;
/** @internal */
export declare const SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION = 1;
/** @internal */
export declare const SPLAT_POST_DECODE_FLOW_STAGE_REGISTER = 2;
/** @internal */
export declare const SPLAT_POST_DECODE_FLOW_STAGE_ON_TRUE = 3;
/** @internal */
export declare const SPLAT_POST_DECODE_FLOW_STAGE_ON_FALSE = 4;
/** @internal */
export declare const SPLAT_POST_DECODE_FLOW_STAGE_STRIDE = 5;
/** @internal */
export type SerializedSplatPostDecodeCondition = {
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
  sourceIds?: Uint32Array;
  sh1?: Uint32Array;
  sh2?: Uint32Array;
  sh3a?: Uint32Array;
  sh3b?: Uint32Array;
};
