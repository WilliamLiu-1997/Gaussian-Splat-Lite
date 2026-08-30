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

type NumericValueType = "float" | "vec2" | "vec3" | "vec4";
type VectorValueType = "vec2" | "vec3" | "vec4";

/** @internal */
export const TYPE_WIDTHS: Record<SplatPostDecodeValueType, number> = {
  float: 1,
  bool: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  quaternion: 4,
};

class SplatPostDecodeValue<T extends SplatPostDecodeValueType> {
  /** @internal */
  constructor(
    readonly type: T,
    /** @internal */ readonly register: number,
    /** @internal */ readonly owner: ProgramBuilder,
  ) {}
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
type AnyValueLike = ValueLike<SplatPostDecodeValueType>;
type BroadcastLike<T extends NumericValueType> = ValueLike<T> | FloatLike;

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

type AttributeComponents = 1 | 2 | 3 | 4;
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
type AttributeBinding = {
  data: ArrayBufferView;
  format: SplatPostDecodeAttributeFormat;
  count: number;
  components: AttributeComponents;
  byteOffset: number;
  byteStride: number;
};

type SplatShCoefficientContext = {
  index: number;
  degree: 1 | 2 | 3;
  order: number;
};

class SplatPostDecodeShPatch {
  /** @internal */
  constructor(
    /** @internal */ readonly owner: ProgramBuilder,
    /** @internal */ readonly coefficients: readonly Vec3Value[],
  ) {}
}

class SplatPostDecodeShValue {
  /** @internal */
  constructor(private readonly owner: ProgramBuilder) {}

  coefficient(index: number): Vec3Value {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= SH_COEFFICIENT_COUNT
    ) {
      throw new Error("SH coefficient index must be between 0 and 14");
    }
    return this.owner.inputField("vec3", InputField.Sh0 + index);
  }

  map(
    transform: (
      coefficient: Vec3Value,
      context: SplatShCoefficientContext,
    ) => Vec3Like,
  ): SplatPostDecodeShPatch {
    const coefficients: Vec3Value[] = [];
    let index = 0;
    for (let degree = 1 as 1 | 2 | 3; degree <= 3; degree += 1) {
      for (let order = -degree; order <= degree; order += 1) {
        coefficients.push(
          this.owner.coerce(
            transform(this.coefficient(index), { index, degree, order }),
            "vec3",
          ),
        );
        index += 1;
      }
    }
    return new SplatPostDecodeShPatch(this.owner, coefficients);
  }
}

