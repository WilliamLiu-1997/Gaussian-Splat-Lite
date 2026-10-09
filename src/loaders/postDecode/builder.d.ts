import type {
  AttributeBinding,
  AttributeComponents,
  InputField,
  SplatPostDecodeAttributeFormat,
  SplatPostDecodeInstruction,
  SplatPostDecodeOutputs,
  SplatPostDecodeValueType,
} from "./protocol.js";
type NumericValueType = "float" | "vec2" | "vec3" | "vec4";
type VectorValueType = "vec2" | "vec3" | "vec4";
declare class SplatPostDecodeValue<T extends SplatPostDecodeValueType> {
  readonly type: T;
  /** @internal */ readonly register: number;
  /** @internal */ readonly owner: ProgramBuilder;
  /** @internal */
  constructor(
    type: T,
    /** @internal */ register: number,
    /** @internal */ owner: ProgramBuilder,
  );
}
type FloatValue = SplatPostDecodeValue<"float">;
type BoolValue = SplatPostDecodeValue<"bool">;
type Vec2Value = SplatPostDecodeValue<"vec2">;
type Vec3Value = SplatPostDecodeValue<"vec3">;
type Vec4Value = SplatPostDecodeValue<"vec4">;
type QuaternionValue = SplatPostDecodeValue<"quaternion">;
type FloatLike = number | FloatValue;
type BoolLike = boolean | BoolValue;
type Vec2Literal = readonly [number, number];
type Vec3Literal = readonly [number, number, number];
type Vec4Literal = readonly [number, number, number, number];
type Vec2Like = Vec2Literal | Vec2Value;
type Vec3Like = Vec3Literal | Vec3Value;
type Vec4Like = Vec4Literal | Vec4Value;
type QuaternionLike = Vec4Literal | QuaternionValue;
type LiteralFor<T extends SplatPostDecodeValueType> = T extends "float"
  ? number
  : T extends "bool"
    ? boolean
    : T extends "vec2"
      ? Vec2Literal
      : T extends "vec3"
        ? Vec3Literal
        : Vec4Literal;
type ValueLike<T extends SplatPostDecodeValueType> =
  | LiteralFor<T>
  | SplatPostDecodeValue<T>;
type BroadcastLike<T extends NumericValueType> = ValueLike<T> | FloatLike;
type SplatPostDecodeAttributeOptions<
  Components extends AttributeComponents = 1,
> = {
  data: ArrayBufferView;
  format: SplatPostDecodeAttributeFormat;
  count: number;
  components?: Components;
  /** Byte offset relative to the supplied data view. */
  byteOffset?: number;
  byteStride?: number;
};
type AttributeValue<Components extends AttributeComponents> =
  Components extends 1
    ? FloatValue
    : Components extends 2
      ? Vec2Value
      : Components extends 3
        ? Vec3Value
        : Vec4Value;
