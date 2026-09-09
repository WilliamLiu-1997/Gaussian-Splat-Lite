import {
  ATTRIBUTE_FORMAT_BYTES,
  type AttributeBinding,
  type AttributeComponents,
  InputField,
  Opcode,
  SH_COEFFICIENT_COUNT,
  type SplatPostDecodeAttributeFormat,
  type SplatPostDecodeInstruction,
  type SplatPostDecodeOutputs,
  type SplatPostDecodeValueType,
  TYPE_WIDTHS,
} from "./protocol";

type NumericValueType = "float" | "vec2" | "vec3" | "vec4";

type VectorValueType = "vec2" | "vec3" | "vec4";

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

export class ProgramBuilder {
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
      tan: unaryNumeric(Opcode.Tan),
      asin: unaryNumeric(Opcode.Asin),
      atan: unaryNumeric(Opcode.Atan),
      atan2: binaryNumeric(Opcode.Atan2),
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

export function buildOutputs(
  builder: ProgramBuilder,
  patch: SplatPostDecodePatch,
) {
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