type SplatPostDecodeInput = {
  readonly position: Vec3Value;
  readonly scale: Vec3Value;
  readonly quaternion: QuaternionValue;
  /** Semantic opacity in the [0, 1000] range. */
  readonly opacity: FloatValue;
  /** Standard alpha in the [0, 1] range. */
  readonly alpha: FloatValue;
  readonly color: Vec3Value;
  readonly sh: SplatPostDecodeShValue;
};
type SplatPostDecodePatch = {
  /** If false, this splat's packed values are left byte-for-byte unchanged. */
  when?: BoolLike;
  position?: Vec3Like;
  scale?: Vec3Like;
  quaternion?: QuaternionLike;
  /** Semantic opacity, clamped to [0, 1000] and encoded by the library. */
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

type SplatPostDecodeContext = {
  splat: SplatPostDecodeInput;
  op: SplatPostDecodeOperations;
  attribute<Components extends AttributeComponents = 1>(
    options: SplatPostDecodeAttributeOptions<Components>,
  ): AttributeValue<Components>;
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

const SPLAT_POST_DECODE_PROGRAM = Symbol("SplatPostDecodeProgram");
export type SplatPostDecodeProgram = {
  readonly [SPLAT_POST_DECODE_PROGRAM]: true;
};

const COMPONENT_TYPES = ["float", "vec2", "vec3", "vec4"] as const;

function inferLiteralType(value: unknown): SplatPostDecodeValueType {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "float";
  if (Array.isArray(value) && value.length >= 2 && value.length <= 4) {
    return COMPONENT_TYPES[value.length - 1];
  }
  throw new Error("Unsupported postDecode literal");
}

function constantKey(
  type: SplatPostDecodeValueType,
  values: readonly number[],
) {
  return `${type}:${values
    .map((value) => (Object.is(value, -0) ? "-0" : value))
    .join(":")}`;
}

class ProgramBuilder {
  readonly instructions: SplatPostDecodeInstruction[] = [];
  readonly constants: number[] = [];
  readonly attributes: AttributeBinding[] = [];
  readonly op: SplatPostDecodeOperations;
  readonly splat: SplatPostDecodeInput;

  readonly constantRegisters = new Map<
    string,
    SplatPostDecodeValue<SplatPostDecodeValueType>
  >();
  readonly inputRegisters = new Map<
    number,
    SplatPostDecodeValue<SplatPostDecodeValueType>
  >();

  constructor() {
    this.op = this.createOperations();
    const builder = this;
    const sh = new SplatPostDecodeShValue(this);
    this.splat = {
      get position() {
        return builder.inputField("vec3", InputField.Position);
      },
      get scale() {
        return builder.inputField("vec3", InputField.Scale);
      },
      get quaternion() {
        return builder.inputField("quaternion", InputField.Quaternion);
      },
      get opacity() {
        return builder.inputField("float", InputField.Opacity);
      },
      get alpha() {
        return builder.inputField("float", InputField.Alpha);
      },
      get color() {
        return builder.inputField("vec3", InputField.Color);
      },
      sh,
    };
  }

  private instruction<T extends SplatPostDecodeValueType>(
    type: T,
    opcode: Opcode,
    args: readonly number[] = [],
    immediate = 0,
  ): SplatPostDecodeValue<T> {
    if (this.instructions.length >= 4096) {
      throw new Error("postDecode program exceeds 4096 instructions");
    }
    const register = this.instructions.length;
    this.instructions.push({ opcode, type, args, immediate });
    return new SplatPostDecodeValue(type, register, this);
  }

  inputField<T extends SplatPostDecodeValueType>(
    type: T,
    field: InputField,
  ): SplatPostDecodeValue<T> {
    const existing = this.inputRegisters.get(field);
    if (existing) return existing as SplatPostDecodeValue<T>;
    const value = this.instruction(type, Opcode.InputField, [], field);
    this.inputRegisters.set(field, value);
    return value;
  }

  attribute<Components extends AttributeComponents = 1>(
    options: SplatPostDecodeAttributeOptions<Components>,
  ): AttributeValue<Components> {
    if (!ArrayBuffer.isView(options.data)) {
      throw new Error("postDecode attribute data must be an ArrayBuffer view");
    }
    const componentBytes = ATTRIBUTE_FORMAT_BYTES[options.format];
    if (!componentBytes) {
      throw new Error(`Unknown postDecode format: ${options.format}`);
    }
    const count = options.count;
    const components = options.components ?? 1;
    const byteOffset = options.byteOffset ?? 0;
    const packedBytes = componentBytes * components;
    const byteStride = options.byteStride ?? packedBytes;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("postDecode attribute count must be non-negative");
    }
    if (!Number.isInteger(components) || components < 1 || components > 4) {
      throw new Error(
        "postDecode attribute components must be between 1 and 4",
      );
    }
    if (
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      !Number.isSafeInteger(byteStride) ||
      byteStride < packedBytes
    ) {
      throw new Error("Invalid postDecode attribute byteOffset or byteStride");
    }
    const requiredBytes =
      count === 0
        ? byteOffset
        : byteOffset + (count - 1) * byteStride + packedBytes;
    if (
      !Number.isSafeInteger(requiredBytes) ||
      requiredBytes > options.data.byteLength
    ) {
      throw new Error("postDecode attribute data is too small");
    }

    const index = this.attributes.length;
    this.attributes.push({
      data: options.data,
      format: options.format,
      count,
      components,
      byteOffset,
      byteStride,
    });
    return this.instruction(
      COMPONENT_TYPES[components - 1],
      Opcode.InputAttribute,
      [],
      index,
    ) as AttributeValue<Components>;
  }

  coerce<T extends SplatPostDecodeValueType>(
    value: ValueLike<T>,
    expectedType?: T,
  ): SplatPostDecodeValue<T> {
    if (value instanceof SplatPostDecodeValue) {
      if (value.owner !== this) {
        throw new Error(
          "Cannot combine values from different postDecode programs",
        );
      }
      if (expectedType && value.type !== expectedType) {
        const vec4Quaternion =
          (expectedType === "quaternion" && value.type === "vec4") ||
          (expectedType === "vec4" && value.type === "quaternion");
        if (!vec4Quaternion) {
          throw new Error(`Expected ${expectedType}, received ${value.type}`);
        }
      }
      return value as SplatPostDecodeValue<T>;
    }

    const type = expectedType ?? inferLiteralType(value);
    const numeric =
      typeof value === "boolean"
        ? [value ? 1 : 0]
        : typeof value === "number"
          ? [value]
          : [...(value as readonly number[])];
    const width = TYPE_WIDTHS[type];
    if (numeric.length !== width) {
      throw new Error(`Expected ${width} values for ${type}`);
    }
    const values = numeric.map(Math.fround);
    if (!values.every(Number.isFinite)) {
      throw new Error("postDecode constants must be finite");
    }
    const key = constantKey(type, values);
    const existing = this.constantRegisters.get(key);
    if (existing) return existing as SplatPostDecodeValue<T>;

    const immediate = this.constants.length;
    this.constants.push(...values);
    const result = this.instruction(type as T, Opcode.Constant, [], immediate);
    this.constantRegisters.set(key, result);
    return result;
  }

  private unary(
    opcode: Opcode,
    value: AnyValueLike,
    outputType?: SplatPostDecodeValueType,
  ) {
    const input = this.coerce(value);
    return this.instruction(outputType ?? input.type, opcode, [input.register]);
  }

  private binary(
    opcode: Opcode,
    leftValue: AnyValueLike,
    rightValue: AnyValueLike,
    outputType?: SplatPostDecodeValueType,
  ) {
    const left = this.coerce(leftValue);
    const right = this.coerceForBinary(rightValue, left.type);
    return this.instruction(outputType ?? left.type, opcode, [
      left.register,
      right.register,
    ]);
  }

  private ternary(
    opcode: Opcode,
    firstValue: AnyValueLike,
    secondValue: AnyValueLike,
    thirdValue: AnyValueLike,
  ) {
    const first = this.coerce(firstValue);
    const second = this.coerceForBinary(secondValue, first.type);
    const third = this.coerceForBinary(thirdValue, first.type);
    return this.instruction(first.type, opcode, [
      first.register,
      second.register,
      third.register,
    ]);
  }

  private coerceForBinary(
    value: AnyValueLike,
    targetType: SplatPostDecodeValueType,
  ) {
    if (value instanceof SplatPostDecodeValue) {
      return value.type === "float" && TYPE_WIDTHS[targetType] > 1
        ? this.coerce(value)
        : this.coerce(value, targetType);
    }
    return this.coerce(
      value,
      typeof value === "number" && TYPE_WIDTHS[targetType] > 1
        ? "float"
        : targetType,
    );
  }

  private createOperations(): SplatPostDecodeOperations {
    const reduceNumeric =
      (opcode: Opcode): VariadicNumericOperation =>
      <T extends NumericValueType>(
        first: ValueLike<T>,
        ...rest: BroadcastLike<T>[]
      ) => {
        let result = this.coerce(first);
        for (const right of rest) {
          result = this.binary(
            opcode,
            result,
            right,
          ) as SplatPostDecodeValue<T>;
        }
        return result;
      };
    const binaryNumeric =
      (opcode: Opcode): BinaryNumericOperation =>
      <T extends NumericValueType>(
        left: ValueLike<T>,
        right: BroadcastLike<T>,
      ) =>
        this.binary(opcode, left, right) as SplatPostDecodeValue<T>;
    const unaryNumeric =
      (opcode: Opcode): UnaryNumericOperation =>
      <T extends NumericValueType>(value: ValueLike<T>) =>
        this.unary(opcode, value) as SplatPostDecodeValue<T>;
    const compare =
      (opcode: Opcode) => (left: AnyValueLike, right: AnyValueLike) =>
        this.binary(opcode, left, right, "bool") as BoolValue;
    const reduceBoolean =
      (opcode: Opcode) =>
      (first: BoolLike, ...rest: BoolLike[]): BoolValue => {
        let result = this.coerce(first, "bool");
        for (const right of rest) {
          result = this.binary(opcode, result, right, "bool") as BoolValue;
        }
        return result;
      };
    const construct = <T extends VectorValueType | "quaternion">(
      opcode: Opcode,
      type: T,
      values: FloatLike[],
    ) =>
      this.instruction(
        type,
        opcode,
        values.map((value) => this.coerce(value, "float").register),
      );

    return {
      add: reduceNumeric(Opcode.Add),
      sub: binaryNumeric(Opcode.Subtract),
      mul: reduceNumeric(Opcode.Multiply),
      div: binaryNumeric(Opcode.Divide),
      min: binaryNumeric(Opcode.Min),
      max: binaryNumeric(Opcode.Max),
      pow: binaryNumeric(Opcode.Pow),
      clamp: (value, min, max) =>
        this.ternary(Opcode.Clamp, value, min, max) as never,
      mix: (left, right, amount) =>
        this.ternary(Opcode.Mix, left, right, amount) as never,
      neg: unaryNumeric(Opcode.Negate),
      abs: unaryNumeric(Opcode.Abs),
      sqrt: unaryNumeric(Opcode.Sqrt),
      log: unaryNumeric(Opcode.Log),
      exp: unaryNumeric(Opcode.Exp),
      floor: unaryNumeric(Opcode.Floor),
      ceil: unaryNumeric(Opcode.Ceil),
      round: unaryNumeric(Opcode.Round),
      sin: unaryNumeric(Opcode.Sin),
      cos: unaryNumeric(Opcode.Cos),
      acos: unaryNumeric(Opcode.Acos),
      normalize: (value) => this.unary(Opcode.Normalize, value) as never,
      length: (value) =>
        this.unary(Opcode.Length, value, "float") as FloatValue,
      isFinite: (value) =>
        this.unary(Opcode.IsFinite, value, "bool") as BoolValue,
      not: (value) =>
        this.unary(Opcode.Not, this.coerce(value, "bool"), "bool") as BoolValue,
      eq: compare(Opcode.Equal),
      ne: compare(Opcode.NotEqual),
      lt: compare(Opcode.Less),
      lte: compare(Opcode.LessEqual),
      gt: compare(Opcode.Greater),
      gte: compare(Opcode.GreaterEqual),
      and: reduceBoolean(Opcode.And),
      or: reduceBoolean(Opcode.Or),
      select: (condition, whenTrue, whenFalse) => {
        const trueValue = this.coerce(whenTrue);
        const falseValue = this.coerce(whenFalse, trueValue.type);
        return this.instruction(trueValue.type, Opcode.Select, [
          this.coerce(condition, "bool").register,
          trueValue.register,
          falseValue.register,
        ]) as never;
      },
      dot: (left, right) =>
        this.binary(Opcode.Dot, left, right, "float") as FloatValue,
      cross: (left, right) =>
        this.binary(Opcode.Cross, left, right) as Vec3Value,
      vec2: (x, y) => construct(Opcode.Vec2, "vec2", [x, y]),
      vec3: (x, y, z) => construct(Opcode.Vec3, "vec3", [x, y, z]),
      vec4: (x, y, z, w) => construct(Opcode.Vec4, "vec4", [x, y, z, w]),
      quaternion: (x, y, z, w) =>
        construct(Opcode.Vec4, "quaternion", [x, y, z, w]),
      component: (value, index) => {
        const input = this.coerce(value as AnyValueLike);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= TYPE_WIDTHS[input.type]
        ) {
          throw new Error("postDecode component index is out of bounds");
        }
        return this.instruction(
          "float",
          Opcode.Component,
          [input.register],
          index,
        );
      },
      maxComponentIndex: (value) =>
        this.unary(Opcode.MaxComponentIndex, value, "float") as FloatValue,
      quatMul: (left, right) => {
        const a = this.coerce(left, "quaternion");
        const b = this.coerce(right, "quaternion");
        return this.instruction("quaternion", Opcode.QuaternionMultiply, [
          a.register,
          b.register,
        ]);
      },
      rotateVector: (quaternion, vector) => {
        const q = this.coerce(quaternion, "quaternion");
        const v = this.coerce(vector, "vec3");
        return this.instruction("vec3", Opcode.RotateVector, [
          q.register,
          v.register,
        ]);
      },
    };
  }
}

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
  builder: ProgramBuilder,
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

  constructor(private readonly builder: ProgramBuilder) {
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
  builder: ProgramBuilder,
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
    condition: { mode: "flow", stages },
    attributes: serializer.attributes,
  };
}