type SplatShCoefficientContext = {
  index: number;
  degree: 1 | 2 | 3;
  order: number;
};
declare class SplatPostDecodeShPatch {
  /** @internal */ readonly owner: ProgramBuilder;
  /** @internal */ readonly coefficients: readonly Vec3Value[];
  /** @internal */
  constructor(
    /** @internal */ owner: ProgramBuilder,
    /** @internal */ coefficients: readonly Vec3Value[],
  );
}
declare class SplatPostDecodeShValue {
  private readonly owner;
  /** @internal */
  constructor(owner: ProgramBuilder);
  coefficient(index: number): Vec3Value;
  map(
    transform: (
      coefficient: Vec3Value,
      context: SplatShCoefficientContext,
    ) => Vec3Like,
  ): SplatPostDecodeShPatch;
}
type SplatPostDecodeInput = {
  readonly position: Vec3Value;
  readonly scale: Vec3Value;
  readonly quaternion: QuaternionValue;
  /** Semantic opacity in [0, exp(24/e)] (approximately 6830.182). */
  readonly opacity: FloatValue;
  /** Standard alpha in the [0, 1] range. */
  readonly alpha: FloatValue;
  readonly color: Vec3Value;
  readonly sh: SplatPostDecodeShValue;
};
export type SplatPostDecodePatch = {
  /** If false, this splat's packed values are left byte-for-byte unchanged. */
  when?: BoolLike;
  position?: Vec3Like;
  scale?: Vec3Like;
  quaternion?: QuaternionLike;
  /** Semantic opacity, encoded within the renderer's shape range [0, 1]. */
  opacity?: FloatLike;
  /**
   * Standard alpha, clamped to [0, 1] and independent from semantic opacity.
   * Cannot be output with opacity in the same patch.
   */
  alpha?: FloatLike;
  color?: Vec3Like;
  sh?: SplatPostDecodeShPatch;
};
type VariadicNumericOperation = <T extends NumericValueType>(
  first: ValueLike<T>,
  ...rest: BroadcastLike<T>[]
) => SplatPostDecodeValue<T>;
type BinaryNumericOperation = <T extends NumericValueType>(
  left: ValueLike<T>,
  right: BroadcastLike<T>,
) => SplatPostDecodeValue<T>;
type UnaryNumericOperation = <T extends NumericValueType>(
  value: ValueLike<T>,
) => SplatPostDecodeValue<T>;
type SplatPostDecodeOperations = {
  add: VariadicNumericOperation;
  sub: BinaryNumericOperation;
  mul: VariadicNumericOperation;
  div: BinaryNumericOperation;
  min: BinaryNumericOperation;
  max: BinaryNumericOperation;
  pow: BinaryNumericOperation;
  clamp<T extends NumericValueType>(
    value: ValueLike<T>,
    min: BroadcastLike<T>,
    max: BroadcastLike<T>,
  ): SplatPostDecodeValue<T>;
  mix<T extends NumericValueType>(
    left: ValueLike<T>,
    right: ValueLike<T>,
    amount: BroadcastLike<T>,
  ): SplatPostDecodeValue<T>;
  neg: UnaryNumericOperation;
  abs: UnaryNumericOperation;
  sqrt: UnaryNumericOperation;
  log: UnaryNumericOperation;
  exp: UnaryNumericOperation;
  floor: UnaryNumericOperation;
  ceil: UnaryNumericOperation;
  round: UnaryNumericOperation;
  sin: UnaryNumericOperation;
  cos: UnaryNumericOperation;
  acos: UnaryNumericOperation;
  tan: UnaryNumericOperation;
  asin: UnaryNumericOperation;
  atan: UnaryNumericOperation;
  atan2: BinaryNumericOperation;
  normalize<T extends VectorValueType | "quaternion">(
    value: ValueLike<T>,
  ): SplatPostDecodeValue<T>;
  length(value: Vec2Like | Vec3Like | Vec4Like): FloatValue;
  isFinite(
    value: FloatLike | Vec2Like | Vec3Like | Vec4Like | QuaternionLike,
  ): BoolValue;
  not(value: BoolLike): BoolValue;
  eq<T extends SplatPostDecodeValueType>(
    left: ValueLike<T>,
    right: ValueLike<T>,
  ): BoolValue;
  ne<T extends SplatPostDecodeValueType>(
    left: ValueLike<T>,
    right: ValueLike<T>,
  ): BoolValue;
  lt(left: FloatLike, right: FloatLike): BoolValue;
  lte(left: FloatLike, right: FloatLike): BoolValue;
  gt(left: FloatLike, right: FloatLike): BoolValue;
  gte(left: FloatLike, right: FloatLike): BoolValue;
  and(first: BoolLike, ...rest: BoolLike[]): BoolValue;
  or(first: BoolLike, ...rest: BoolLike[]): BoolValue;
  select<T extends SplatPostDecodeValueType>(
    condition: BoolLike,
    whenTrue: ValueLike<T>,
    whenFalse: ValueLike<T>,
  ): SplatPostDecodeValue<T>;
  dot(
    left: Vec2Like | Vec3Like | Vec4Like,
    right: Vec2Like | Vec3Like | Vec4Like,
  ): FloatValue;
  cross(left: Vec3Like, right: Vec3Like): Vec3Value;
  vec2(x: FloatLike, y: FloatLike): Vec2Value;
  vec3(x: FloatLike, y: FloatLike, z: FloatLike): Vec3Value;
  vec4(x: FloatLike, y: FloatLike, z: FloatLike, w: FloatLike): Vec4Value;
  quaternion(
    x: FloatLike,
    y: FloatLike,
    z: FloatLike,
    w: FloatLike,
  ): QuaternionValue;
  component(
    value: Vec2Like | Vec3Like | Vec4Like | QuaternionLike,
    index: number,
  ): FloatValue;
  maxComponentIndex(value: Vec2Like | Vec3Like | Vec4Like): FloatValue;
  quatMul(left: QuaternionLike, right: QuaternionLike): QuaternionValue;
  rotateVector(quaternion: QuaternionLike, vector: Vec3Like): Vec3Value;
};
export type SplatPostDecodeContext = {
  splat: SplatPostDecodeInput;
  op: SplatPostDecodeOperations;
  attribute<Components extends AttributeComponents = 1>(
    options: SplatPostDecodeAttributeOptions<Components>,
  ): AttributeValue<Components>;
};
export declare class ProgramBuilder {
  readonly instructions: SplatPostDecodeInstruction[];
  readonly constants: number[];
  readonly attributes: AttributeBinding[];
  readonly op: SplatPostDecodeOperations;
  readonly splat: SplatPostDecodeInput;
  readonly constantRegisters: Map<
    string,
    SplatPostDecodeValue<SplatPostDecodeValueType>
  >;
  readonly inputRegisters: Map<
    number,
    SplatPostDecodeValue<SplatPostDecodeValueType>
  >;
  constructor();
  private instruction;
  inputField<T extends SplatPostDecodeValueType>(
    type: T,
    field: InputField,
  ): SplatPostDecodeValue<T>;
  attribute<Components extends AttributeComponents = 1>(
    options: SplatPostDecodeAttributeOptions<Components>,
  ): AttributeValue<Components>;
  coerce<T extends SplatPostDecodeValueType>(
    value: ValueLike<T>,
    expectedType?: T,
  ): SplatPostDecodeValue<T>;
  private unary;
  private binary;
  private ternary;
  private coerceForBinary;
  private createOperations;
}
export declare function buildOutputs(
  builder: ProgramBuilder,
  patch: SplatPostDecodePatch,
): SplatPostDecodeOutputs;
