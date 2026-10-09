import {
  ATTRIBUTE_FORMAT_BYTES,
  InputField,
  Opcode,
  SH_COEFFICIENT_COUNT,
  TYPE_WIDTHS,
} from "./protocol.js";
class SplatPostDecodeValue {
  /** @internal */
  constructor(type, /** @internal */ register, /** @internal */ owner) {
    this.type = type;
    this.register = register;
    this.owner = owner;
  }
}
class SplatPostDecodeShPatch {
  /** @internal */
  constructor(/** @internal */ owner, /** @internal */ coefficients) {
    this.owner = owner;
    this.coefficients = coefficients;
  }
}
class SplatPostDecodeShValue {
  /** @internal */
  constructor(owner) {
    this.owner = owner;
  }
  coefficient(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= SH_COEFFICIENT_COUNT
    ) {
      throw new Error("SH coefficient index must be between 0 and 14");
    }
    return this.owner.inputField("vec3", InputField.Sh0 + index);
  }
  map(transform) {
    const coefficients = [];
    let index = 0;
    for (let degree = 1; degree <= 3; degree += 1) {
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
const COMPONENT_TYPES = ["float", "vec2", "vec3", "vec4"];
function inferLiteralType(value) {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "float";
  if (Array.isArray(value) && value.length >= 2 && value.length <= 4) {
    return COMPONENT_TYPES[value.length - 1];
  }
  throw new Error("Unsupported postDecode literal");
}
function constantKey(type, values) {
  return `${type}:${values
    .map((value) => (Object.is(value, -0) ? "-0" : value))
    .join(":")}`;
}
export class ProgramBuilder {
  constructor() {
    this.instructions = [];
    this.constants = [];
    this.attributes = [];
    this.constantRegisters = new Map();
    this.inputRegisters = new Map();
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
  instruction(type, opcode, args = [], immediate = 0) {
    if (this.instructions.length >= 4096) {
      throw new Error("postDecode program exceeds 4096 instructions");
    }
    const register = this.instructions.length;
    this.instructions.push({ opcode, type, args, immediate });
    return new SplatPostDecodeValue(type, register, this);
  }
  inputField(type, field) {
    const existing = this.inputRegisters.get(field);
    if (existing) return existing;
    const value = this.instruction(type, Opcode.InputField, [], field);
    this.inputRegisters.set(field, value);
    return value;
  }
  attribute(options) {
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
    );
  }
  coerce(value, expectedType) {
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
      return value;
    }
    const type = expectedType ?? inferLiteralType(value);
    const numeric =
      typeof value === "boolean"
        ? [value ? 1 : 0]
        : typeof value === "number"
          ? [value]
          : [...value];
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
    if (existing) return existing;
    const immediate = this.constants.length;
    this.constants.push(...values);
    const result = this.instruction(type, Opcode.Constant, [], immediate);
    this.constantRegisters.set(key, result);
    return result;
  }
  unary(opcode, value, outputType) {
    const input = this.coerce(value);
    return this.instruction(outputType ?? input.type, opcode, [input.register]);
  }
  binary(opcode, leftValue, rightValue, outputType) {
    const left = this.coerce(leftValue);
    const right = this.coerceForBinary(rightValue, left.type);
    return this.instruction(outputType ?? left.type, opcode, [
      left.register,
      right.register,
    ]);
  }
  ternary(opcode, firstValue, secondValue, thirdValue) {
    const first = this.coerce(firstValue);
    const second = this.coerceForBinary(secondValue, first.type);
    const third = this.coerceForBinary(thirdValue, first.type);
    return this.instruction(first.type, opcode, [
      first.register,
      second.register,
      third.register,
    ]);
  }
  coerceForBinary(value, targetType) {
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
  createOperations() {
    const reduceNumeric =
      (opcode) =>
      (first, ...rest) => {
        let result = this.coerce(first);
        for (const right of rest) {
          result = this.binary(opcode, result, right);
        }
        return result;
      };
    const binaryNumeric = (opcode) => (left, right) =>
      this.binary(opcode, left, right);
    const unaryNumeric = (opcode) => (value) => this.unary(opcode, value);
    const compare = (opcode) => (left, right) => {
      const a = this.coerce(left);
      const scalar = opcode !== Opcode.Equal && opcode !== Opcode.NotEqual;
      if (scalar && a.type !== "float")
        throw new Error("Ordered comparisons require scalars");
      const b = this.coerce(right, a.type);
      return this.instruction("bool", opcode, [a.register, b.register]);
    };
    const vectorBinary = (opcode, left, right) => {
      const a = this.coerce(left);
      if (
        !(a.type === "vec2" || a.type === "vec3" || a.type === "vec4") ||
        (opcode === Opcode.Cross && a.type !== "vec3")
      )
        throw new Error("dot/cross require matching vectors");
      const b = this.coerce(right, a.type);
      return this.instruction(
        opcode === Opcode.Dot ? "float" : a.type,
        opcode,
        [a.register, b.register],
      );
    };
    const reduceBoolean =
      (opcode) =>
      (first, ...rest) => {
        let result = this.coerce(first, "bool");
        for (const right of rest) {
          result = this.binary(opcode, result, right, "bool");
        }
        return result;
      };
    const construct = (opcode, type, values) =>
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
      clamp: (value, min, max) => this.ternary(Opcode.Clamp, value, min, max),
      mix: (left, right, amount) =>
        this.ternary(Opcode.Mix, left, right, amount),
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
      normalize: (value) => this.unary(Opcode.Normalize, value),
      length: (value) => this.unary(Opcode.Length, value, "float"),
      isFinite: (value) => this.unary(Opcode.IsFinite, value, "bool"),
      not: (value) =>
        this.unary(Opcode.Not, this.coerce(value, "bool"), "bool"),
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
        ]);
      },
      dot: (left, right) => vectorBinary(Opcode.Dot, left, right),
      cross: (left, right) => vectorBinary(Opcode.Cross, left, right),
      vec2: (x, y) => construct(Opcode.Vec2, "vec2", [x, y]),
      vec3: (x, y, z) => construct(Opcode.Vec3, "vec3", [x, y, z]),
      vec4: (x, y, z, w) => construct(Opcode.Vec4, "vec4", [x, y, z, w]),
      quaternion: (x, y, z, w) =>
        construct(Opcode.Vec4, "quaternion", [x, y, z, w]),
      component: (value, index) => {
        const input = this.coerce(value);
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
        this.unary(Opcode.MaxComponentIndex, value, "float"),
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
export function buildOutputs(builder, patch) {
  if (patch.opacity !== undefined && patch.alpha !== undefined) {
    throw new Error("postDecode opacity cannot be combined with alpha");
  }
  const output = (value, type) =>
    value === undefined ? undefined : builder.coerce(value, type).register;
  const outputs = {
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