function compileProgram(
  builder: ProgramBuilder,
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

function packInstructions(
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

function snapshotAttributes(bindings: readonly AttributeBinding[]) {
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

class SplatPostDecodeProgramImpl implements SplatPostDecodeProgram {
  readonly [SPLAT_POST_DECODE_PROGRAM] = true as const;

  constructor(
    private readonly builder: ProgramBuilder,
    private readonly outputs: SplatPostDecodeOutputs,
  ) {}

  static serialize(program: SplatPostDecodeProgram): SerializedSplatPostDecode {
    if (!(program instanceof SplatPostDecodeProgramImpl)) {
      throw new Error("Invalid postDecode program");
    }
    const compiled = compileProgram(program.builder, program.outputs);
    const snapshot = snapshotAttributes(compiled.attributes);
    return {
      instructions: packInstructions(compiled.instructions),
      constants: new Float32Array(compiled.constants),
      outputs: compiled.outputs,
      condition: compiled.condition,
      attributeData: snapshot.data,
      attributes: snapshot.attributes,
    };
  }
}

/** @internal */
export function serializeSplatPostDecode(
  program: SplatPostDecodeProgram,
): SerializedSplatPostDecode {
  return SplatPostDecodeProgramImpl.serialize(program);
}

function buildOutputs(builder: ProgramBuilder, patch: SplatPostDecodePatch) {
  if (patch.opacity !== undefined && patch.alpha !== undefined) {
    throw new Error("postDecode opacity cannot be combined with alpha");
  }
  const output = <T extends SplatPostDecodeValueType>(
    value: ValueLike<T> | undefined,
    type: T,
  ) => (value === undefined ? undefined : builder.coerce(value, type).register);
  const outputs: SplatPostDecodeOutputs = {
    when: output(patch.when, "bool"),
    position: output(patch.position, "vec3"),
    scale: output(patch.scale, "vec3"),
    quaternion: output(patch.quaternion, "quaternion"),
    opacity: output(patch.opacity, "float"),
    alpha: output(patch.alpha, "float"),
    color: output(patch.color, "vec3"),
  };
  if (patch.sh !== undefined) {
    if (
      !(patch.sh instanceof SplatPostDecodeShPatch) ||
      patch.sh.owner !== builder
    ) {
      throw new Error(
        "postDecode SH output must be created from splat.sh.map()",
      );
    }
    outputs.sh = patch.sh.coefficients.map((value) => value.register);
  }
  return outputs;
}

function defineSplatPostDecode(
  build: (context: SplatPostDecodeContext) => SplatPostDecodePatch,
): SplatPostDecodeProgram {
  const builder = new ProgramBuilder();
  const patch = build({
    splat: builder.splat,
    op: builder.op,
    attribute: (options) => builder.attribute(options),
  });
  if (!patch || typeof patch !== "object") {
    throw new Error("postDecode builder must return a splat patch object");
  }
  return new SplatPostDecodeProgramImpl(builder, buildOutputs(builder, patch));
}

export const postDecode = {
  define: defineSplatPostDecode,
};
