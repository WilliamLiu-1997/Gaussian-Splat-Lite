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
const COMPONENT_TYPES = ["float", "vec2", "vec3", "vec4"] as const;

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
        const value = transform(this.coefficient(index), {
          index,
          degree,
          order,
        });
        coefficients.push(this.owner.coerce(value, "vec3"));
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

type SplatPostDecodeContext = {
  splat: SplatPostDecodeInput;
  op: SplatPostDecodeOperations;
  attribute<Components extends AttributeComponents = 1>(
    options: SplatPostDecodeAttributeOptions<Components>,
  ): AttributeValue<Components>;
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

function constantKey(
  type: SplatPostDecodeValueType,
  values: readonly number[],
) {
  return `${type}:${values
    .map((value) => (Object.is(value, -0) ? "-0" : value))
    .join(":")}`;
}

export type SplatPostDecodeProgram = {
  readonly [SPLAT_POST_DECODE_PROGRAM]: true;
};

class ProgramBuilder {
  readonly instructions: SplatPostDecodeInstruction[] = [];
  readonly constants: number[] = [];
  readonly attributes: AttributeBinding[] = [];
  readonly constantRegisters = new Map<
    string,
    SplatPostDecodeValue<SplatPostDecodeValueType>
  >();
  readonly inputRegisters = new Map<
    number,
    SplatPostDecodeValue<SplatPostDecodeValueType>
  >();

  readonly op: SplatPostDecodeOperations;
  readonly splat: SplatPostDecodeInput;

  constructor() {
    this.op = this.createOperations();
    const owner = this;
    const sh = new SplatPostDecodeShValue(this);
    this.splat = {
      get position() {
        return owner.inputField("vec3", InputField.Position);
      },
      get scale() {
        return owner.inputField("vec3", InputField.Scale);
      },
      get quaternion() {
        return owner.inputField("quaternion", InputField.Quaternion);
      },
      get opacity() {
        return owner.inputField("float", InputField.Opacity);
      },
      get alpha() {
        return owner.inputField("float", InputField.Alpha);
      },
      get color() {
        return owner.inputField("vec3", InputField.Color);
      },
      sh,
    };
  }

  inputField<T extends SplatPostDecodeValueType>(
    type: T,
    field: InputField,
  ): SplatPostDecodeValue<T> {
    const current = this.inputRegisters.get(field);
    if (current) return current as SplatPostDecodeValue<T>;
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
    if (!componentBytes)
      throw new Error(`Unknown postDecode format: ${options.format}`);
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

    const type = COMPONENT_TYPES[components - 1];
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
      type,
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
        const quaternionCompatible =
          (expectedType === "quaternion" && value.type === "vec4") ||
          (expectedType === "vec4" && value.type === "quaternion");
        if (!quaternionCompatible) {
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
    const floatValues = numeric.map((component) => Math.fround(component));
    if (!floatValues.every(Number.isFinite)) {
      throw new Error("postDecode constants must be finite");
    }
    const key = constantKey(type, floatValues);
    const current = this.constantRegisters.get(key);
    if (current) return current as SplatPostDecodeValue<T>;

    const constantBase = this.constants.length;
    this.constants.push(...floatValues);
    const constant = this.instruction(
      type as T,
      Opcode.Constant,
      [],
      constantBase,
    );
    this.constantRegisters.set(key, constant);
    return constant;
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

  private unary<T extends SplatPostDecodeValueType>(
    opcode: Opcode,
    value: ValueLike<T>,
    outputType?: SplatPostDecodeValueType,
  ) {
    const input = this.coerce(value);
    return this.instruction(outputType ?? input.type, opcode, [input.register]);
  }

  private binary<T extends SplatPostDecodeValueType>(
    opcode: Opcode,
    leftValue: ValueLike<T>,
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

  private ternary<T extends SplatPostDecodeValueType>(
    opcode: Opcode,
    firstValue: ValueLike<T>,
    secondValue: ValueLike<T> | FloatLike,
    thirdValue: ValueLike<T> | FloatLike,
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
      if (value.type === "float" && TYPE_WIDTHS[targetType] > 1) {
        return this.coerce(value);
      }
      return this.coerce(value, targetType);
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
        let value = this.coerce(first);
        for (const right of rest) {
          value = this.binary(opcode, value, right) as SplatPostDecodeValue<T>;
        }
        return value;
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
      (first: BoolLike, ...rest: BoolLike[]) => {
        let value = this.coerce(first, "bool");
        for (const right of rest) {
          value = this.binary(opcode, value, right, "bool") as BoolValue;
        }
        return value;
      };
    const construct = <T extends VectorValueType | "quaternion">(
      opcode: Opcode,
      type: T,
      values: FloatLike[],
    ) => {
      const args = values.map((value) => this.coerce(value, "float").register);
      return this.instruction(type, opcode, args);
    };

    return {
      add: reduceNumeric(Opcode.Add),
      sub: binaryNumeric(Opcode.Subtract),
      mul: reduceNumeric(Opcode.Multiply),
      div: binaryNumeric(Opcode.Divide),
      min: binaryNumeric(Opcode.Min),
      max: binaryNumeric(Opcode.Max),
      pow: binaryNumeric(Opcode.Pow),
      clamp: <T extends NumericValueType>(
        value: ValueLike<T>,
        min: BroadcastLike<T>,
        max: BroadcastLike<T>,
      ) =>
        this.ternary(Opcode.Clamp, value, min, max) as SplatPostDecodeValue<T>,
      mix: <T extends NumericValueType>(
        left: ValueLike<T>,
        right: ValueLike<T>,
        amount: BroadcastLike<T>,
      ) =>
        this.ternary(
          Opcode.Mix,
          left,
          right,
          amount,
        ) as SplatPostDecodeValue<T>,
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
      normalize: <T extends VectorValueType | "quaternion">(
        value: ValueLike<T>,
      ) => this.unary(Opcode.Normalize, value) as SplatPostDecodeValue<T>,
      length: (value) =>
        this.unary(Opcode.Length, value as AnyValueLike, "float") as FloatValue,
      isFinite: (value) =>
        this.unary(Opcode.IsFinite, value as AnyValueLike, "bool") as BoolValue,
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
      select: <T extends SplatPostDecodeValueType>(
        condition: BoolLike,
        whenTrue: ValueLike<T>,
        whenFalse: ValueLike<T>,
      ) => {
        const trueValue = this.coerce(whenTrue);
        const falseValue = this.coerce(whenFalse, trueValue.type);
        return this.instruction(trueValue.type, Opcode.Select, [
          this.coerce(condition, "bool").register,
          trueValue.register,
          falseValue.register,
        ]) as SplatPostDecodeValue<T>;
      },
      dot: (left, right) =>
        this.binary(
          Opcode.Dot,
          left as AnyValueLike,
          right as AnyValueLike,
          "float",
        ) as FloatValue,
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
        this.unary(
          Opcode.MaxComponentIndex,
          value as AnyValueLike,
          "float",
        ) as FloatValue,
      quatMul: (left, right) => {
        const leftValue = this.coerce(left, "quaternion");
        const rightValue = this.coerce(right, "quaternion");
        return this.instruction("quaternion", Opcode.QuaternionMultiply, [
          leftValue.register,
          rightValue.register,
        ]);
      },
      rotateVector: (quaternion, vector) => {
        const quaternionValue = this.coerce(quaternion, "quaternion");
        const vectorValue = this.coerce(vector, "vec3");
        return this.instruction("vec3", Opcode.RotateVector, [
          quaternionValue.register,
          vectorValue.register,
        ]);
      },
    };
  }
}

function inferLiteralType(value: unknown): SplatPostDecodeValueType {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "float";
  if (Array.isArray(value)) {
    if (value.length === 2) return "vec2";
    if (value.length === 3) return "vec3";
    if (value.length === 4) return "vec4";
  }
  throw new Error("Unsupported postDecode literal");
}

function pruneProgram(
  builder: ProgramBuilder,
  sourceOutputs: SplatPostDecodeOutputs,
) {
  const outputs = { ...sourceOutputs };
  if (outputs.when !== undefined) {
    const condition = builder.instructions[outputs.when];
    if (condition.opcode === Opcode.Constant) {
      if (builder.constants[condition.immediate] === 0) {
        return {
          instructions: [],
          constants: [],
          outputs: {},
          condition: undefined,
          attributes: [],
        };
      }
      outputs.when = undefined;
    }
  }

  const markDependencies = (
    roots: readonly (number | undefined)[],
    marked: Uint8Array,
  ) => {
    const pending: number[] = [];
    for (const register of roots) {
      if (register === undefined || marked[register]) continue;
      marked[register] = 1;
      pending.push(register);
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
  };

  const createSerializer = () => {
    const instructions: SplatPostDecodeInstruction[] = [];
    const constants: number[] = [];
    const attributes: AttributeBinding[] = [];
    const attributeMap = new Map<number, number>();
    const constantMap = new Map<number, number>();
    const dependencyMarks = new Uint32Array(builder.instructions.length);
    let dependencyGeneration = 0;
    let tooLarge = false;
    const append = (
      sourceOrder: readonly number[],
      registerMap: Int32Array = new Int32Array(
        builder.instructions.length,
      ).fill(-1),
    ) => {
      for (const sourceIndex of sourceOrder) {
        const source = builder.instructions[sourceIndex];
        if (source.opcode === Opcode.Constant) {
          let mapped = constantMap.get(sourceIndex);
          if (mapped === undefined) {
            if (instructions.length >= 4096) {
              tooLarge = true;
              break;
            }
            mapped = instructions.length;
            constantMap.set(sourceIndex, mapped);
            const immediate = constants.length;
            constants.push(
              ...builder.constants.slice(
                source.immediate,
                source.immediate + TYPE_WIDTHS[source.type],
              ),
            );
            instructions.push({ ...source, immediate });
          }
          registerMap[sourceIndex] = mapped;
          continue;
        }

        if (instructions.length >= 4096) {
          tooLarge = true;
          break;
        }
        let immediate = source.immediate;
        if (source.opcode === Opcode.InputAttribute) {
          let mapped = attributeMap.get(immediate);
          if (mapped === undefined) {
            mapped = attributes.length;
            attributeMap.set(immediate, mapped);
            attributes.push(builder.attributes[immediate]);
          }
          immediate = mapped;
        }
        registerMap[sourceIndex] = instructions.length;
        instructions.push({
          ...source,
          args: source.args.map((argument) => registerMap[argument]),
          immediate,
        });
      }
      return registerMap;
    };
    const appendDependencies = (
      roots: readonly (number | undefined)[],
      registerMap: Int32Array = new Int32Array(
        builder.instructions.length,
      ).fill(-1),
      forceRoots = false,
    ) => {
      if (forceRoots) {
        for (const root of roots) {
          if (
            root !== undefined &&
            builder.instructions[root].opcode !== Opcode.Constant
          ) {
            // Every flow stage needs a concrete instruction boundary even if
            // the same predicate register appeared in its unique predecessor.
            registerMap[root] = -1;
          }
        }
      }

      dependencyGeneration += 1;
      const pending: number[] = [];
      const sourceOrder: number[] = [];
      for (const root of roots) {
        if (root !== undefined && registerMap[root] === -1) {
          pending.push(root);
        }
      }
      while (pending.length !== 0) {
        const register = pending.pop();
        if (
          register === undefined ||
          registerMap[register] !== -1 ||
          dependencyMarks[register] === dependencyGeneration
        ) {
          continue;
        }
        dependencyMarks[register] = dependencyGeneration;
        sourceOrder.push(register);
        for (const argument of builder.instructions[register].args) {
          if (registerMap[argument] === -1) pending.push(argument);
        }
      }
      // Builder register indices are topological. Sorting only the newly found
      // dependencies preserves that order without rescanning the whole program.
      sourceOrder.sort((left, right) => left - right);
      return append(sourceOrder, registerMap);
    };
    return {
      instructions,
      constants,
      attributes,
      append,
      appendDependencies,
      get tooLarge() {
        return tooLarge;
      },
    };
  };

  const outputRoots = [
    outputs.position,
    outputs.scale,
    outputs.quaternion,
    outputs.opacity,
    outputs.alpha,
    outputs.color,
    ...(outputs.sh ?? []),
  ];

  // Compile every dynamic condition to the same forward flow. Atomic
  // predicates naturally produce one stage, while AND/OR/NOT recursively wire
  // those stages to accept/reject continuations without expanding to DNF/CNF.
  if (outputs.when !== undefined) {
    const whenRegister = outputs.when;
    const FLOW_ACCEPT = -1;
    const FLOW_REJECT = -2;
    const FLOW_DYNAMIC = 0;
    const FLOW_CONSTANT_FALSE = 1;
    const FLOW_CONSTANT_TRUE = 2;
    const MAX_FLOW_STAGE_COUNT = 4096;
    const constantFlowValues = new Uint8Array(builder.instructions.length);
    for (let register = 0; register <= whenRegister; register += 1) {
      const instruction = builder.instructions[register];
      if (
        instruction.opcode === Opcode.Constant &&
        instruction.type === "bool"
      ) {
        constantFlowValues[register] = builder.constants[instruction.immediate]
          ? FLOW_CONSTANT_TRUE
          : FLOW_CONSTANT_FALSE;
      } else if (instruction.opcode === Opcode.Not) {
        const value = constantFlowValues[instruction.args[0]];
        constantFlowValues[register] =
          value === FLOW_CONSTANT_TRUE
            ? FLOW_CONSTANT_FALSE
            : value === FLOW_CONSTANT_FALSE
              ? FLOW_CONSTANT_TRUE
              : FLOW_DYNAMIC;
      } else if (instruction.opcode === Opcode.And) {
        const left = constantFlowValues[instruction.args[0]];
        const right = constantFlowValues[instruction.args[1]];
        constantFlowValues[register] =
          left === FLOW_CONSTANT_FALSE || right === FLOW_CONSTANT_FALSE
            ? FLOW_CONSTANT_FALSE
            : left === FLOW_CONSTANT_TRUE && right === FLOW_CONSTANT_TRUE
              ? FLOW_CONSTANT_TRUE
              : FLOW_DYNAMIC;
      } else if (instruction.opcode === Opcode.Or) {
        const left = constantFlowValues[instruction.args[0]];
        const right = constantFlowValues[instruction.args[1]];
        constantFlowValues[register] =
          left === FLOW_CONSTANT_TRUE || right === FLOW_CONSTANT_TRUE
            ? FLOW_CONSTANT_TRUE
            : left === FLOW_CONSTANT_FALSE && right === FLOW_CONSTANT_FALSE
              ? FLOW_CONSTANT_FALSE
              : FLOW_DYNAMIC;
      }
    }
    type SourceFlowNode = {
      register: number;
      onTrue: number;
      onFalse: number;
    };
    const reverseFlowNodes: SourceFlowNode[] = [];
    let flowTooLarge = false;
    const compileFlow = (
      register: number,
      onTrue: number,
      onFalse: number,
    ): number => {
      if (flowTooLarge) return onFalse;

      const constantValue = constantFlowValues[register];
      if (constantValue !== FLOW_DYNAMIC) {
        return constantValue === FLOW_CONSTANT_TRUE ? onTrue : onFalse;
      }

      const instruction = builder.instructions[register];
      if (instruction.opcode === Opcode.Not) {
        return compileFlow(instruction.args[0], onFalse, onTrue);
      }
      if (instruction.opcode === Opcode.And) {
        const right = compileFlow(instruction.args[1], onTrue, onFalse);
        return compileFlow(instruction.args[0], right, onFalse);
      }
      if (instruction.opcode === Opcode.Or) {
        const right = compileFlow(instruction.args[1], onTrue, onFalse);
        return compileFlow(instruction.args[0], onTrue, right);
      }

      // Pure logical constants were folded above, so every remaining expanded
      // path eventually emits a stage and is bounded here.
      if (reverseFlowNodes.length >= MAX_FLOW_STAGE_COUNT) {
        flowTooLarge = true;
        return onFalse;
      }
      const node = reverseFlowNodes.length;
      reverseFlowNodes.push({ register, onTrue, onFalse });
      return node;
    };

    const flowEntry = compileFlow(whenRegister, FLOW_ACCEPT, FLOW_REJECT);
    if (!flowTooLarge && flowEntry === FLOW_REJECT) {
      return {
        instructions: [],
        constants: [],
        outputs: {},
        condition: undefined,
        attributes: [],
      };
    }
    if (!flowTooLarge && flowEntry === FLOW_ACCEPT) {
      outputs.when = undefined;
    } else if (!flowTooLarge) {
      const reachable = new Uint8Array(reverseFlowNodes.length);
      const pending = [flowEntry];
      while (pending.length !== 0) {
        const node = pending.pop();
        if (node === undefined || node < 0 || reachable[node]) continue;
        reachable[node] = 1;
        const { onTrue, onFalse } = reverseFlowNodes[node];
        pending.push(onTrue, onFalse);
      }

      // Nodes are created continuation-first. Reversing reachable nodes puts
      // every branch target after its source, which lets the runtime execute
      // the stages once in a simple forward pass.
      const sourceNodeOrder: number[] = [];
      for (let node = reverseFlowNodes.length - 1; node >= 0; node -= 1) {
        if (reachable[node]) sourceNodeOrder.push(node);
      }
      const flowMap = new Int32Array(reverseFlowNodes.length).fill(-1);
      for (let index = 0; index < sourceNodeOrder.length; index += 1) {
        flowMap[sourceNodeOrder[index]] = index;
      }

      if (flowMap[flowEntry] !== 0) {
        throw new Error("Invalid postDecode condition flow");
      }

      const stageCount = sourceNodeOrder.length;
      const acceptTarget = stageCount;
      const rejectTarget = acceptTarget + 1;
      const packedStages = new Uint16Array(
        stageCount * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE,
      );
      const predecessors = new Int32Array(stageCount).fill(-1);
      let acceptPredecessor = -1;
      const recordPredecessor = (target: number, predecessor: number) => {
        if (target === rejectTarget) return;
        if (target === acceptTarget) {
          if (acceptPredecessor === -1) acceptPredecessor = predecessor;
          else if (acceptPredecessor !== predecessor) acceptPredecessor = -2;
          return;
        }
        const current = predecessors[target];
        if (current === -1) predecessors[target] = predecessor;
        else if (current !== predecessor) predecessors[target] = -2;
      };
      const remapTarget = (target: number) =>
        target === FLOW_ACCEPT
          ? acceptTarget
          : target === FLOW_REJECT
            ? rejectTarget
            : flowMap[target];

      for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
        const node = reverseFlowNodes[sourceNodeOrder[stageIndex]];
        const offset = stageIndex * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE;
        const onTrue = remapTarget(node.onTrue);
        const onFalse = remapTarget(node.onFalse);
        packedStages[offset + SPLAT_POST_DECODE_FLOW_STAGE_ON_TRUE] = onTrue;
        packedStages[offset + SPLAT_POST_DECODE_FLOW_STAGE_ON_FALSE] = onFalse;
        recordPredecessor(onTrue, stageIndex);
        recordPredecessor(onFalse, stageIndex);
      }

      const serializer = createSerializer();
      let previousRegisterMap: Int32Array | undefined;
      for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
        const node = reverseFlowNodes[sourceNodeOrder[stageIndex]];
        const offset = stageIndex * SPLAT_POST_DECODE_FLOW_STAGE_STRIDE;
        packedStages[offset + SPLAT_POST_DECODE_FLOW_STAGE_START] =
          serializer.instructions.length;
        const registerMap = serializer.appendDependencies(
          [node.register],
          stageIndex > 0 && predecessors[stageIndex] === stageIndex - 1
            ? previousRegisterMap
            : undefined,
          true,
        );
        if (serializer.tooLarge) break;
        packedStages[offset + SPLAT_POST_DECODE_FLOW_STAGE_INSTRUCTION] =
          serializer.instructions.length - 1;
        packedStages[offset + SPLAT_POST_DECODE_FLOW_STAGE_REGISTER] =
          registerMap[node.register];
        previousRegisterMap = registerMap;
      }

      if (!serializer.tooLarge) {
        const lastStage = stageCount - 1;
        const outputMap = serializer.appendDependencies(
          outputRoots,
          acceptPredecessor === lastStage ? previousRegisterMap : undefined,
        );
        if (!serializer.tooLarge) {
          const remapOutput = (register: number | undefined) =>
            register === undefined ? undefined : outputMap[register];
          return {
            instructions: serializer.instructions,
            constants: serializer.constants,
            outputs: {
              position: remapOutput(outputs.position),
              scale: remapOutput(outputs.scale),
              quaternion: remapOutput(outputs.quaternion),
              opacity: remapOutput(outputs.opacity),
              alpha: remapOutput(outputs.alpha),
              color: remapOutput(outputs.color),
              sh: outputs.sh?.map((register) => outputMap[register]),
            },
            condition: { mode: "flow" as const, stages: packedStages },
            attributes: serializer.attributes,
          };
        }
      }
      // Pathological DAG expansion can exceed the normal 4096-instruction
      // bound. In that case the regular eager serializer below remains the
      // correctness-preserving fallback.
    }
  }

  const live = new Uint8Array(builder.instructions.length);
  markDependencies(outputRoots, live);
  const conditionLive = new Uint8Array(builder.instructions.length);
  if (outputs.when !== undefined) {
    markDependencies([outputs.when], conditionLive);
  }
  for (let index = 0; index < live.length; index += 1) {
    live[index] ||= conditionLive[index];
  }

  // The eager fallback keeps the complete condition in one topological prefix.
  // Reaching this path with a dynamic condition means expanded flow bytecode
  // exceeded the normal instruction bound.
  const instructionOrder: number[] = [];
  if (outputs.when !== undefined) {
    for (let index = 0; index < live.length; index += 1) {
      if (conditionLive[index]) instructionOrder.push(index);
    }
    for (let index = 0; index < live.length; index += 1) {
      if (live[index] && !conditionLive[index]) instructionOrder.push(index);
    }
  } else {
    for (let index = 0; index < live.length; index += 1) {
      if (live[index]) instructionOrder.push(index);
    }
  }

  const serializer = createSerializer();
  const registerMap = serializer.append(instructionOrder);
  const remap = (register: number | undefined) =>
    register === undefined ? undefined : registerMap[register];
  const when = remap(outputs.when);

  return {
    instructions: serializer.instructions,
    constants: serializer.constants,
    outputs: {
      position: remap(outputs.position),
      scale: remap(outputs.scale),
      quaternion: remap(outputs.quaternion),
      opacity: remap(outputs.opacity),
      alpha: remap(outputs.alpha),
      color: remap(outputs.color),
      sh: outputs.sh?.map((register) => registerMap[register]),
    },
    condition:
      when === undefined
        ? undefined
        : {
            mode: "flow" as const,
            stages: new Uint16Array([0, when, when, 1, 2]),
          },
    attributes: serializer.attributes,
  };
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
    const { builder } = program;
    const {
      instructions,
      constants,
      outputs,
      condition,
      attributes: attributeBindings,
    } = pruneProgram(builder, program.outputs);
    type AttributeRegion = {
      buffer: ArrayBufferLike;
      start: number;
      end: number;
      outputOffset: number;
    };
    const rangesByBuffer = new Map<
      ArrayBufferLike,
      { start: number; end: number }[]
    >();
    for (const attribute of attributeBindings) {
      if (attribute.count === 0) continue;
      const packedBytes =
        ATTRIBUTE_FORMAT_BYTES[attribute.format] * attribute.components;
      const start = attribute.data.byteOffset + attribute.byteOffset;
      const end =
        start + (attribute.count - 1) * attribute.byteStride + packedBytes;
      const ranges = rangesByBuffer.get(attribute.data.buffer) ?? [];
      ranges.push({ start, end });
      rangesByBuffer.set(attribute.data.buffer, ranges);
    }

    const regions: AttributeRegion[] = [];
    for (const [buffer, ranges] of rangesByBuffer) {
      ranges.sort((left, right) => left.start - right.start);
      let current: AttributeRegion | undefined;
      for (const range of ranges) {
        if (current && range.start <= current.end) {
          current.end = Math.max(current.end, range.end);
        } else {
          current = { buffer, ...range, outputOffset: 0 };
          regions.push(current);
        }
      }
    }

    let attributeByteLength = 0;
    for (const region of regions) {
      region.outputOffset = attributeByteLength;
      attributeByteLength += region.end - region.start;
    }
    const attributeData = new Uint8Array(attributeByteLength);
    for (const region of regions) {
      attributeData.set(
        new Uint8Array(region.buffer, region.start, region.end - region.start),
        region.outputOffset,
      );
    }
    const attributes = attributeBindings.map((attribute) => {
      let byteOffset = 0;
      if (attribute.count !== 0) {
        const sourceOffset = attribute.data.byteOffset + attribute.byteOffset;
        const region = regions.find(
          (candidate) =>
            candidate.buffer === attribute.data.buffer &&
            sourceOffset >= candidate.start &&
            sourceOffset < candidate.end,
        );
        if (!region) {
          throw new Error("postDecode attribute view was not serialized");
        }
        byteOffset = region.outputOffset + sourceOffset - region.start;
      }
      return {
        format: attribute.format,
        components: attribute.components,
        byteOffset,
        byteStride: attribute.byteStride,
        count: attribute.count,
      };
    });

    return {
      instructions: packInstructions(instructions),
      constants: new Float32Array(constants),
      outputs,
      condition,
      attributeData,
      attributes,
    };
  }
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
    for (
      let argumentIndex = 0;
      argumentIndex < instruction.args.length;
      argumentIndex += 1
    ) {
      packed[
        offset + SPLAT_POST_DECODE_INSTRUCTION_ARGUMENT_0 + argumentIndex
      ] = instruction.args[argumentIndex];
    }
  }
  return packed;
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
  const outputs = buildOutputs(builder, patch);
  return new SplatPostDecodeProgramImpl(builder, outputs);
}

export const postDecode = {
  define: defineSplatPostDecode,
};
