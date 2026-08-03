"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const THREE = require("three");
const Pass_js = require("three/addons/postprocessing/Pass.js");
var _documentCurrentScript = typeof document !== "undefined" ? document.currentScript : null;
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const THREE__namespace = /* @__PURE__ */ _interopNamespaceDefault(THREE);
const LN_SCALE_MIN = -12;
const LN_SCALE_MAX = 9;
const SCALE_MIN = Math.exp(LN_SCALE_MIN);
const SCALE_MAX = Math.exp(LN_SCALE_MAX);
const LN_SCALE_ZERO = -30;
const SCALE_ZERO = Math.exp(LN_SCALE_ZERO);
const SPLAT_TEX_WIDTH_BITS = 11;
const SPLAT_TEX_HEIGHT_BITS = 11;
const SPLAT_TEX_DEPTH_BITS = 11;
const SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;
const SPLAT_TEX_WIDTH = 1 << SPLAT_TEX_WIDTH_BITS;
const SPLAT_TEX_HEIGHT = 1 << SPLAT_TEX_HEIGHT_BITS;
const SPLAT_TEX_DEPTH = 1 << SPLAT_TEX_DEPTH_BITS;
const SPLAT_TEX_MIN_HEIGHT = 1;
const SPLAT_TEX_WIDTH_MASK = SPLAT_TEX_WIDTH - 1;
const SPLAT_TEX_HEIGHT_MASK = SPLAT_TEX_HEIGHT - 1;
const SPLAT_TEX_DEPTH_MASK = SPLAT_TEX_DEPTH - 1;
var SplatFileType = /* @__PURE__ */ ((SplatFileType2) => {
  SplatFileType2["PLY"] = "ply";
  SplatFileType2["SPZ"] = "spz";
  return SplatFileType2;
})(SplatFileType || {});
const DEFAULT_SPLAT_ENCODING = {
  rgbMin: 0,
  rgbMax: 1,
  lnScaleMin: LN_SCALE_MIN,
  lnScaleMax: LN_SCALE_MAX,
  sh1Max: 1,
  sh2Max: 1,
  sh3Max: 1
};
const defines = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DEFAULT_SPLAT_ENCODING,
  LN_SCALE_MAX,
  LN_SCALE_MIN,
  LN_SCALE_ZERO,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_ZERO,
  SPLAT_TEX_DEPTH,
  SPLAT_TEX_DEPTH_BITS,
  SPLAT_TEX_DEPTH_MASK,
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_HEIGHT_BITS,
  SPLAT_TEX_HEIGHT_MASK,
  SPLAT_TEX_LAYER_BITS,
  SPLAT_TEX_MIN_HEIGHT,
  SPLAT_TEX_WIDTH,
  SPLAT_TEX_WIDTH_BITS,
  SPLAT_TEX_WIDTH_MASK,
  SplatFileType
}, Symbol.toStringTag, { value: "Module" }));
function isBoolType(type) {
  return type === "bool" || type === "bvec2" || type === "bvec3" || type === "bvec4";
}
function isScalarType(type) {
  return type === "int" || type === "uint" || type === "float";
}
function isIntType(type) {
  return type === "int" || type === "ivec2" || type === "ivec3" || type === "ivec4";
}
function isUintType(type) {
  return type === "uint" || type === "uvec2" || type === "uvec3" || type === "uvec4";
}
function isFloatType(type) {
  return type === "float" || type === "vec2" || type === "vec3" || type === "vec4";
}
function isMatFloatType(type) {
  return type === "mat2" || type === "mat2x2" || type === "mat2x3" || type === "mat2x4" || type === "mat3" || type === "mat3x2" || type === "mat3x3" || type === "mat3x4" || type === "mat4" || type === "mat4x2" || type === "mat4x3" || type === "mat4x4";
}
function isAllFloatType(type) {
  return isFloatType(type) || isMatFloatType(type);
}
function isVector2Type(type) {
  return type === "vec2" || type === "ivec2" || type === "uvec2";
}
function isVector3Type(type) {
  return type === "vec3" || type === "ivec3" || type === "uvec3";
}
function isVector4Type(type) {
  return type === "vec4" || type === "ivec4" || type === "uvec4";
}
function isVectorType(type) {
  return isVector2Type(type) || isVector3Type(type) || isVector4Type(type);
}
function isMat2(type) {
  return type === "mat2" || type === "mat2x2";
}
function isMat3(type) {
  return type === "mat3" || type === "mat3x3";
}
function isMat4(type) {
  return type === "mat4" || type === "mat4x4";
}
function vectorElementType(type) {
  switch (type) {
    case "vec2":
      return "float";
    case "vec3":
      return "float";
    case "vec4":
      return "float";
    case "ivec2":
      return "int";
    case "ivec3":
      return "int";
    case "ivec4":
      return "int";
    case "uvec2":
      return "uint";
    case "uvec3":
      return "uint";
    case "uvec4":
      return "uint";
    default:
      throw new Error(`Invalid vector type: ${type}`);
  }
}
function vectorDim(type) {
  switch (type) {
    case "vec2":
    case "ivec2":
    case "uvec2":
      return 2;
    case "vec3":
    case "ivec3":
    case "uvec3":
      return 3;
    case "vec4":
    case "ivec4":
    case "uvec4":
      return 4;
    default:
      throw new Error(`Invalid vector type: ${type}`);
  }
}
function sameSizeVec(type) {
  if (isScalarType(type)) {
    return "float";
  }
  if (isVector2Type(type)) {
    return "vec2";
  }
  if (isVector3Type(type)) {
    return "vec3";
  }
  if (isVector4Type(type)) {
    return "vec4";
  }
  throw new Error(`Invalid vector type: ${type}`);
}
function sameSizeUvec(type) {
  if (isScalarType(type)) {
    return "uint";
  }
  if (isVector2Type(type)) {
    return "uvec2";
  }
  if (isVector3Type(type)) {
    return "uvec3";
  }
  if (isVector4Type(type)) {
    return "uvec4";
  }
  throw new Error(`Invalid vector type: ${type}`);
}
function sameSizeIvec(type) {
  if (isScalarType(type)) {
    return "int";
  }
  if (isVector2Type(type)) {
    return "ivec2";
  }
  if (isVector3Type(type)) {
    return "ivec3";
  }
  if (isVector4Type(type)) {
    return "ivec4";
  }
  throw new Error(`Invalid vector type: ${type}`);
}
function typeLiteral(type) {
  if (typeof type === "string") {
    return type;
  }
  if (typeof type === "object" && type.type) {
    return type.type;
  }
  throw new Error(`Invalid DynoType: ${String(type)}`);
}
function numberAsInt(value) {
  return Math.trunc(value).toString();
}
function numberAsUint(value) {
  const v = Math.max(0, Math.trunc(value));
  return `${v.toString()}u`;
}
function numberAsFloat(value) {
  return value === Number.POSITIVE_INFINITY ? "INFINITY" : value === Number.NEGATIVE_INFINITY ? "-INFINITY" : Number.isInteger(value) ? value.toFixed(1) : value.toString();
}
function valType(val) {
  if (val instanceof DynoValue) {
    return val.type;
  }
  const value = val.dynoOut();
  return value.type;
}
class DynoValue {
  constructor(type) {
    this.__isDynoValue = true;
    this.type = type;
  }
}
class DynoOutput extends DynoValue {
  constructor(dyno2, key) {
    super(dyno2.outTypes[key]);
    this.dyno = dyno2;
    this.key = key;
  }
}
class DynoLiteral extends DynoValue {
  constructor(type, literal) {
    super(type);
    this.literal = literal;
  }
  getLiteral() {
    return this.literal;
  }
}
function dynoLiteral(type, literal) {
  return new DynoLiteral(type, literal);
}
class DynoConst extends DynoLiteral {
  constructor(type, value) {
    super(type, "");
    this.value = value;
  }
  getLiteral() {
    const { type, value } = this;
    switch (type) {
      case "bool":
        return value ? "true" : "false";
      case "uint":
        return numberAsUint(value);
      case "int":
        return numberAsInt(value);
      case "float":
        return numberAsFloat(value);
      case "bvec2": {
        const v = value;
        return `bvec2(${v[0]}, ${v[1]})`;
      }
      case "uvec2": {
        if (value instanceof THREE__namespace.Vector2) {
          return `uvec2(${numberAsUint(value.x)}, ${numberAsUint(value.y)})`;
        }
        const v = value;
        return `uvec2(${numberAsUint(v[0])}, ${numberAsUint(v[1])})`;
      }
      case "ivec2": {
        if (value instanceof THREE__namespace.Vector2) {
          return `ivec2(${numberAsInt(value.x)}, ${numberAsInt(value.y)})`;
        }
        const v = value;
        return `ivec2(${numberAsInt(v[0])}, ${numberAsInt(v[1])})`;
      }
      case "vec2": {
        if (value instanceof THREE__namespace.Vector2) {
          return `vec2(${numberAsFloat(value.x)}, ${numberAsFloat(value.y)})`;
        }
        const v = value;
        return `vec2(${numberAsFloat(v[0])}, ${numberAsFloat(v[1])})`;
      }
      case "bvec3": {
        const v = value;
        return `bvec3(${v[0]}, ${v[1]}, ${v[2]})`;
      }
      case "uvec3": {
        if (value instanceof THREE__namespace.Vector3) {
          return `uvec3(${numberAsUint(value.x)}, ${numberAsUint(value.y)}, ${numberAsUint(value.z)})`;
        }
        const v = value;
        return `uvec3(${numberAsUint(v[0])}, ${numberAsUint(v[1])}, ${numberAsUint(v[2])})`;
      }
      case "ivec3": {
        if (value instanceof THREE__namespace.Vector3) {
          return `ivec3(${numberAsInt(value.x)}, ${numberAsInt(value.y)}, ${numberAsInt(value.z)})`;
        }
        const v = value;
        return `ivec3(${numberAsInt(v[0])}, ${numberAsInt(v[1])}, ${numberAsInt(v[2])})`;
      }
      case "vec3": {
        if (value instanceof THREE__namespace.Vector3) {
          return `vec3(${numberAsFloat(value.x)}, ${numberAsFloat(value.y)}, ${numberAsFloat(value.z)})`;
        }
        const v = value;
        return `vec3(${numberAsFloat(v[0])}, ${numberAsFloat(v[1])}, ${numberAsFloat(v[2])})`;
      }
      case "bvec4": {
        const v = value;
        return `bvec4(${v[0]}, ${v[1]}, ${v[2]}, ${v[3]})`;
      }
      case "uvec4": {
        if (value instanceof THREE__namespace.Vector4) {
          return `uvec4(${numberAsUint(value.x)}, ${numberAsUint(value.y)}, ${numberAsUint(value.z)}, ${numberAsUint(value.w)})`;
        }
        const v = value;
        return `uvec4(${numberAsUint(v[0])}, ${numberAsUint(v[1])}, ${numberAsUint(v[2])}, ${numberAsUint(v[3])})`;
      }
      case "ivec4": {
        if (value instanceof THREE__namespace.Vector4) {
          return `ivec4(${numberAsInt(value.x)}, ${numberAsInt(value.y)}, ${numberAsInt(value.z)}, ${numberAsInt(value.w)})`;
        }
        const v = value;
        return `ivec4(${numberAsInt(v[0])}, ${numberAsInt(v[1])}, ${numberAsInt(v[2])}, ${numberAsInt(v[3])})`;
      }
      case "vec4": {
        if (value instanceof THREE__namespace.Vector4) {
          return `vec4(${numberAsFloat(value.x)}, ${numberAsFloat(value.y)}, ${numberAsFloat(value.z)}, ${numberAsFloat(value.w)})`;
        }
        if (value instanceof THREE__namespace.Quaternion) {
          return `vec4(${numberAsFloat(value.x)}, ${numberAsFloat(value.y)}, ${numberAsFloat(value.z)}, ${numberAsFloat(value.w)})`;
        }
        const v = value;
        return `vec4(${numberAsFloat(v[0])}, ${numberAsFloat(v[1])}, ${numberAsFloat(v[2])}, ${numberAsFloat(v[3])})`;
      }
      case "mat2":
      case "mat2x2": {
        const m = value;
        const e = m instanceof THREE__namespace.Matrix2 ? m.elements : value;
        const arg = new Array(4).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      case "mat2x3": {
        const e = value;
        const arg = new Array(6).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      case "mat2x4": {
        const e = value;
        const arg = new Array(8).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      case "mat3":
      case "mat3x3": {
        const m = value;
        const e = m instanceof THREE__namespace.Matrix3 ? m.elements : value;
        const arg = new Array(9).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      case "mat3x2": {
        const e = value;
        const arg = new Array(6).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      case "mat3x4": {
        const e = value;
        const arg = new Array(12).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      case "mat4":
      case "mat4x4": {
        const m = value;
        const e = m instanceof THREE__namespace.Matrix4 ? m.elements : value;
        const arg = new Array(16).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      case "mat4x2": {
        const e = value;
        const arg = new Array(8).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      case "mat4x3": {
        const e = value;
        const arg = new Array(12).fill(0).map((_, i) => numberAsFloat(e[i]));
        return `${type}(${arg.join(", ")})`;
      }
      default:
        throw new Error(`Type not implemented: ${String(type)}`);
    }
  }
}
function dynoConst(type, value) {
  return new DynoConst(type, value);
}
function literalZero(type) {
  const typeString = String(type);
  if (isBoolType(type)) {
    return `${typeString}(false)`;
  }
  if (isAllFloatType(type)) {
    return `${typeString}(0.0)`;
  }
  if (isIntType(type)) {
    return `${typeString}(0)`;
  }
  if (isUintType(type)) {
    return `${typeString}(0u)`;
  }
  throw new Error(`Type not implemented: ${typeString}`);
}
function literalOne(type) {
  const typeString = String(type);
  if (isBoolType(type)) {
    return `${typeString}(true)`;
  }
  if (isAllFloatType(type)) {
    return `${typeString}(1.0)`;
  }
  if (isIntType(type)) {
    return `${typeString}(1)`;
  }
  if (isUintType(type)) {
    return `${typeString}(1u)`;
  }
  throw new Error(`Type not implemented: ${typeString}`);
}
function literalNegOne(type) {
  const typeString = String(type);
  if (isBoolType(type)) {
    return `${typeString}(true)`;
  }
  if (isAllFloatType(type)) {
    return `${typeString}(-1.0)`;
  }
  if (isIntType(type)) {
    return `${typeString}(-1)`;
  }
  if (isUintType(type)) {
    return `${typeString}(0xFFFFFFFFu)`;
  }
  throw new Error(`Type not implemented: ${typeString}`);
}
const DEFAULT_INDENT = "    ";
class Compilation {
  constructor({ indent } = {}) {
    this.globals = /* @__PURE__ */ new Set();
    this.statements = [];
    this.uniforms = {};
    this.declares = /* @__PURE__ */ new Set();
    this.updaters = [];
    this.sequence = 0;
    this.indent = DEFAULT_INDENT;
    this.indent = indent ?? DEFAULT_INDENT;
  }
  nextSequence() {
    return this.sequence++;
  }
}
class Dyno {
  constructor({
    inTypes,
    outTypes,
    inputs,
    update,
    globals,
    statements,
    generate
  }) {
    this.inTypes = inTypes ?? {};
    this.outTypes = outTypes ?? {};
    this.inputs = inputs ?? {};
    this.update = update;
    this.globals = globals;
    this.statements = statements;
    this.generate = generate ?? (({ inputs: inputs2, outputs, compile }) => {
      var _a, _b;
      return {
        globals: (_a = this.globals) == null ? void 0 : _a.call(this, { inputs: inputs2, outputs, compile }),
        statements: (_b = this.statements) == null ? void 0 : _b.call(this, { inputs: inputs2, outputs, compile })
      };
    });
  }
  get outputs() {
    const outputs = {};
    for (const key in this.outTypes) {
      outputs[key] = new DynoOutput(this, key);
    }
    return outputs;
  }
  apply(inputs) {
    Object.assign(this.inputs, inputs);
    return this.outputs;
  }
  compile({
    inputs,
    outputs,
    compile
  }) {
    const result = [
      `// ${this.constructor.name}(${Object.values(inputs).join(", ")}) => (${Object.values(outputs).join(", ")})`
    ];
    const declares = [];
    for (const key in outputs) {
      const name = outputs[key];
      if (name && !compile.declares.has(name)) {
        compile.declares.add(name);
        declares.push(key);
      }
    }
    const { globals, statements, uniforms } = this.generate({
      inputs,
      outputs,
      compile
    });
    for (const global of globals ?? []) {
      compile.globals.add(global);
    }
    for (const key in uniforms) {
      compile.uniforms[key] = uniforms[key];
    }
    if (this.update) {
      compile.updaters.push(this.update);
    }
    for (const key of declares) {
      const name = outputs[key];
      if (name) {
        if (!compile.uniforms[name]) {
          result.push(`${dynoDeclare(name, this.outTypes[key])};`);
        }
      }
    }
    if (statements == null ? void 0 : statements.length) {
      result.push("{");
      result.push(...statements.map((line) => compile.indent + line));
      result.push("}");
    }
    return result;
  }
}
class DynoBlock extends Dyno {
  constructor({
    inTypes,
    outTypes,
    inputs,
    update,
    globals,
    construct
  }) {
    super({
      inTypes,
      outTypes,
      inputs,
      update,
      globals,
      generate: (args) => this.generateBlock(args)
    });
    this.construct = construct;
  }
  generateBlock({
    inputs,
    outputs,
    compile
  }) {
    var _a, _b;
    const blockInputs = {};
    const blockOutputs = {};
    for (const key in inputs) {
      if (inputs[key] != null) {
        blockInputs[key] = new DynoLiteral(this.inTypes[key], inputs[key]);
      }
    }
    for (const key in outputs) {
      if (outputs[key] != null) {
        blockOutputs[key] = new DynoValue(this.outTypes[key]);
      }
    }
    const options = { roots: [] };
    const returned = this.construct(blockInputs, blockOutputs, options);
    for (const global of ((_a = this.globals) == null ? void 0 : _a.call(this, { inputs, outputs, compile })) ?? []) {
      compile.globals.add(global);
    }
    const ordering = [];
    const nodeOuts = /* @__PURE__ */ new Map();
    function visit(node, outKey, outName) {
      let outs = nodeOuts.get(node);
      if (!outs) {
        outs = {
          sequence: compile.nextSequence(),
          outNames: /* @__PURE__ */ new Map(),
          newOuts: /* @__PURE__ */ new Set()
        };
        nodeOuts.set(node, outs);
        for (const key in node.inputs) {
          let input = node.inputs[key];
          while (input) {
            if (input instanceof DynoValue) {
              if (input instanceof DynoOutput) {
                visit(input.dyno, input.key);
              }
              break;
            }
            if (typeof input.dynoOut !== "function") {
              throw new Error(
                `dynoOut is not a function for ${input.constructor.name}`
              );
            }
            input = input.dynoOut();
          }
        }
        ordering.push(node);
      }
      if (outKey) {
        if (!outName) {
          outs.newOuts.add(outKey);
        }
        outs.outNames.set(outKey, outName ?? `${outKey}_${outs.sequence}`);
      }
    }
    for (const root of options.roots) {
      visit(root);
    }
    for (const key in blockOutputs) {
      let value = (returned == null ? void 0 : returned[key]) ?? blockOutputs[key];
      while (value) {
        if (value instanceof DynoValue) {
          if (value instanceof DynoOutput) {
            visit(value.dyno, value.key, outputs[key]);
          }
          break;
        }
        value = value.dynoOut();
      }
      blockOutputs[key] = value;
    }
    const steps = [];
    for (const dyno2 of ordering) {
      const inputs2 = {};
      const outputs2 = {};
      for (const key in dyno2.inputs) {
        let value = dyno2.inputs[key];
        while (value) {
          if (value instanceof DynoValue) {
            if (value instanceof DynoLiteral) {
              inputs2[key] = value.getLiteral();
            } else if (value instanceof DynoOutput) {
              const source = (_b = nodeOuts.get(value.dyno)) == null ? void 0 : _b.outNames.get(value.key);
              if (!source) {
                throw new Error(
                  `Source not found for ${value.dyno.constructor.name}.${value.key}`
                );
              }
              inputs2[key] = source;
            }
            break;
          }
          value = value.dynoOut();
        }
      }
      const outs = nodeOuts.get(dyno2) ?? { outNames: /* @__PURE__ */ new Map() };
      for (const [key, name] of outs.outNames.entries()) {
        outputs2[key] = name;
      }
      const newSteps = dyno2.compile({ inputs: inputs2, outputs: outputs2, compile });
      steps.push(newSteps);
    }
    const literalOutputs = [];
    for (const key in outputs) {
      if (blockOutputs[key] instanceof DynoLiteral) {
        literalOutputs.push(
          `${outputs[key]} = ${blockOutputs[key].getLiteral()};`
        );
      }
    }
    if (literalOutputs.length > 0) {
      steps.push(literalOutputs);
    }
    const statements = steps.flatMap((step2, index) => {
      return index === 0 ? step2 : ["", ...step2];
    });
    return { statements };
  }
}
function dynoBlock(inTypes, outTypes, construct, { update, globals } = {}) {
  return new DynoBlock({ inTypes, outTypes, construct, update, globals });
}
function dyno$1({
  inTypes,
  outTypes,
  inputs,
  update,
  globals,
  statements,
  generate
}) {
  return new Dyno({
    inTypes,
    outTypes,
    inputs,
    update,
    globals,
    statements,
    generate
  });
}
function dynoDeclare(name, type, count) {
  const typeStr = typeof type === "string" ? type : type.type;
  if (!typeStr) {
    throw new Error(`Invalid DynoType: ${String(type)}`);
  }
  return `${typeStr} ${name}${count != null ? `[${count}]` : ""}`;
}
function unindentLines(s) {
  var _a;
  let seenNonEmpty = false;
  const lines = s.split("\n").map((line) => {
    const trimmedLine = line.trimEnd();
    if (seenNonEmpty) {
      return trimmedLine;
    }
    if (trimmedLine.length > 0) {
      seenNonEmpty = true;
      return trimmedLine;
    }
    return null;
  }).filter((line) => line != null);
  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  if (lines.length === 0) {
    return [];
  }
  const indent = (_a = lines[0].match(/^\s*/)) == null ? void 0 : _a[0];
  if (!indent) {
    return lines;
  }
  const regex = new RegExp(`^${indent}`);
  return lines.map((line) => line.replace(regex, ""));
}
function unindent(s) {
  return unindentLines(s).join("\n");
}
class UnaryOp extends Dyno {
  constructor({
    a,
    outKey,
    outTypeFunc
  }) {
    const inTypes = { a: valType(a) };
    const outType = outTypeFunc(valType(a));
    const outTypes = { [outKey]: outType };
    super({ inTypes, outTypes, inputs: { a } });
    this.outKey = outKey;
  }
  dynoOut() {
    return new DynoOutput(this, this.outKey);
  }
}
class BinaryOp extends Dyno {
  constructor({
    a,
    b,
    outKey,
    outTypeFunc
  }) {
    const inTypes = { a: valType(a), b: valType(b) };
    const outType = outTypeFunc(valType(a), valType(b));
    const outTypes = { [outKey]: outType };
    super({ inTypes, outTypes, inputs: { a, b } });
    this.outKey = outKey;
  }
  dynoOut() {
    return new DynoOutput(this, this.outKey);
  }
}
class TrinaryOp extends Dyno {
  constructor({
    a,
    b,
    c,
    outKey,
    outTypeFunc
  }) {
    const inTypes = { a: valType(a), b: valType(b), c: valType(c) };
    const outType = outTypeFunc(valType(a), valType(b), valType(c));
    const outTypes = { [outKey]: outType };
    super({ inTypes, outTypes, inputs: { a, b, c } });
    this.outKey = outKey;
  }
  dynoOut() {
    return new DynoOutput(this, this.outKey);
  }
}
const Gsplat = { type: "Gsplat" };
const CovSplat = { type: "CovSplat" };
const TPackedSplats = { type: "PackedSplats" };
const TExtSplats = { type: "ExtSplats" };
const TCovSplats = { type: "CovSplats" };
const numPackedSplats = (packedSplats) => new NumPackedSplats({ packedSplats });
const readPackedSplat = (packedSplats, index) => new ReadPackedSplat({ packedSplats, index });
const readPackedSplatRange = (packedSplats, index, base, count) => new ReadPackedSplatRange({ packedSplats, index, base, count });
const numExtSplats = (extSplats) => new NumExtSplats({ extSplats });
const readExtSplat = (extSplats, index) => new ReadExtSplat({ extSplats, index });
const numCovSplats = (covsplats) => new NumCovSplats({ covsplats });
const readCovSplat = (covSplats, index) => new ReadCovSplat({ covSplats, index });
const gsplatToCovSplat = (gsplat) => new GsplatToCovSplat({ gsplat });
const splitGsplat = (gsplat) => new SplitGsplat({ gsplat });
const combineGsplat = ({
  gsplat,
  flags,
  index,
  center,
  scales,
  quaternion,
  rgba,
  rgb,
  opacity,
  x,
  y,
  z,
  r,
  g,
  b
}) => {
  return new CombineGsplat({
    gsplat,
    flags,
    index,
    center,
    scales,
    quaternion,
    rgba,
    rgb,
    opacity,
    x,
    y,
    z,
    r,
    g,
    b
  });
};
const gsplatNormal = (gsplat) => new GsplatNormal({ gsplat });
const transformGsplat = (gsplat, {
  scale,
  rotate,
  translate,
  recolor
}) => {
  return new TransformGsplat({ gsplat, scale, rotate, translate, recolor });
};
const splatTexCoord = (index) => new SplatTexCoord({ index });
const defineGsplat = unindent(`
  struct Gsplat {
    vec3 center;
    uint flags;
    vec3 scales;
    int index;
    vec4 quaternion;
    vec4 rgba;
  };
  const uint GSPLAT_FLAG_ACTIVE = 1u << 0u;

  bool isGsplatActive(uint flags) {
    return (flags & GSPLAT_FLAG_ACTIVE) != 0u;
  }
`);
const defineCovSplat = unindent(`
  struct CovSplat {
    vec3 center;
    uint flags;
    vec4 rgba;
    vec3 xxyyzz;
    int index;
    vec3 xyxzyz;
  };

  bool isCovSplatActive(uint flags) {
    return (flags & GSPLAT_FLAG_ACTIVE) != 0u;
  }
`);
const definePackedSplats = unindent(`
  struct PackedSplats {
    usampler2DArray textureArray;
    int numSplats;
    vec4 rgbMinMaxLnScaleMinMax;
  };
`);
class NumPackedSplats extends UnaryOp {
  constructor({
    packedSplats
  }) {
    super({ a: packedSplats, outKey: "numSplats", outTypeFunc: () => "int" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.numSplats} = ${inputs.a}.numSplats;`
    ];
  }
}
const defineReadPackedArray = unindent(`
  bool readPackedArray(usampler2DArray texture, int numSplats, vec4 rgbMinMaxLnScaleMinMax, int index, out Gsplat gsplat) {
    if ((index >= 0) && (index < numSplats)) {
      uvec4 packedData = texelFetch(texture, splatTexCoord(index), 0);
      unpackSplatEncoding(packedData, gsplat.center, gsplat.scales, gsplat.quaternion, gsplat.rgba, rgbMinMaxLnScaleMinMax);
      return true;
    } else {
      return false;
    }
  }
`);
class ReadPackedSplat extends Dyno {
  constructor({
    packedSplats,
    index
  }) {
    super({
      inTypes: { packedSplats: TPackedSplats, index: "int" },
      outTypes: { gsplat: Gsplat },
      inputs: { packedSplats, index },
      globals: () => [defineGsplat, definePackedSplats, defineReadPackedArray],
      statements: ({ inputs, outputs }) => {
        const { gsplat } = outputs;
        if (!gsplat) {
          return [];
        }
        const { packedSplats: packedSplats2, index: index2 } = inputs;
        let statements;
        if (packedSplats2 && index2) {
          statements = unindentLines(`
            ${gsplat}.flags = 0u;
            if (readPackedArray(${packedSplats2}.textureArray, ${packedSplats2}.numSplats, ${packedSplats2}.rgbMinMaxLnScaleMinMax, ${index2}, ${gsplat})) {
              bool zeroSize = all(equal(${gsplat}.scales, vec3(0.0, 0.0, 0.0)));
              ${gsplat}.flags = zeroSize ? 0u : GSPLAT_FLAG_ACTIVE;
            }
          `);
        } else {
          statements = [`${gsplat}.flags = 0u;`];
        }
        statements.push(`${gsplat}.index = ${index2 ?? "0"};`);
        return statements;
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "gsplat");
  }
}
class ReadPackedSplatRange extends Dyno {
  constructor({
    packedSplats,
    index,
    base,
    count
  }) {
    super({
      inTypes: {
        packedSplats: TPackedSplats,
        index: "int",
        base: "int",
        count: "int"
      },
      outTypes: { gsplat: Gsplat },
      inputs: { packedSplats, index, base, count },
      globals: () => [defineGsplat, definePackedSplats, defineReadPackedArray],
      statements: ({ inputs, outputs }) => {
        const { gsplat } = outputs;
        if (!gsplat) {
          return [];
        }
        const { packedSplats: packedSplats2, index: index2, base: base2, count: count2 } = inputs;
        let statements;
        if (packedSplats2 && index2 && base2 && count2) {
          statements = unindentLines(`
            ${gsplat}.flags = 0u;
            if (readPackedArray(${packedSplats2}.textureArray, ${packedSplats2}.numSplats, ${packedSplats2}.rgbMinMaxLnScaleMinMax, ${index2}, ${gsplat})) {
              bool zeroSize = all(equal(${gsplat}.scales, vec3(0.0, 0.0, 0.0)));
              ${gsplat}.flags = zeroSize ? 0u : GSPLAT_FLAG_ACTIVE;
            }
          `);
        } else {
          statements = [`${gsplat}.flags = 0u;`];
        }
        statements.push(`${gsplat}.index = ${index2 ?? "0"};`);
        return statements;
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "gsplat");
  }
}
const defineExtSplats = unindent(`
  struct ExtSplats {
    usampler2DArray textureArray1;
    usampler2DArray textureArray2;
    int numSplats;
  };
`);
class NumExtSplats extends UnaryOp {
  constructor({ extSplats }) {
    super({ a: extSplats, outKey: "numSplats", outTypeFunc: () => "int" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.numSplats} = ${inputs.a}.numSplats;`
    ];
  }
}
const defineReadExtArrays = unindent(`
  void readExtArrays(usampler2DArray texture1, usampler2DArray texture2, int numSplats, int index, out Gsplat gsplat) {
    gsplat.flags = 0u;
    if ((index >= 0) && (index < numSplats)) {
      ivec3 coord = splatTexCoord(index);
      uvec4 packed1 = texelFetch(texture1, coord, 0);
      uvec4 packed2 = texelFetch(texture2, coord, 0);
      unpackSplatExt(packed1, packed2, gsplat.center, gsplat.scales, gsplat.quaternion, gsplat.rgba);
      gsplat.flags = all(equal(gsplat.scales, vec3(0.0, 0.0, 0.0))) ? 0u : GSPLAT_FLAG_ACTIVE;
      gsplat.index = index;
    }
  }
`);
class ReadExtSplat extends Dyno {
  constructor({
    extSplats,
    index
  }) {
    super({
      inTypes: { extSplats: TExtSplats, index: "int" },
      outTypes: { gsplat: Gsplat },
      inputs: { extSplats, index },
      globals: () => [defineGsplat, defineExtSplats, defineReadExtArrays],
      statements: ({ inputs, outputs }) => {
        const { gsplat } = outputs;
        if (!gsplat) {
          return [`${gsplat}.flags = 0u;`];
        }
        const { extSplats: extSplats2, index: index2 } = inputs;
        if (extSplats2 && index2) {
          return unindentLines(`
            readExtArrays(${extSplats2}.textureArray1, ${extSplats2}.textureArray2, ${extSplats2}.numSplats, ${index2}, ${gsplat});
          `);
        }
        return [`${gsplat}.flags = 0u;`];
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "gsplat");
  }
}
class NumCovSplats extends UnaryOp {
  constructor({ covsplats }) {
    super({ a: covsplats, outKey: "numSplats", outTypeFunc: () => "int" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.numSplats} = ${inputs.a}.numSplats;`
    ];
  }
}
const defineReadCovArrays = unindent(`
  void readCovArrays(usampler2DArray texture1, usampler2DArray texture2, int numSplats, int index, out CovSplat covsplat) {
    covsplat.flags = 0u;
    if ((index >= 0) && (index < numSplats)) {
      ivec3 coord = splatTexCoord(index);
      uvec4 packed1 = texelFetch(texture1, coord, 0);
      uvec4 packed2 = texelFetch(texture2, coord, 0);
      unpackSplatExtCov(packed1, packed2, covsplat.center, covsplat.rgba, covsplat.xxyyzz, covsplat.xyxzyz);
      covsplat.flags = (all(equal(covsplat.xxyyzz, vec3(0.0))) && all(equal(covsplat.xyxzyz, vec3(0.0)))) ? 0u : GSPLAT_FLAG_ACTIVE;
      gsplat.index = index;
    }
  }
`);
class ReadCovSplat extends Dyno {
  constructor({
    covSplats,
    index
  }) {
    super({
      inTypes: { covSplats: TCovSplats, index: "int" },
      outTypes: { covsplat: CovSplat },
      inputs: { covSplats, index },
      globals: () => [defineGsplat, defineCovSplat, defineReadCovArrays],
      statements: ({ inputs, outputs }) => {
        const { covsplat } = outputs;
        if (!covsplat) {
          return [`${covsplat}.flags = 0u;`];
        }
        const { covSplats: covSplats2, index: index2 } = inputs;
        if (covSplats2 && index2) {
          return unindentLines(`
            readCovArrays(${covSplats2}.textureArray, ${covSplats2}.numSplats, ${index2}, ${covsplat});
          `);
        }
        return [`${covsplat}.flags = 0u;`];
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "covsplat");
  }
}
class GsplatToCovSplat extends Dyno {
  constructor({ gsplat }) {
    super({
      inTypes: { gsplat: Gsplat },
      outTypes: { covsplat: CovSplat },
      inputs: { gsplat },
      globals: () => [defineGsplat, defineCovSplat],
      statements: ({ inputs, outputs }) => {
        const { gsplat: gsplat2 } = inputs;
        const { covsplat } = outputs;
        if (!gsplat2) {
          return [`${covsplat}.flags = 0u;`];
        }
        return unindentLines(`
          ${covsplat}.flags = 0u;
          if (isGsplatActive(${gsplat2}.flags)) {
            ${covsplat}.flags = ${gsplat2}.flags;
            ${covsplat}.index = ${gsplat2}.index;
            ${covsplat}.rgba = ${gsplat2}.rgba;
            ${covsplat}.center = ${gsplat2}.center;
            mat3 m = scaleQuaternionToMatrix(${gsplat2}.scales, ${gsplat2}.quaternion);
            m = m * transpose(m);
            ${covsplat}.xxyyzz = vec3(m[0][0], m[1][1], m[2][2]);
            ${covsplat}.xyxzyz = vec3(m[0][1], m[0][2], m[1][2]);
          }
        `);
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "covsplat");
  }
}
class SplitGsplat extends Dyno {
  constructor({ gsplat }) {
    super({
      inTypes: { gsplat: Gsplat },
      outTypes: {
        flags: "uint",
        active: "bool",
        index: "int",
        center: "vec3",
        scales: "vec3",
        quaternion: "vec4",
        rgba: "vec4",
        rgb: "vec3",
        opacity: "float",
        x: "float",
        y: "float",
        z: "float",
        r: "float",
        g: "float",
        b: "float"
      },
      inputs: { gsplat },
      globals: () => [defineGsplat],
      statements: ({ inputs, outputs }) => {
        const { gsplat: gsplat2 } = inputs;
        const {
          flags,
          active,
          index,
          center,
          scales,
          quaternion,
          rgba,
          rgb,
          opacity,
          x,
          y,
          z,
          r,
          g,
          b
        } = outputs;
        return [
          !flags ? null : `${flags} = ${gsplat2 ? `${gsplat2}.flags` : "0u"};`,
          !active ? null : `${active} = isGsplatActive(${gsplat2 ? `${gsplat2}.flags` : "0u"});`,
          !index ? null : `${index} = ${gsplat2 ? `${gsplat2}.index` : "0"};`,
          !center ? null : `${center} = ${gsplat2 ? `${gsplat2}.center` : "vec3(0.0, 0.0, 0.0)"};`,
          !scales ? null : `${scales} = ${gsplat2 ? `${gsplat2}.scales` : "vec3(0.0, 0.0, 0.0)"};`,
          !quaternion ? null : `${quaternion} = ${gsplat2 ? `${gsplat2}.quaternion` : "vec4(0.0, 0.0, 0.0, 1.0)"};`,
          !rgba ? null : `${rgba} = ${gsplat2 ? `${gsplat2}.rgba` : "vec4(0.0, 0.0, 0.0, 0.0)"};`,
          !rgb ? null : `${rgb} = ${gsplat2 ? `${gsplat2}.rgba.rgb` : "vec3(0.0, 0.0, 0.0)"};`,
          !opacity ? null : `${opacity} = ${gsplat2 ? `${gsplat2}.rgba.a` : "0.0"};`,
          !x ? null : `${x} = ${gsplat2 ? `${gsplat2}.center.x` : "0.0"};`,
          !y ? null : `${y} = ${gsplat2 ? `${gsplat2}.center.y` : "0.0"};`,
          !z ? null : `${z} = ${gsplat2 ? `${gsplat2}.center.z` : "0.0"};`,
          !r ? null : `${r} = ${gsplat2 ? `${gsplat2}.rgba.r` : "0.0"};`,
          !g ? null : `${g} = ${gsplat2 ? `${gsplat2}.rgba.g` : "0.0"};`,
          !b ? null : `${b} = ${gsplat2 ? `${gsplat2}.rgba.b` : "0.0"};`
        ].filter(Boolean);
      }
    });
  }
}
class CombineGsplat extends Dyno {
  constructor({
    gsplat,
    flags,
    index,
    center,
    scales,
    quaternion,
    rgba,
    rgb,
    opacity,
    x,
    y,
    z,
    r,
    g,
    b
  }) {
    super({
      inTypes: {
        gsplat: Gsplat,
        flags: "uint",
        index: "int",
        center: "vec3",
        scales: "vec3",
        quaternion: "vec4",
        rgba: "vec4",
        rgb: "vec3",
        opacity: "float",
        x: "float",
        y: "float",
        z: "float",
        r: "float",
        g: "float",
        b: "float"
      },
      outTypes: { gsplat: Gsplat },
      inputs: {
        gsplat,
        flags,
        index,
        center,
        scales,
        quaternion,
        rgba,
        rgb,
        opacity,
        x,
        y,
        z,
        r,
        g,
        b
      },
      globals: () => [defineGsplat],
      statements: ({ inputs, outputs }) => {
        const { gsplat: outGsplat } = outputs;
        if (!outGsplat) {
          return [];
        }
        const {
          gsplat: gsplat2,
          flags: flags2,
          index: index2,
          center: center2,
          scales: scales2,
          quaternion: quaternion2,
          rgba: rgba2,
          rgb: rgb2,
          opacity: opacity2,
          x: x2,
          y: y2,
          z: z2,
          r: r2,
          g: g2,
          b: b2
        } = inputs;
        return [
          `${outGsplat}.flags = ${flags2 ?? (gsplat2 ? `${gsplat2}.flags` : "0u")};`,
          `${outGsplat}.index = ${index2 ?? (gsplat2 ? `${gsplat2}.index` : "0")};`,
          `${outGsplat}.center = ${center2 ?? (gsplat2 ? `${gsplat2}.center` : "vec3(0.0, 0.0, 0.0)")};`,
          `${outGsplat}.scales = ${scales2 ?? (gsplat2 ? `${gsplat2}.scales` : "vec3(0.0, 0.0, 0.0)")};`,
          `${outGsplat}.quaternion = ${quaternion2 ?? (gsplat2 ? `${gsplat2}.quaternion` : "vec4(0.0, 0.0, 0.0, 1.0)")};`,
          `${outGsplat}.rgba = ${rgba2 ?? (gsplat2 ? `${gsplat2}.rgba` : "vec4(0.0, 0.0, 0.0, 0.0)")};`,
          !rgb2 ? null : `${outGsplat}.rgba.rgb = ${rgb2};`,
          !opacity2 ? null : `${outGsplat}.rgba.a = ${opacity2};`,
          !x2 ? null : `${outGsplat}.center.x = ${x2};`,
          !y2 ? null : `${outGsplat}.center.y = ${y2};`,
          !z2 ? null : `${outGsplat}.center.z = ${z2};`,
          !r2 ? null : `${outGsplat}.rgba.r = ${r2};`,
          !g2 ? null : `${outGsplat}.rgba.g = ${g2};`,
          !b2 ? null : `${outGsplat}.rgba.b = ${b2};`
        ].filter(Boolean);
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "gsplat");
  }
}
const defineGsplatNormal = unindent(`
  vec3 gsplatNormal(vec3 scales, vec4 quaternion) {
    float minScale = min(scales.x, min(scales.y, scales.z));
    vec3 normal;
    if (scales.z == minScale) {
      normal = vec3(0.0, 0.0, 1.0);
    } else if (scales.y == minScale) {
      normal = vec3(0.0, 1.0, 0.0);
    } else {
      normal = vec3(1.0, 0.0, 0.0);
    }
    return quatVec(quaternion, normal);
  }
`);
class GsplatNormal extends UnaryOp {
  constructor({ gsplat }) {
    super({ a: gsplat, outKey: "normal", outTypeFunc: () => "vec3" });
    this.globals = () => [defineGsplat, defineGsplatNormal];
    this.statements = ({ inputs, outputs }) => [
      `${outputs.normal} = gsplatNormal(${inputs.a}.scales, ${inputs.a}.quaternion);`
    ];
  }
}
class TransformGsplat extends Dyno {
  constructor({
    gsplat,
    scale,
    rotate,
    translate,
    recolor
  }) {
    super({
      inTypes: {
        gsplat: Gsplat,
        scale: "float",
        rotate: "vec4",
        translate: "vec3",
        recolor: "vec4"
      },
      outTypes: { gsplat: Gsplat },
      inputs: { gsplat, scale, rotate, translate, recolor },
      globals: () => [defineGsplat],
      statements: ({ inputs, outputs, compile }) => {
        const { gsplat: gsplat2 } = outputs;
        if (!gsplat2 || !inputs.gsplat) {
          return [];
        }
        const { scale: scale2, rotate: rotate2, translate: translate2, recolor: recolor2 } = inputs;
        const indent = compile.indent;
        const statements = [
          `${gsplat2} = ${inputs.gsplat};`,
          `if (isGsplatActive(${gsplat2}.flags)) {`,
          scale2 ? `${indent}${gsplat2}.center *= ${scale2};` : null,
          rotate2 ? `${indent}${gsplat2}.center = quatVec(${rotate2}, ${gsplat2}.center);` : null,
          translate2 ? `${indent}${gsplat2}.center += ${translate2};` : null,
          scale2 ? `${indent}${gsplat2}.scales *= ${scale2};` : null,
          rotate2 ? `${indent}${gsplat2}.quaternion = quatQuat(${rotate2}, ${gsplat2}.quaternion);` : null,
          recolor2 ? `${indent}${gsplat2}.rgba *= ${recolor2};` : null,
          "}"
        ].filter(Boolean);
        return statements;
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "gsplat");
  }
}
const splitCovSplat = (covsplat) => new SplitCovSplat({ covsplat });
const combineCovSplat = ({
  covsplat,
  flags,
  index,
  center,
  rgba,
  rgb,
  opacity,
  x,
  y,
  z,
  r,
  g,
  b
}) => {
  return new CombineCovSplat({
    covsplat,
    flags,
    index,
    center,
    rgba,
    rgb,
    opacity,
    x,
    y,
    z,
    r,
    g,
    b
  });
};
class SplitCovSplat extends Dyno {
  constructor({ covsplat }) {
    super({
      inTypes: { covsplat: CovSplat },
      outTypes: {
        flags: "uint",
        active: "bool",
        index: "int",
        center: "vec3",
        rgba: "vec4",
        rgb: "vec3",
        opacity: "float",
        x: "float",
        y: "float",
        z: "float",
        r: "float",
        g: "float",
        b: "float"
      },
      inputs: { covsplat },
      globals: () => [defineCovSplat],
      statements: ({ inputs, outputs }) => {
        const { covsplat: covsplat2 } = inputs;
        const {
          flags,
          active,
          index,
          center,
          rgba,
          rgb,
          opacity,
          x,
          y,
          z,
          r,
          g,
          b
        } = outputs;
        return [
          !flags ? null : `${flags} = ${covsplat2 ? `${covsplat2}.flags` : "0u"};`,
          !active ? null : `${active} = isCovSplatActive(${covsplat2 ? `${covsplat2}.flags` : "0u"});`,
          !index ? null : `${index} = ${covsplat2 ? `${covsplat2}.index` : "0"};`,
          !center ? null : `${center} = ${covsplat2 ? `${covsplat2}.center` : "vec3(0.0, 0.0, 0.0)"};`,
          !rgba ? null : `${rgba} = ${covsplat2 ? `${covsplat2}.rgba` : "vec4(0.0, 0.0, 0.0, 0.0)"};`,
          !rgb ? null : `${rgb} = ${covsplat2 ? `${covsplat2}.rgba.rgb` : "vec3(0.0, 0.0, 0.0)"};`,
          !opacity ? null : `${opacity} = ${covsplat2 ? `${covsplat2}.rgba.a` : "0.0"};`,
          !x ? null : `${x} = ${covsplat2 ? `${covsplat2}.center.x` : "0.0"};`,
          !y ? null : `${y} = ${covsplat2 ? `${covsplat2}.center.y` : "0.0"};`,
          !z ? null : `${z} = ${covsplat2 ? `${covsplat2}.center.z` : "0.0"};`,
          !r ? null : `${r} = ${covsplat2 ? `${covsplat2}.rgba.r` : "0.0"};`,
          !g ? null : `${g} = ${covsplat2 ? `${covsplat2}.rgba.g` : "0.0"};`,
          !b ? null : `${b} = ${covsplat2 ? `${covsplat2}.rgba.b` : "0.0"};`
        ].filter(Boolean);
      }
    });
  }
}
class CombineCovSplat extends Dyno {
  constructor({
    covsplat,
    flags,
    index,
    center,
    rgba,
    rgb,
    opacity,
    x,
    y,
    z,
    r,
    g,
    b
  }) {
    super({
      inTypes: {
        covsplat: CovSplat,
        flags: "uint",
        index: "int",
        center: "vec3",
        rgba: "vec4",
        rgb: "vec3",
        opacity: "float",
        x: "float",
        y: "float",
        z: "float",
        r: "float",
        g: "float",
        b: "float"
      },
      outTypes: { covsplat: CovSplat },
      inputs: {
        covsplat,
        flags,
        index,
        center,
        rgba,
        rgb,
        opacity,
        x,
        y,
        z,
        r,
        g,
        b
      },
      globals: () => [defineCovSplat],
      statements: ({ inputs, outputs }) => {
        const { covsplat: outCovSplat } = outputs;
        if (!outCovSplat) {
          return [];
        }
        const {
          covsplat: covsplat2,
          flags: flags2,
          index: index2,
          center: center2,
          rgba: rgba2,
          rgb: rgb2,
          opacity: opacity2,
          x: x2,
          y: y2,
          z: z2,
          r: r2,
          g: g2,
          b: b2
        } = inputs;
        return [
          `${outCovSplat}.flags = ${flags2 ?? (covsplat2 ? `${covsplat2}.flags` : "0u")};`,
          `${outCovSplat}.index = ${index2 ?? (covsplat2 ? `${covsplat2}.index` : "0")};`,
          `${outCovSplat}.center = ${center2 ?? (covsplat2 ? `${covsplat2}.center` : "vec3(0.0, 0.0, 0.0)")};`,
          `${outCovSplat}.rgba = ${rgba2 ?? (covsplat2 ? `${covsplat2}.rgba` : "vec4(0.0, 0.0, 0.0, 0.0)")};`,
          !rgb2 ? null : `${outCovSplat}.rgba.rgb = ${rgb2};`,
          !opacity2 ? null : `${outCovSplat}.rgba.a = ${opacity2};`,
          !x2 ? null : `${outCovSplat}.center.x = ${x2};`,
          !y2 ? null : `${outCovSplat}.center.y = ${y2};`,
          !z2 ? null : `${outCovSplat}.center.z = ${z2};`,
          !r2 ? null : `${outCovSplat}.rgba.r = ${r2};`,
          !g2 ? null : `${outCovSplat}.rgba.g = ${g2};`,
          !b2 ? null : `${outCovSplat}.rgba.b = ${b2};`,
          `${outCovSplat}.xxyyzz = ${covsplat2 ? `${covsplat2}.xxyyzz` : "vec3(0.0, 0.0, 0.0)"};`,
          `${outCovSplat}.xyxzyz = ${covsplat2 ? `${covsplat2}.xyxzyz` : "vec3(0.0, 0.0, 0.0)"};`
        ].filter(Boolean);
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "covsplat");
  }
}
class SplatTexCoord extends Dyno {
  constructor({ index }) {
    super({
      inTypes: { index: "int" },
      outTypes: { coord: "ivec3" },
      inputs: { index },
      statements: ({ inputs, outputs }) => {
        const { index: index2 } = inputs;
        const { coord } = outputs;
        if (!index2 || !coord) {
          return [];
        }
        return [`${coord} = splatTexCoord(${index2});`];
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "coord");
  }
}
const outputPackedSplat = (gsplat, rgbMinMaxLnScaleMinMax) => new OutputPackedSplat({ gsplat, rgbMinMaxLnScaleMinMax });
const outputCovSplat = (covsplat, rgbMinMaxLnScaleMinMax) => new OutputCovSplat({ covsplat, rgbMinMaxLnScaleMinMax });
const outputExtendedSplat = (gsplat) => new OutputExtendedSplat({ gsplat });
const outputExtCovSplat = (covsplat) => new OutputExtCovSplat({ covsplat });
const outputSplatDepth = (gsplat, viewCenter, viewDir, sortRadial) => new OutputSplatDepth({ gsplat, viewCenter, viewDir, sortRadial });
const outputCovSplatDepth = (covsplat, viewCenter, viewDir, sortRadial) => new OutputCovSplatDepth({ covsplat, viewCenter, viewDir, sortRadial });
const outputRgba8 = (rgba8) => new OutputRgba8({ rgba8 });
class OutputPackedSplat extends Dyno {
  constructor({
    gsplat,
    rgbMinMaxLnScaleMinMax
  }) {
    super({
      inTypes: { gsplat: Gsplat, rgbMinMaxLnScaleMinMax: "vec4" },
      inputs: { gsplat, rgbMinMaxLnScaleMinMax },
      globals: () => [defineGsplat],
      statements: ({ inputs, outputs }) => {
        const { gsplat: gsplat2, rgbMinMaxLnScaleMinMax: rgbMinMaxLnScaleMinMax2 } = inputs;
        if (gsplat2 && rgbMinMaxLnScaleMinMax2) {
          return unindentLines(`
            if (isGsplatActive(${gsplat2}.flags)) {
              target = packSplatEncoding(${gsplat2}.center, ${gsplat2}.scales, ${gsplat2}.quaternion, ${gsplat2}.rgba, ${rgbMinMaxLnScaleMinMax2});
            } else {
              target = uvec4(0u, 0u, 0u, 0u);
            }
          `);
        }
        return ["target = uvec4(0u, 0u, 0u, 0u);"];
      }
    });
  }
}
class OutputCovSplat extends Dyno {
  constructor({
    covsplat,
    rgbMinMaxLnScaleMinMax
  }) {
    super({
      inTypes: { covsplat: CovSplat, rgbMinMaxLnScaleMinMax: "vec4" },
      inputs: { covsplat, rgbMinMaxLnScaleMinMax },
      globals: () => [defineCovSplat],
      statements: ({ inputs }) => {
        const { covsplat: covsplat2, rgbMinMaxLnScaleMinMax: rgbMinMaxLnScaleMinMax2 } = inputs;
        if (covsplat2 && rgbMinMaxLnScaleMinMax2) {
          return unindentLines(`
            if (isCovSplatActive(${covsplat2}.flags)) {
              target = packSplatCovEncoding(${covsplat2}.center, ${covsplat2}.rgba, ${covsplat2}.xxyyzz, ${covsplat2}.xyxzyz, ${rgbMinMaxLnScaleMinMax2});
            } else {
              target = uvec4(0u);
            }
          `);
        }
        return ["target = uvec4(0u);"];
      }
    });
  }
}
class OutputExtendedSplat extends Dyno {
  constructor({
    gsplat
  }) {
    super({
      inTypes: { gsplat: Gsplat },
      inputs: { gsplat },
      globals: () => [defineGsplat],
      statements: ({ inputs }) => {
        const { gsplat: gsplat2 } = inputs;
        if (gsplat2) {
          return unindentLines(`
            if (isGsplatActive(${gsplat2}.flags)) {
              packSplatExt(target, target2, ${gsplat2}.center, ${gsplat2}.scales, ${gsplat2}.quaternion, ${gsplat2}.rgba);
            } else {
              target = uvec4(0u);
              target2 = uvec4(0u);
            }
          `);
        }
        return ["target = uvec4(0u);", "target2 = uvec4(0u);"];
      }
    });
  }
}
class OutputExtCovSplat extends Dyno {
  constructor({
    covsplat
  }) {
    super({
      inTypes: { covsplat: CovSplat },
      inputs: { covsplat },
      globals: () => [defineCovSplat],
      statements: ({ inputs }) => {
        const { covsplat: covsplat2 } = inputs;
        if (covsplat2) {
          return unindentLines(`
            if (isCovSplatActive(${covsplat2}.flags)) {
              packSplatExtCov(target, target2, ${covsplat2}.center, ${covsplat2}.rgba, ${covsplat2}.xxyyzz, ${covsplat2}.xyxzyz);
            } else {
              target = uvec4(0u);
              target2 = uvec4(0u);
            }
          `);
        }
        return ["target = uvec4(0u);", "target2 = uvec4(0u);"];
      }
    });
  }
}
class OutputSplatDepth extends Dyno {
  constructor({
    gsplat,
    viewCenter,
    viewDir,
    sortRadial
  }) {
    super({
      inTypes: {
        gsplat: Gsplat,
        viewCenter: "vec3",
        viewDir: "vec3",
        sortRadial: "bool"
      },
      inputs: { gsplat, viewCenter, viewDir, sortRadial },
      globals: () => [defineGsplat],
      statements: ({ inputs }) => {
        const { gsplat: gsplat2, viewCenter: viewCenter2, viewDir: viewDir2, sortRadial: sortRadial2 } = inputs;
        if (gsplat2 && viewCenter2 && viewDir2 && sortRadial2) {
          return unindentLines(`
            float metric = 1.0 / 0.0;
            if (isGsplatActive(${gsplat2}.flags)) {
              vec3 center = ${gsplat2}.center - ${viewCenter2};
              if (${sortRadial2}) {
                metric = length(center);
              } else {
                float bias = 100.0; // reduce popping
                metric = dot(center, ${viewDir2}) + bias;
              }
            }
            target3 = floatToVec4(metric);
          `);
        }
        return [];
      }
    });
  }
}
class OutputCovSplatDepth extends Dyno {
  constructor({
    covsplat,
    viewCenter,
    viewDir,
    sortRadial
  }) {
    super({
      inTypes: {
        covsplat: CovSplat,
        viewCenter: "vec3",
        viewDir: "vec3",
        sortRadial: "bool"
      },
      inputs: { covsplat, viewCenter, viewDir, sortRadial },
      globals: () => [defineCovSplat],
      statements: ({ inputs }) => {
        const { covsplat: covsplat2, viewCenter: viewCenter2, viewDir: viewDir2, sortRadial: sortRadial2 } = inputs;
        if (covsplat2 && viewCenter2 && viewDir2 && sortRadial2) {
          return unindentLines(`
            float metric = 1.0 / 0.0;
            if (isCovSplatActive(${covsplat2}.flags)) {
              vec3 center = ${covsplat2}.center - ${viewCenter2};
              if (${sortRadial2}) {
                metric = length(center);
              } else {
                float bias = 100.0; // reduce popping
                metric = dot(center, ${viewDir2}) + bias;
              }
            }
            target3 = floatToVec4(metric);
          `);
        }
        return [];
      }
    });
  }
}
class OutputRgba8 extends Dyno {
  constructor({ rgba8 }) {
    super({
      inTypes: { rgba8: "vec4" },
      inputs: { rgba8 },
      statements: ({ inputs, outputs }) => [
        `target = ${inputs.rgba8 ?? "vec4(0.0, 0.0, 0.0, 0.0)"};`
      ]
    });
  }
  dynoOut() {
    return new DynoOutput(this, "rgba8");
  }
}
const uniform = (key, type, value) => new DynoUniform({ key, type, value });
const dynoBool = (value = false, key) => new DynoBool({ key, value });
const dynoUint = (value = 0, key) => new DynoUint({ key, value });
const dynoInt = (value = 0, key) => new DynoInt({ key, value });
const dynoFloat = (value = 0, key) => new DynoFloat({ key, value });
const dynoBvec2 = (value, key) => new DynoBvec2({ key, value });
const dynoUvec2 = (value, key) => new DynoUvec2({ key, value });
const dynoIvec2 = (value, key) => new DynoIvec2({ key, value });
const dynoVec2 = (value, key) => new DynoVec2({ key, value });
const dynoBvec3 = (value, key) => new DynoBvec3({ key, value });
const dynoUvec3 = (value, key) => new DynoUvec3({ key, value });
const dynoIvec3 = (value, key) => new DynoIvec3({ key, value });
const dynoVec3 = (value, key) => new DynoVec3({ key, value });
const dynoBvec4 = (value, key) => new DynoBvec4({ key, value });
const dynoUvec4 = (value, key) => new DynoUvec4({ key, value });
const dynoIvec4 = (value, key) => new DynoIvec4({ key, value });
const dynoVec4 = (value, key) => new DynoVec4({ key, value });
const dynoMat2 = (value, key) => new DynoMat2({ key, value });
const dynoMat2x2 = (value, key) => new DynoMat2x2({ key, value });
const dynoMat2x3 = (value, key) => new DynoMat2x3({ key, value });
const dynoMat2x4 = (value, key) => new DynoMat2x4({ key, value });
const dynoMat3 = (value, key) => new DynoMat3({ key, value });
const dynoMat3x2 = (value, key) => new DynoMat3x2({ key, value });
const dynoMat3x3 = (value, key) => new DynoMat3x3({ key, value });
const dynoMat3x4 = (value, key) => new DynoMat3x4({ key, value });
const dynoMat4 = (value, key) => new DynoMat4({ key, value });
const dynoMat4x2 = (value, key) => new DynoMat4x2({ key, value });
const dynoMat4x3 = (value, key) => new DynoMat4x3({ key, value });
const dynoMat4x4 = (value, key) => new DynoMat4x4({ key, value });
const dynoUsampler2D = (value, key) => new DynoUsampler2D({ key, value });
const dynoIsampler2D = (value, key) => new DynoIsampler2D({ key, value });
const dynoSampler2D = (value, key) => new DynoSampler2D({ key, value });
const dynoUsampler2DArray = (value, key) => new DynoUsampler2DArray({ key, value });
const dynoIsampler2DArray = (key, value) => new DynoIsampler2DArray({ key, value });
const dynoSampler2DArray = (value, key) => new DynoSampler2DArray({ key, value });
const dynoUsampler3D = (value, key) => new DynoUsampler3D({ key, value });
const dynoIsampler3D = (value, key) => new DynoIsampler3D({ key, value });
const dynoSampler3D = (value, key) => new DynoSampler3D({ key, value });
const dynoUsamplerCube = (value, key) => new DynoUsamplerCube({ key, value });
const dynoIsamplerCube = (value, key) => new DynoIsamplerCube({ key, value });
const dynoSamplerCube = (value, key) => new DynoSamplerCube({ key, value });
const dynoSampler2DShadow = (value, key) => new DynoSampler2DShadow({ key, value });
const dynoSampler2DArrayShadow = (value, key) => new DynoSampler2DArrayShadow({ key, value });
const dynoSamplerCubeShadow = (value, key) => new DynoSamplerCubeShadow({ key, value });
class DynoUniform extends Dyno {
  constructor({
    key,
    type,
    count,
    value,
    update,
    globals
  }) {
    key = key ?? "value";
    super({
      outTypes: { [key]: type },
      update: () => {
        if (update) {
          const value2 = update(this.value);
          if (value2 !== void 0) {
            this.value = value2;
          }
        }
        this.uniform.value = this.value;
      },
      generate: ({ inputs, outputs }) => {
        const allGlobals = (globals == null ? void 0 : globals({ inputs, outputs })) ?? [];
        const uniforms = {};
        const name = outputs[key];
        if (name) {
          allGlobals.push(`uniform ${dynoDeclare(name, type, count)};`);
          uniforms[name] = this.uniform;
        }
        return { globals: allGlobals, uniforms };
      }
    });
    this.type = type;
    this.count = count;
    this.value = value;
    this.uniform = { value };
    this.outKey = key;
  }
  dynoOut() {
    return new DynoOutput(this, this.outKey);
  }
}
class DynoBool extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "bool", value, update });
  }
}
class DynoUint extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "uint", value, update });
  }
}
class DynoInt extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "int", value, update });
  }
}
class DynoFloat extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "float", value, update });
  }
}
class DynoBvec2 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "bvec2", value, update });
  }
}
class DynoUvec2 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "uvec2", value, update });
  }
}
class DynoIvec2 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "ivec2", value, update });
  }
}
class DynoVec2 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "vec2", value, update });
  }
}
class DynoBvec3 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "bvec3", value, update });
  }
}
class DynoUvec3 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "uvec3", value, update });
  }
}
class DynoIvec3 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "ivec3", value, update });
  }
}
class DynoVec3 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "vec3", value, update });
  }
}
class DynoBvec4 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "bvec4", value, update });
  }
}
class DynoUvec4 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "uvec4", value, update });
  }
}
class DynoIvec4 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "ivec4", value, update });
  }
}
class DynoVec4 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "vec4", value, update });
  }
}
class DynoMat2 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat2", value, update });
  }
}
class DynoMat2x2 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat2x2", value, update });
  }
}
class DynoMat2x3 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat2x3", value, update });
  }
}
class DynoMat2x4 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat2x4", value, update });
  }
}
class DynoMat3 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat3", value, update });
  }
}
class DynoMat3x2 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat3x2", value, update });
  }
}
class DynoMat3x3 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat3x3", value, update });
  }
}
class DynoMat3x4 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat3x4", value, update });
  }
}
class DynoMat4 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat4", value, update });
  }
}
class DynoMat4x2 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat4x2", value, update });
  }
}
class DynoMat4x3 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat4x3", value, update });
  }
}
class DynoMat4x4 extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "mat4x4", value, update });
  }
}
class DynoUsampler2D extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "usampler2D", value, update });
  }
}
class DynoIsampler2D extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "isampler2D", value, update });
  }
}
class DynoSampler2D extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "sampler2D", value, update });
  }
}
class DynoUsampler2DArray extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "usampler2DArray", value, update });
  }
}
class DynoIsampler2DArray extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "isampler2DArray", value, update });
  }
}
class DynoSampler2DArray extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "sampler2DArray", value, update });
  }
}
class DynoUsampler3D extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "usampler3D", value, update });
  }
}
class DynoIsampler3D extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "isampler3D", value, update });
  }
}
class DynoSampler3D extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "sampler3D", value, update });
  }
}
class DynoUsamplerCube extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "usamplerCube", value, update });
  }
}
class DynoIsamplerCube extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "isamplerCube", value, update });
  }
}
class DynoSamplerCube extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "samplerCube", value, update });
  }
}
class DynoSampler2DShadow extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "sampler2DShadow", value, update });
  }
}
class DynoSampler2DArrayShadow extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "sampler2DArrayShadow", value, update });
  }
}
class DynoSamplerCubeShadow extends DynoUniform {
  constructor({
    key,
    value,
    update
  }) {
    super({ key, type: "samplerCubeShadow", value, update });
  }
}
const threeRevision = Number.parseInt(THREE__namespace.REVISION);
const threeMrtArray = threeRevision >= 179;
const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);
const supportsFloat16Array = "Float16Array" in globalThis;
const f16buffer = supportsFloat16Array ? new globalThis["Float16Array"](1) : null;
const u16buffer = new Uint16Array(f16buffer == null ? void 0 : f16buffer.buffer);
function normalize$1(vec) {
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  return vec.map((v) => v / norm);
}
function floatBitsToUint$1(f) {
  f32buffer[0] = f;
  return u32buffer[0];
}
function uintBitsToFloat$1(u) {
  u32buffer[0] = u;
  return f32buffer[0];
}
const toHalf = supportsFloat16Array ? toHalfNative : toHalfJS;
const fromHalf = supportsFloat16Array ? fromHalfNative : fromHalfJS;
function toHalfNative(f) {
  f16buffer[0] = f;
  return u16buffer[0];
}
function toHalfJS(f) {
  f32buffer[0] = f;
  const bits = u32buffer[0];
  const sign2 = bits >> 31 & 1;
  const exp3 = bits >> 23 & 255;
  const frac = bits & 8388607;
  const halfSign = sign2 << 15;
  if (exp3 === 255) {
    if (frac !== 0) {
      return halfSign | 32767;
    }
    return halfSign | 31744;
  }
  const newExp = exp3 - 127 + 15;
  if (newExp >= 31) {
    return halfSign | 31744;
  }
  if (newExp <= 0) {
    if (newExp < -10) {
      return halfSign;
    }
    const subFrac = (frac | 8388608) >> 1 - newExp + 13;
    return halfSign | subFrac;
  }
  const halfFrac = frac >> 13;
  return halfSign | newExp << 10 | halfFrac;
}
function fromHalfNative(u) {
  u16buffer[0] = u;
  return f16buffer[0];
}
function fromHalfJS(h) {
  const sign2 = h >> 15 & 1;
  const exp3 = h >> 10 & 31;
  const frac = h & 1023;
  let f32bits;
  if (exp3 === 0) {
    if (frac === 0) {
      f32bits = sign2 << 31;
    } else {
      let mant = frac;
      let e = -14;
      while ((mant & 1024) === 0) {
        mant <<= 1;
        e--;
      }
      mant &= 1023;
      const newExp = e + 127;
      const newFrac = mant << 13;
      f32bits = sign2 << 31 | newExp << 23 | newFrac;
    }
  } else if (exp3 === 31) {
    if (frac === 0) {
      f32bits = sign2 << 31 | 2139095040;
    } else {
      f32bits = sign2 << 31 | 2143289344;
    }
  } else {
    const newExp = exp3 - 15 + 127;
    const newFrac = frac << 13;
    f32bits = sign2 << 31 | newExp << 23 | newFrac;
  }
  u32buffer[0] = f32bits;
  return f32buffer[0];
}
function floatToUint8(v) {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
function floatToSint8(v) {
  return Math.max(-127, Math.min(127, Math.round(v * 127)));
}
function Uint8ToFloat(v) {
  return v / 255;
}
function Sint8ToFloat(v) {
  return v / 127;
}
class DataCache {
  // Create a DataCache with a given function that fetches data not in the cache.
  constructor({
    asyncFetch,
    dispose,
    maxItems = 5
  }) {
    this.asyncFetch = asyncFetch;
    this.dispose = dispose;
    this.maxItems = maxItems;
    this.items = [];
    this.pending = /* @__PURE__ */ new Map();
  }
  has(key) {
    return this.items.some((item) => item.key === key);
  }
  getImmediate(key) {
    const index = this.items.findIndex((item) => item.key === key);
    if (index >= 0) {
      const item = this.items.splice(index, 1)[0];
      this.items.push(item);
      return item.data;
    }
    return void 0;
  }
  // Fetch data for the key, returning cached data if available.
  async getFetch(key) {
    const immediate = this.getImmediate(key);
    if (immediate !== void 0) {
      return immediate;
    }
    let pending = this.pending.get(key);
    if (pending) {
      return pending;
    }
    pending = this.asyncFetch(key).then((data) => {
      this.pending.delete(key);
      this.items.push({ key, data });
      while (this.items.length > this.maxItems) {
        const removed = this.items.shift();
        if (removed && this.dispose) {
          this.dispose(removed.data);
        }
      }
      return data;
    });
    this.pending.set(key, pending);
    return pending;
  }
}
function mapObject(obj, fn) {
  const entries = Object.entries(obj).map(([key, value]) => [
    key,
    fn(value, key)
  ]);
  return Object.fromEntries(entries);
}
function mapFilterObject(obj, fn) {
  const entries = Object.entries(obj).map(([key, value]) => [key, fn(value, key)]).filter(([_, value]) => value !== void 0);
  return Object.fromEntries(entries);
}
function getTransferable(ctx) {
  const buffers = [];
  const seen = /* @__PURE__ */ new Set();
  function traverse(obj) {
    if (obj && typeof obj === "object" && !seen.has(obj)) {
      seen.add(obj);
      if (obj instanceof ArrayBuffer) {
        buffers.push(obj);
      } else if (ArrayBuffer.isView(obj)) {
        buffers.push(obj.buffer);
      } else if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else {
        Object.values(obj).forEach(traverse);
      }
    }
  }
  traverse(ctx);
  return buffers;
}
function newArray(n, initFunction) {
  return new Array(n).fill(null).map((_, i) => initFunction(i));
}
class FreeList {
  constructor({
    // Allocate a new item with the given args
    allocate,
    // Dispose of an item (optional, if GC is enough)
    dispose,
    // Check if an existing item in the list is valid for the given args,
    // allowing you to store heterogeneous items in the list.
    valid
  }) {
    this.items = [];
    this.allocate = allocate;
    this.dispose = dispose;
    this.valid = valid;
  }
  // Allocate a new item from the free list, first checking if a existing item
  // on the freelist is valid for the given args.
  alloc(args) {
    while (true) {
      const item = this.items.pop();
      if (!item) {
        break;
      }
      if (this.valid(item, args)) {
        return item;
      }
      if (this.dispose) {
        this.dispose(item);
      }
    }
    return this.allocate(args);
  }
  free(item) {
    this.items.push(item);
  }
  disposeAll() {
    let item;
    item = this.items.pop();
    while (item) {
      if (this.dispose) {
        this.dispose(item);
      }
      item = this.items.pop();
    }
  }
}
function encodeExtSplat(extArrays, index, x, y, z, scaleX, scaleY, scaleZ, quatX, quatY, quatZ, quatW, opacity, r, g, b) {
  const i4 = index * 4;
  const [extA, extB] = extArrays;
  extA[i4] = floatBitsToUint$1(x);
  extA[i4 + 1] = floatBitsToUint$1(y);
  extA[i4 + 2] = floatBitsToUint$1(z);
  extA[i4 + 3] = toHalf(opacity);
  extB[i4] = toHalf(r) | toHalf(g) << 16;
  extB[i4 + 1] = toHalf(b) | toHalf(Math.log(scaleX)) << 16;
  extB[i4 + 2] = toHalf(Math.log(scaleY)) | toHalf(Math.log(scaleZ)) << 16;
  extB[i4 + 3] = encodeQuatOctXy1010R12(quatX, quatY, quatZ, quatW);
}
function decodeExtSplat(extArrays, index) {
  const result = packedFields;
  const i4 = index * 4;
  const [extA, extB] = extArrays;
  result.center.x = uintBitsToFloat$1(extA[i4]);
  result.center.y = uintBitsToFloat$1(extA[i4 + 1]);
  result.center.z = uintBitsToFloat$1(extA[i4 + 2]);
  result.opacity = fromHalf(extA[i4 + 3] & 65535);
  result.color.r = fromHalf(extB[i4] & 65535);
  result.color.g = fromHalf(extB[i4] >>> 16);
  result.color.b = fromHalf(extB[i4 + 1] & 65535);
  result.scales.x = Math.exp(fromHalf(extB[i4 + 1] >>> 16));
  result.scales.y = Math.exp(fromHalf(extB[i4 + 2] & 65535));
  result.scales.z = Math.exp(fromHalf(extB[i4 + 2] >>> 16));
  decodeQuatOctXy1010R12(extB[i4 + 3], result.quaternion);
  return result;
}
function setPackedSplat(packedSplats, index, x, y, z, scaleX, scaleY, scaleZ, quatX, quatY, quatZ, quatW, opacity, r, g, b, encoding) {
  const rgbMin = (encoding == null ? void 0 : encoding.rgbMin) ?? 0;
  const rgbMax = (encoding == null ? void 0 : encoding.rgbMax) ?? 1;
  const rgbRange = rgbMax - rgbMin;
  const uR = floatToUint8((r - rgbMin) / rgbRange);
  const uG = floatToUint8((g - rgbMin) / rgbRange);
  const uB = floatToUint8((b - rgbMin) / rgbRange);
  const uA = floatToUint8(opacity);
  const uQuat = encodeQuatOctXy88R8(
    tempQuaternion.set(quatX, quatY, quatZ, quatW)
  );
  const uQuatX = uQuat & 255;
  const uQuatY = uQuat >>> 8 & 255;
  const uQuatZ = uQuat >>> 16 & 255;
  const lnScaleMin = (encoding == null ? void 0 : encoding.lnScaleMin) ?? LN_SCALE_MIN;
  const lnScaleMax = (encoding == null ? void 0 : encoding.lnScaleMax) ?? LN_SCALE_MAX;
  const lnScaleScale = 254 / (lnScaleMax - lnScaleMin);
  const uScaleX = scaleX < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleX) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const uScaleY = scaleY < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleY) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const uScaleZ = scaleZ < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleZ) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const uCenterX = toHalf(x);
  const uCenterY = toHalf(y);
  const uCenterZ = toHalf(z);
  const i4 = index * 4;
  packedSplats[i4] = uR | uG << 8 | uB << 16 | uA << 24;
  packedSplats[i4 + 1] = uCenterX | uCenterY << 16;
  packedSplats[i4 + 2] = uCenterZ | uQuatX << 16 | uQuatY << 24;
  packedSplats[i4 + 3] = uScaleX | uScaleY << 8 | uScaleZ << 16 | uQuatZ << 24;
}
function setPackedSplatCenter(packedSplats, index, x, y, z) {
  const uCenterX = toHalf(x);
  const uCenterY = toHalf(y);
  const uCenterZ = toHalf(z);
  const i4 = index * 4;
  packedSplats[i4 + 1] = uCenterX | uCenterY << 16;
  packedSplats[i4 + 2] = uCenterZ | packedSplats[i4 + 2] & 4294901760;
}
function setPackedSplatScales(packedSplats, index, scaleX, scaleY, scaleZ, encoding) {
  const lnScaleMin = (encoding == null ? void 0 : encoding.lnScaleMin) ?? LN_SCALE_MIN;
  const lnScaleMax = (encoding == null ? void 0 : encoding.lnScaleMax) ?? LN_SCALE_MAX;
  const lnScaleScale = 254 / (lnScaleMax - lnScaleMin);
  const uScaleX = scaleX < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleX) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const uScaleY = scaleY < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleY) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const uScaleZ = scaleZ < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleZ) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const i4 = index * 4;
  packedSplats[i4 + 3] = uScaleX | uScaleY << 8 | uScaleZ << 16 | packedSplats[i4 + 3] & 4278190080;
}
const tempQuaternion = new THREE__namespace.Quaternion();
function setPackedSplatQuat(packedSplats, index, quatX, quatY, quatZ, quatW) {
  const uQuat = encodeQuatOctXy88R8(
    tempQuaternion.set(quatX, quatY, quatZ, quatW)
  );
  const uQuatX = uQuat & 255;
  const uQuatY = uQuat >>> 8 & 255;
  const uQuatZ = uQuat >>> 16 & 255;
  const i4 = index * 4;
  packedSplats[i4 + 2] = packedSplats[i4 + 2] & 65535 | uQuatX << 16 | uQuatY << 24;
  packedSplats[i4 + 3] = packedSplats[i4 + 3] & 16777215 | uQuatZ << 24;
}
function setPackedSplatRgba(packedSplats, index, r, g, b, a, encoding) {
  const rgbMin = (encoding == null ? void 0 : encoding.rgbMin) ?? 0;
  const rgbMax = (encoding == null ? void 0 : encoding.rgbMax) ?? 1;
  const rgbRange = rgbMax - rgbMin;
  const uR = floatToUint8((r - rgbMin) / rgbRange);
  const uG = floatToUint8((g - rgbMin) / rgbRange);
  const uB = floatToUint8((b - rgbMin) / rgbRange);
  const uA = floatToUint8(a);
  const i4 = index * 4;
  packedSplats[i4] = uR | uG << 8 | uB << 16 | uA << 24;
}
function setPackedSplatRgb(packedSplats, index, r, g, b, encoding) {
  const rgbMin = (encoding == null ? void 0 : encoding.rgbMin) ?? 0;
  const rgbMax = (encoding == null ? void 0 : encoding.rgbMax) ?? 1;
  const rgbRange = rgbMax - rgbMin;
  const uR = floatToUint8((r - rgbMin) / rgbRange);
  const uG = floatToUint8((g - rgbMin) / rgbRange);
  const uB = floatToUint8((b - rgbMin) / rgbRange);
  const i4 = index * 4;
  packedSplats[i4] = uR | uG << 8 | uB << 16 | packedSplats[i4] & 4278190080;
}
function setPackedSplatOpacity(packedSplats, index, opacity) {
  const uA = floatToUint8(opacity);
  const i4 = index * 4;
  packedSplats[i4] = packedSplats[i4] & 16777215 | uA << 24;
}
const packedCenter = new THREE__namespace.Vector3();
const packedScales = new THREE__namespace.Vector3();
const packedQuaternion = new THREE__namespace.Quaternion();
const packedColor = new THREE__namespace.Color();
const packedFields = {
  center: packedCenter,
  scales: packedScales,
  quaternion: packedQuaternion,
  color: packedColor,
  opacity: 0
};
function unpackSplat(packedSplats, index, encoding) {
  const result = packedFields;
  const i4 = index * 4;
  const word0 = packedSplats[i4];
  const word1 = packedSplats[i4 + 1];
  const word2 = packedSplats[i4 + 2];
  const word3 = packedSplats[i4 + 3];
  const rgbMin = (encoding == null ? void 0 : encoding.rgbMin) ?? 0;
  const rgbMax = (encoding == null ? void 0 : encoding.rgbMax) ?? 1;
  const rgbRange = rgbMax - rgbMin;
  result.color.set(
    rgbMin + (word0 & 255) / 255 * rgbRange,
    rgbMin + (word0 >>> 8 & 255) / 255 * rgbRange,
    rgbMin + (word0 >>> 16 & 255) / 255 * rgbRange
  );
  result.opacity = (word0 >>> 24 & 255) / 255;
  result.center.set(
    fromHalf(word1 & 65535),
    fromHalf(word1 >>> 16 & 65535),
    fromHalf(word2 & 65535)
  );
  const lnScaleMin = (encoding == null ? void 0 : encoding.lnScaleMin) ?? LN_SCALE_MIN;
  const lnScaleMax = (encoding == null ? void 0 : encoding.lnScaleMax) ?? LN_SCALE_MAX;
  const lnScaleScale = (lnScaleMax - lnScaleMin) / 254;
  const uScalesX = word3 & 255;
  result.scales.x = uScalesX === 0 ? 0 : Math.exp(lnScaleMin + (uScalesX - 1) * lnScaleScale);
  const uScalesY = word3 >>> 8 & 255;
  result.scales.y = uScalesY === 0 ? 0 : Math.exp(lnScaleMin + (uScalesY - 1) * lnScaleScale);
  const uScalesZ = word3 >>> 16 & 255;
  result.scales.z = uScalesZ === 0 ? 0 : Math.exp(lnScaleMin + (uScalesZ - 1) * lnScaleScale);
  const uQuat = word2 >>> 16 & 65535 | word3 >>> 8 & 16711680;
  decodeQuatOctXy88R8(uQuat, result.quaternion);
  return result;
}
function getTextureSize(numSplats) {
  const width = SPLAT_TEX_WIDTH;
  const height = Math.max(
    SPLAT_TEX_MIN_HEIGHT,
    Math.min(SPLAT_TEX_HEIGHT, Math.ceil(numSplats / width))
  );
  const depth = Math.ceil(numSplats / (width * height));
  const maxSplats = width * height * depth;
  return { width, height, depth, maxSplats };
}
function computeMaxSplats(numSplats) {
  const width = SPLAT_TEX_WIDTH;
  const height = Math.max(
    SPLAT_TEX_MIN_HEIGHT,
    Math.min(SPLAT_TEX_HEIGHT, Math.ceil(numSplats / width))
  );
  const depth = Math.ceil(numSplats / (width * height));
  return width * height * depth;
}
function isMobile() {
  if (navigator.platform.toLowerCase().startsWith("win")) {
    return false;
  }
  if (navigator.maxTouchPoints > 0) {
    return true;
  }
  return /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile/.test(
    navigator.userAgent
  );
}
function isAndroid() {
  return /Android/.test(navigator.userAgent) || /Tizen/.test(navigator.userAgent);
}
function isOculus() {
  return !!navigator.xr && /Oculus/.test(navigator.userAgent);
}
function isQuest2() {
  return isOculus() && /Quest 2/.test(navigator.userAgent);
}
function isIos() {
  return /iPhone|iPad/.test(navigator.userAgent);
}
function isVisionPro() {
  return !!navigator.xr && isIos() && /Safari/.test(navigator.userAgent) && isMobile();
}
function flipPixels(pixels, width, height) {
  const tempLine = new Uint8Array(width * 4);
  for (let y = 0; y < height / 2; y++) {
    const topOffset = y * width * 4;
    const bottomOffset = (height - 1 - y) * width * 4;
    tempLine.set(pixels.subarray(topOffset, topOffset + width * 4));
    pixels.set(
      pixels.subarray(bottomOffset, bottomOffset + width * 4),
      topOffset
    );
    pixels.set(tempLine, bottomOffset);
  }
  return pixels;
}
function pixelsToPngUrl(pixels, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Can't get 2d context");
  }
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}
function cloneClock(clock) {
  const newClock = new THREE__namespace.Clock(clock.autoStart);
  newClock.startTime = clock.startTime;
  newClock.oldTime = clock.oldTime;
  newClock.elapsedTime = clock.elapsedTime;
  newClock.running = clock.running;
  return newClock;
}
function omitUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) => value !== void 0)
  );
}
const IDENT_VERTEX_SHADER = unindent(`
  precision highp float;

  in vec3 position;

  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`);
function averagePositions(positions) {
  const sum = new THREE__namespace.Vector3();
  for (const position of positions) {
    sum.add(position);
  }
  return sum.divideScalar(positions.length);
}
function averageQuaternions(quaternions) {
  if (quaternions.length === 0) {
    return new THREE__namespace.Quaternion();
  }
  const sum = quaternions[0].clone();
  for (let i = 1; i < quaternions.length; i++) {
    if (quaternions[i].dot(quaternions[0]) < 0) {
      sum.x -= quaternions[i].x;
      sum.y -= quaternions[i].y;
      sum.z -= quaternions[i].z;
      sum.w -= quaternions[i].w;
    } else {
      sum.x += quaternions[i].x;
      sum.y += quaternions[i].y;
      sum.z += quaternions[i].z;
      sum.w += quaternions[i].w;
    }
  }
  return sum.normalize();
}
function coinciDist(matrix1, matrix2) {
  const origin1 = new THREE__namespace.Vector3(0, 0, 0).applyMatrix4(matrix1);
  const origin2 = new THREE__namespace.Vector3(0, 0, 0).applyMatrix4(matrix2);
  const direction1 = new THREE__namespace.Vector3(0, 0, -1).applyMatrix4(matrix1).sub(origin1).normalize();
  const direction2 = new THREE__namespace.Vector3(0, 0, -1).applyMatrix4(matrix2).sub(origin2).normalize();
  const distance2 = origin1.distanceTo(origin2);
  const coincidence = direction1.dot(direction2);
  return { distance: distance2, coincidence };
}
function withinDist({
  matrix1,
  matrix2,
  maxDistance
}) {
  const origin1 = new THREE__namespace.Vector3(0, 0, 0).applyMatrix4(matrix1);
  const origin2 = new THREE__namespace.Vector3(0, 0, 0).applyMatrix4(matrix2);
  return origin1.distanceTo(origin2) <= maxDistance;
}
function withinCoinciDist({
  matrix1,
  matrix2,
  maxDistance,
  minCoincidence
}) {
  const { distance: distance2, coincidence } = coinciDist(matrix1, matrix2);
  return distance2 <= maxDistance && (minCoincidence == null || coincidence >= minCoincidence);
}
function coorientDist(matrix1, matrix2) {
  const [origin1, rotate1] = [new THREE__namespace.Vector3(), new THREE__namespace.Quaternion()];
  const [origin2, rotate2] = [new THREE__namespace.Vector3(), new THREE__namespace.Quaternion()];
  matrix1.decompose(origin1, rotate1, new THREE__namespace.Vector3());
  matrix2.decompose(origin2, rotate2, new THREE__namespace.Vector3());
  const distance2 = origin1.distanceTo(origin2);
  const coorient = Math.abs(rotate1.dot(rotate2));
  return { distance: distance2, coorient };
}
function withinCoorientDist({
  matrix1,
  matrix2,
  maxDistance,
  minCoorient
}) {
  const { distance: distance2, coorient } = coorientDist(matrix1, matrix2);
  return distance2 <= maxDistance && (minCoorient == null || coorient >= minCoorient);
}
function epsilonSign(value, epsilon = 1e-3) {
  if (Math.abs(value) < epsilon) {
    return 0;
  }
  return Math.sign(value);
}
function encodeQuatXyz888(q) {
  const negQuat = q.w < 0;
  const iQuatX = floatToSint8(negQuat ? -q.x : q.x);
  const iQuatY = floatToSint8(negQuat ? -q.y : q.y);
  const iQuatZ = floatToSint8(negQuat ? -q.z : q.z);
  const uQuatX = iQuatX & 255;
  const uQuatY = iQuatY & 255;
  const uQuatZ = iQuatZ & 255;
  return uQuatX | uQuatY << 8 | uQuatZ << 16;
}
function decodeQuatXyz888(encoded, out) {
  const iQuatX = encoded << 24 >> 24;
  const iQuatY = encoded << 16 >> 24;
  const iQuatZ = encoded << 8 >> 24;
  out.set(iQuatX / 127, iQuatY / 127, iQuatZ / 127, 0);
  const dotSelf = out.x * out.x + out.y * out.y + out.z * out.z;
  out.w = Math.sqrt(Math.max(0, 1 - dotSelf));
  return out;
}
const tempNormalizedQuaternion = new THREE__namespace.Quaternion();
const tempAxis = new THREE__namespace.Vector3();
function encodeQuatOctXy88R8(q) {
  const qnorm = tempNormalizedQuaternion.copy(q).normalize();
  if (qnorm.w < 0) {
    qnorm.set(-qnorm.x, -qnorm.y, -qnorm.z, -qnorm.w);
  }
  const theta = 2 * Math.acos(qnorm.w);
  const xyz_norm = Math.sqrt(
    qnorm.x * qnorm.x + qnorm.y * qnorm.y + qnorm.z * qnorm.z
  );
  const axis = xyz_norm < 1e-6 ? tempAxis.set(1, 0, 0) : tempAxis.set(qnorm.x, qnorm.y, qnorm.z).divideScalar(xyz_norm);
  const sum = Math.abs(axis.x) + Math.abs(axis.y) + Math.abs(axis.z);
  let p_x = axis.x / sum;
  let p_y = axis.y / sum;
  if (axis.z < 0) {
    const tmp = p_x;
    p_x = (1 - Math.abs(p_y)) * (p_x >= 0 ? 1 : -1);
    p_y = (1 - Math.abs(tmp)) * (p_y >= 0 ? 1 : -1);
  }
  const u_f = p_x * 0.5 + 0.5;
  const v_f = p_y * 0.5 + 0.5;
  const quantU = Math.round(u_f * 255);
  const quantV = Math.round(v_f * 255);
  const angleInt = Math.round(theta * (255 / Math.PI));
  return angleInt << 16 | quantV << 8 | quantU;
}
function decodeQuatOctXy88R8(encoded, out) {
  const quantU = encoded & 255;
  const quantV = encoded >>> 8 & 255;
  const angleInt = encoded >>> 16 & 255;
  const u_f = quantU / 255;
  const v_f = quantV / 255;
  let f_x = (u_f - 0.5) * 2;
  let f_y = (v_f - 0.5) * 2;
  const f_z = 1 - (Math.abs(f_x) + Math.abs(f_y));
  const t = Math.max(-f_z, 0);
  f_x += f_x >= 0 ? -t : t;
  f_y += f_y >= 0 ? -t : t;
  const axis = tempAxis.set(f_x, f_y, f_z).normalize();
  const theta = angleInt / 255 * Math.PI;
  const halfTheta = theta * 0.5;
  const s = Math.sin(halfTheta);
  const w = Math.cos(halfTheta);
  out.set(axis.x * s, axis.y * s, axis.z * s, w);
  return out;
}
function encodeQuatEulerXyz888(q) {
  const qNorm = q.clone().normalize();
  const sinr_cosp = 2 * (qNorm.w * qNorm.x + qNorm.y * qNorm.z);
  const cosr_cosp = 1 - 2 * (qNorm.x * qNorm.x + qNorm.y * qNorm.y);
  const roll = Math.atan2(sinr_cosp, cosr_cosp);
  const sinp = 2 * (qNorm.w * qNorm.y - qNorm.z * qNorm.x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const siny_cosp = 2 * (qNorm.w * qNorm.z + qNorm.x * qNorm.y);
  const cosy_cosp = 1 - 2 * (qNorm.y * qNorm.y + qNorm.z * qNorm.z);
  const yaw = Math.atan2(siny_cosp, cosy_cosp);
  const normRoll = (roll + Math.PI) / (2 * Math.PI);
  const normPitch = (pitch + Math.PI) / (2 * Math.PI);
  const normYaw = (yaw + Math.PI) / (2 * Math.PI);
  const rollQ = Math.round(normRoll * 255);
  const pitchQ = Math.round(normPitch * 255);
  const yawQ = Math.round(normYaw * 255);
  return yawQ << 16 | pitchQ << 8 | rollQ;
}
function decodeQuatEulerXyz888(encoded, out) {
  const rollQ = encoded & 255;
  const pitchQ = encoded >>> 8 & 255;
  const yawQ = encoded >>> 16 & 255;
  const normRoll = rollQ / 255;
  const normPitch = pitchQ / 255;
  const normYaw = yawQ / 255;
  const roll = normRoll * (2 * Math.PI) - Math.PI;
  const pitch = normPitch * (2 * Math.PI) - Math.PI;
  const yaw = normYaw * (2 * Math.PI) - Math.PI;
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  out.w = cr * cp * cy + sr * sp * sy;
  out.x = sr * cp * cy - cr * sp * sy;
  out.y = cr * sp * cy + sr * cp * sy;
  out.z = cr * cp * sy - sr * sp * cy;
  out.normalize();
  return out;
}
function encodeQuatOctXy1010R12(qx, qy, qz, qw) {
  const qlen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  const qnx = (qw < 0 ? -qx : qx) / qlen;
  const qny = (qw < 0 ? -qy : qy) / qlen;
  const qnz = (qw < 0 ? -qz : qz) / qlen;
  const qnw = (qw < 0 ? -qw : qw) / qlen;
  const theta = 2 * Math.acos(qnw);
  const xyz_norm = Math.sqrt(qnx * qnx + qny * qny + qnz * qnz);
  const axisX = xyz_norm < 1e-6 ? 1 : qnx / xyz_norm;
  const axisY = xyz_norm < 1e-6 ? 0 : qny / xyz_norm;
  const axisZ = xyz_norm < 1e-6 ? 0 : qnz / xyz_norm;
  const sum = Math.abs(axisX) + Math.abs(axisY) + Math.abs(axisZ);
  let p_x = axisX / sum;
  let p_y = axisY / sum;
  if (axisZ < 0) {
    const tmp = p_x;
    p_x = (1 - Math.abs(p_y)) * (p_x >= 0 ? 1 : -1);
    p_y = (1 - Math.abs(tmp)) * (p_y >= 0 ? 1 : -1);
  }
  const u_f = p_x * 0.5 + 0.5;
  const v_f = p_y * 0.5 + 0.5;
  const quantU = Math.round(u_f * 1023);
  const quantV = Math.round(v_f * 1023);
  const angleInt = Math.round(theta * (4095 / Math.PI));
  return angleInt << 20 | quantV << 10 | quantU;
}
function decodeQuatOctXy1010R12(encoded, out) {
  const quantU = encoded & 1023;
  const quantV = encoded >>> 10 & 1023;
  const angleInt = encoded >>> 20 & 4095;
  const u_f = quantU / 1023;
  const v_f = quantV / 1023;
  let f_x = (u_f - 0.5) * 2;
  let f_y = (v_f - 0.5) * 2;
  const f_z = 1 - (Math.abs(f_x) + Math.abs(f_y));
  const t = Math.max(-f_z, 0);
  f_x += f_x >= 0 ? -t : t;
  f_y += f_y >= 0 ? -t : t;
  const axisLen = Math.sqrt(f_x * f_x + f_y * f_y + f_z * f_z);
  const axisX = axisLen < 1e-6 ? 0 : f_x / axisLen;
  const axisY = axisLen < 1e-6 ? 0 : f_y / axisLen;
  const axisZ = axisLen < 1e-6 ? 0 : f_z / axisLen;
  const theta = angleInt / 4095 * Math.PI;
  const halfTheta = theta * 0.5;
  const s = Math.sin(halfTheta);
  const w = Math.cos(halfTheta);
  out.set(axisX * s, axisY * s, axisZ * s, w);
  return out;
}
function packSint8Bytes(b0, b1, b2, b3) {
  const clampedB0 = Math.round(Math.max(-127, Math.min(127, b0 * 127)));
  const clampedB1 = Math.round(Math.max(-127, Math.min(127, b1 * 127)));
  const clampedB2 = Math.round(Math.max(-127, Math.min(127, b2 * 127)));
  const clampedB3 = Math.round(Math.max(-127, Math.min(127, b3 * 127)));
  return clampedB0 & 255 | (clampedB1 & 255) << 8 | (clampedB2 & 255) << 16 | (clampedB3 & 255) << 24;
}
function encodeSh1Rgb(sh1Array, index, sh1Rgb, encoding) {
  const sh1Max = (encoding == null ? void 0 : encoding.sh1Max) ?? 1;
  const sh1Scale = 63 / sh1Max;
  const base = index * 2;
  for (let i = 0; i < 9; ++i) {
    const s = sh1Rgb[i] * sh1Scale;
    const value = Math.round(Math.max(-63, Math.min(63, s))) & 127;
    const bitStart = i * 7;
    const bitEnd = bitStart + 7;
    const wordStart = Math.floor(bitStart / 32);
    const bitOffset = bitStart - wordStart * 32;
    const firstWord = value << bitOffset & 4294967295;
    sh1Array[base + wordStart] |= firstWord;
    if (bitEnd > wordStart * 32 + 32) {
      const secondWord = value >>> 32 - bitOffset & 4294967295;
      sh1Array[base + wordStart + 1] |= secondWord;
    }
  }
}
function encodeSh2Rgb(sh2Array, index, sh2Rgb, encoding) {
  const sh2Max = (encoding == null ? void 0 : encoding.sh2Max) ?? 1;
  const sh2Scale = 1 / sh2Max;
  sh2Array[index * 4 + 0] = packSint8Bytes(
    sh2Rgb[0] * sh2Scale,
    sh2Rgb[1] * sh2Scale,
    sh2Rgb[2] * sh2Scale,
    sh2Rgb[3] * sh2Scale
  );
  sh2Array[index * 4 + 1] = packSint8Bytes(
    sh2Rgb[4] * sh2Scale,
    sh2Rgb[5] * sh2Scale,
    sh2Rgb[6] * sh2Scale,
    sh2Rgb[7] * sh2Scale
  );
  sh2Array[index * 4 + 2] = packSint8Bytes(
    sh2Rgb[8] * sh2Scale,
    sh2Rgb[9] * sh2Scale,
    sh2Rgb[10] * sh2Scale,
    sh2Rgb[11] * sh2Scale
  );
  sh2Array[index * 4 + 3] = packSint8Bytes(
    sh2Rgb[12] * sh2Scale,
    sh2Rgb[13] * sh2Scale,
    sh2Rgb[14] * sh2Scale,
    0
  );
}
function encodeSh3Rgb(sh3Array, index, sh3Rgb, encoding) {
  const sh3Max = (encoding == null ? void 0 : encoding.sh3Max) ?? 1;
  const sh3Scale = 31 / sh3Max;
  const base = index * 4;
  for (let i = 0; i < 21; ++i) {
    const s = sh3Rgb[i] * sh3Scale;
    const value = Math.round(Math.max(-31, Math.min(31, s))) & 63;
    const bitStart = i * 6;
    const bitEnd = bitStart + 6;
    const wordStart = Math.floor(bitStart / 32);
    const bitOffset = bitStart - wordStart * 32;
    const firstWord = value << bitOffset & 4294967295;
    sh3Array[base + wordStart] |= firstWord;
    if (bitEnd > wordStart * 32 + 32) {
      const secondWord = value >>> 32 - bitOffset & 4294967295;
      sh3Array[base + wordStart + 1] |= secondWord;
    }
  }
}
function encodeExtRgb(r, g, b) {
  const ar = Math.abs(r);
  const ag = Math.abs(g);
  const ab = Math.abs(b);
  const maxAbs = Math.max(ar, ag, ab);
  const base = Math.floor(Math.log2(maxAbs));
  const biasedBase = Math.max(0, Math.min(31, base + 15));
  const divisor = 2 ** (biasedBase - 15) / 255;
  const uR = Math.round(Math.max(0, Math.min(255, ar / divisor)));
  const uG = Math.round(Math.max(0, Math.min(255, ag / divisor)));
  const uB = Math.round(Math.max(0, Math.min(255, ab / divisor)));
  const expSigns = biasedBase << 3 | ((r < 0 ? 1 : 0) | (g < 0 ? 2 : 0) | (b < 0 ? 4 : 0));
  return uR | uG << 8 | uB << 16 | expSigns << 24;
}
function decodeExtRgb(encoded) {
  const color = packedFields.color;
  const biasedBase = encoded >>> 27 & 31;
  const divisor = 2 ** (biasedBase - 15) / 255;
  const r = (encoded & 255) * divisor;
  const g = (encoded >>> 8 & 255) * divisor;
  const b = (encoded >>> 16 & 255) * divisor;
  color.r = encoded & 16777216 ? -r : r;
  color.g = encoded & 33554432 ? -g : g;
  color.b = encoded & 67108864 ? -b : b;
  return color;
}
function encodeExtSh1Rgb(sh1Array, index, sh1Rgb) {
  const i4 = index * 4;
  for (let k = 0; k < 3; ++k) {
    const k3 = k * 3;
    sh1Array[i4 + k] = encodeExtRgb(sh1Rgb[k3], sh1Rgb[k3 + 1], sh1Rgb[k3 + 2]);
  }
}
function encodeExtSh12Rgb(sh1Array, sh2Array, index, sh1Rgb, sh2Rgb) {
  const i4 = index * 4;
  for (let k = 0; k < 3; ++k) {
    const k3 = k * 3;
    sh1Array[i4 + k] = encodeExtRgb(sh1Rgb[k3], sh1Rgb[k3 + 1], sh1Rgb[k3 + 2]);
  }
  sh1Array[i4 + 3] = encodeExtRgb(sh2Rgb[0], sh2Rgb[1], sh2Rgb[2]);
  for (let k = 1; k < 5; ++k) {
    const k5 = k * 5;
    sh2Array[i4 + (k - 1)] = encodeExtRgb(
      sh2Rgb[k5],
      sh2Rgb[k5 + 1],
      sh2Rgb[k5 + 2]
    );
  }
}
function encodeExt3Rgb(sh3ArrayA, sh3ArrayB, index, sh3Rgb) {
  const i4 = index * 4;
  for (let k = 0; k < 4; ++k) {
    const k3 = k * 3;
    sh3ArrayA[i4 + k] = encodeExtRgb(
      sh3Rgb[k3],
      sh3Rgb[k3 + 1],
      sh3Rgb[k3 + 2]
    );
  }
  for (let k = 4; k < 7; ++k) {
    const k3 = k * 3;
    sh3ArrayB[i4 + (k - 4)] = encodeExtRgb(
      sh3Rgb[k3],
      sh3Rgb[k3 + 1],
      sh3Rgb[k3 + 2]
    );
  }
}
const utils = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DataCache,
  FreeList,
  IDENT_VERTEX_SHADER,
  Sint8ToFloat,
  Uint8ToFloat,
  averagePositions,
  averageQuaternions,
  cloneClock,
  coinciDist,
  computeMaxSplats,
  coorientDist,
  decodeExtRgb,
  decodeExtSplat,
  decodeQuatEulerXyz888,
  decodeQuatOctXy1010R12,
  decodeQuatOctXy88R8,
  decodeQuatXyz888,
  encodeExt3Rgb,
  encodeExtRgb,
  encodeExtSh12Rgb,
  encodeExtSh1Rgb,
  encodeExtSplat,
  encodeQuatEulerXyz888,
  encodeQuatOctXy1010R12,
  encodeQuatOctXy88R8,
  encodeQuatXyz888,
  encodeSh1Rgb,
  encodeSh2Rgb,
  encodeSh3Rgb,
  epsilonSign,
  flipPixels,
  floatBitsToUint: floatBitsToUint$1,
  floatToSint8,
  floatToUint8,
  fromHalf,
  getTextureSize,
  getTransferable,
  isAndroid,
  isIos,
  isMobile,
  isOculus,
  isQuest2,
  isVisionPro,
  mapFilterObject,
  mapObject,
  newArray,
  normalize: normalize$1,
  omitUndefined,
  pixelsToPngUrl,
  setPackedSplat,
  setPackedSplatCenter,
  setPackedSplatOpacity,
  setPackedSplatQuat,
  setPackedSplatRgb,
  setPackedSplatRgba,
  setPackedSplatScales,
  threeMrtArray,
  threeRevision,
  toHalf,
  uintBitsToFloat: uintBitsToFloat$1,
  unpackSplat,
  withinCoinciDist,
  withinCoorientDist,
  withinDist
}, Symbol.toStringTag, { value: "Module" }));
class DynoProgram {
  constructor({
    graph,
    inputs,
    outputs,
    template,
    consoleLog
  }) {
    this.graph = graph;
    this.template = template;
    this.inputs = inputs ?? {};
    this.outputs = outputs ?? {};
    const compile = new Compilation({ indent: this.template.indent });
    for (const key in this.outputs) {
      if (this.outputs[key]) {
        compile.declares.add(this.outputs[key]);
      }
    }
    const statements = graph.compile({
      inputs: this.inputs,
      outputs: this.outputs,
      compile
    });
    this.shader = template.generate({ globals: compile.globals, statements });
    this.uniforms = compile.uniforms;
    this.updaters = compile.updaters;
    if (consoleLog) {
      console.log("*** COMPILED SHADER", this.shader);
      console.log("*** UNIFORMS", this.uniforms);
    }
  }
  prepareMaterial() {
    return getMaterial(this);
  }
  update() {
    for (const updater of this.updaters) {
      updater();
    }
  }
}
class DynoProgramTemplate {
  constructor(template) {
    const globals = template.match(/^([ \t]*)\{\{\s*GLOBALS\s*\}\}/m);
    const statements = template.match(/^([ \t]*)\{\{\s*STATEMENTS\s*\}\}/m);
    if (!globals || !statements) {
      throw new Error(
        "Template must contain {{ GLOBALS }} and {{ STATEMENTS }}"
      );
    }
    this.before = template.substring(0, globals.index);
    this.between = template.substring(
      globals.index + globals[0].length,
      statements.index
    );
    this.after = template.substring(
      statements.index + statements[0].length
    );
    this.indent = statements[1];
  }
  generate({
    globals,
    statements
  }) {
    return this.before + Array.from(globals).join("\n\n") + this.between + statements.map((s) => this.indent + s).join("\n") + this.after;
  }
}
const programMaterial = /* @__PURE__ */ new WeakMap();
function getMaterial(program) {
  let material = programMaterial.get(program);
  if (material) {
    return material;
  }
  material = new THREE__namespace.RawShaderMaterial({
    glslVersion: THREE__namespace.GLSL3,
    vertexShader: IDENT_VERTEX_SHADER,
    fragmentShader: program.shader,
    uniforms: program.uniforms
  });
  programMaterial.set(program, material);
  return material;
}
function addOutputType(a, b, operation = "add") {
  const error = () => {
    throw new Error(`Invalid ${operation} types: ${a}, ${b}`);
  };
  if (a === b) return a;
  if (a === "int") {
    if (isIntType(b)) return b;
    error();
  }
  if (b === "int") {
    if (isIntType(a)) return a;
    error();
  }
  if (a === "uint") {
    if (isUintType(b)) return b;
    error();
  }
  if (b === "uint") {
    if (isUintType(a)) return a;
    error();
  }
  if (a === "float") {
    if (isAllFloatType(b)) return b;
    error();
  }
  if (b === "float") {
    if (isAllFloatType(a)) return a;
    error();
  }
  throw new Error(`Invalid ${operation} types: ${a}, ${b}`);
}
function subOutputType(a, b) {
  return addOutputType(a, b, "sub");
}
function mulOutputType(a, b) {
  const error = () => {
    throw new Error(`Invalid mul types: ${a}, ${b}`);
  };
  const result = (value) => value;
  if (a === "int") {
    if (isIntType(b)) return result(b);
    error();
  }
  if (b === "int") {
    if (isIntType(a)) return result(a);
    error();
  }
  if (a === "uint") {
    if (isUintType(b)) return result(b);
    error();
  }
  if (b === "uint") {
    if (isUintType(a)) return result(a);
    error();
  }
  if (a === "float") {
    if (isAllFloatType(b)) return result(b);
    error();
  }
  if (b === "float") {
    if (isAllFloatType(a)) return result(a);
    error();
  }
  if (isIntType(a) || isUintType(a) || isIntType(b) || isUintType(b)) {
    if (a === b) return result(a);
    error();
  }
  if (a === "vec2") {
    if (b === "vec2" || isMat2(b)) return result("vec2");
    if (b === "mat3x2") return result("vec3");
    if (b === "mat4x2") return result("vec4");
    error();
  }
  if (a === "vec3") {
    if (b === "mat2x3") return result("vec2");
    if (b === "vec3" || isMat3(b)) return result("vec3");
    if (b === "mat4x3") return result("vec4");
    error();
  }
  if (a === "vec4") {
    if (b === "mat2x4") return result("vec2");
    if (b === "mat3x4") return result("vec3");
    if (b === "vec4" || isMat4(b)) return result("vec4");
    error();
  }
  if (b === "vec2") {
    if (isMat2(a)) return result("vec2");
    if (a === "mat2x3") return result("vec3");
    if (a === "mat2x4") return result("vec4");
    error();
  }
  if (b === "vec3") {
    if (a === "mat3x2") return result("vec2");
    if (isMat3(a)) return result("vec3");
    if (a === "mat3x4") return result("vec4");
    error();
  }
  if (b === "vec4") {
    if (a === "mat4x2") return result("vec2");
    if (a === "mat4x3") return result("vec3");
    if (isMat4(a)) return result("vec4");
    error();
  }
  if (isMat2(a)) {
    if (isMat2(b)) return result("mat2");
    if (b === "mat3x2") return result("mat3x2");
    if (b === "mat4x2") return result("mat4x2");
    error();
  }
  if (a === "mat2x3") {
    if (isMat2(b)) return result("mat2x3");
    if (b === "mat3x2") return result("mat3");
    if (b === "mat4x2") return result("mat4x3");
    error();
  }
  if (a === "mat2x4") {
    if (isMat2(b)) return result("mat2x4");
    if (b === "mat3x2") return result("mat3x4");
    if (b === "mat4x2") return result("mat4");
    error();
  }
  if (a === "mat3x2") {
    if (b === "mat2x3") return result("mat2");
    if (isMat3(b)) return result("mat3x2");
    if (b === "mat4x3") return result("mat4x2");
    error();
  }
  if (isMat3(a)) {
    if (b === "mat2x3") return result("mat2x3");
    if (isMat3(b)) return result("mat3");
    if (b === "mat4x3") return result("mat4x3");
    error();
  }
  if (a === "mat3x4") {
    if (b === "mat2x3") return result("mat2x4");
    if (isMat3(b)) return result("mat3x4");
    if (b === "mat4x3") return result("mat4");
    error();
  }
  if (a === "mat4x2") {
    if (b === "mat2x4") return result("mat2");
    if (b === "mat3x4") return result("mat3x2");
    if (isMat4(b)) return result("mat4x2");
    error();
  }
  if (a === "mat4x3") {
    if (b === "mat2x4") return result("mat2x3");
    if (b === "mat3x4") return result("mat3");
    if (isMat4(b)) return result("mat4x3");
    error();
  }
  if (isMat4(a)) {
    if (b === "mat2x4") return result("mat2x4");
    if (b === "mat3x4") return result("mat3x4");
    if (isMat4(b)) return result("mat4");
    error();
  }
  throw new Error(`Invalid mul types: ${a}, ${b}`);
}
function divOutputType(a, b) {
  return addOutputType(a, b, "div");
}
function imodOutputType(a, b) {
  if (a === b) return a;
  if (a === "int") {
    if (isIntType(b)) return b;
  } else if (b === "int") {
    if (isIntType(a)) return a;
  } else if (a === "uint") {
    if (isUintType(b)) return b;
  } else if (b === "uint") {
    if (isUintType(a)) return a;
  }
  throw new Error(`Invalid imod types: ${a}, ${b}`);
}
function modOutputType(a, b) {
  if (a === b || b === "float") return a;
  throw new Error(`Invalid mod types: ${a}, ${b}`);
}
function modfOutputType(a) {
  return a;
}
function negOutputType(a) {
  return a;
}
function absOutputType(a) {
  return a;
}
function signOutputType(a) {
  return a;
}
function floorOutputType(a) {
  return a;
}
function ceilOutputType(a) {
  return a;
}
function truncOutputType(a) {
  return a;
}
function roundOutputType(a) {
  return a;
}
function fractOutputType(a) {
  return a;
}
function powOutputType(a) {
  return a;
}
function expOutputType(a) {
  return a;
}
function exp2OutputType(a) {
  return a;
}
function logOutputType(a) {
  return a;
}
function log2OutputType(a) {
  return a;
}
function sqrOutputType(a) {
  return a;
}
function sqrtOutputType(a) {
  return a;
}
function inversesqrtOutputType(a) {
  return a;
}
function minOutputType(a, b, operation = "min") {
  if (a === b) return a;
  if (b === "float") {
    if (isFloatType(a)) return a;
  } else if (b === "int") {
    if (isIntType(a)) return a;
  } else if (b === "uint") {
    if (isUintType(a)) return a;
  }
  throw new Error(`Invalid ${operation} types: ${a}, ${b}`);
}
function maxOutputType(a, b) {
  return minOutputType(a, b, "max");
}
function clampOutputType(a, b, _c) {
  if (b === "float") {
    if (isFloatType(a)) return a;
  } else if (b === "int") {
    if (isIntType(a)) return a;
  } else if (b === "uint") {
    if (isUintType(a)) return a;
  }
  throw new Error(`Invalid clamp types: ${a}, ${b}`);
}
function mixOutputType(a, b, c) {
  if (c === a) return a;
  if (c === "float") return a;
  if (c === "bool" && a === "float") return a;
  if (c === "bvec2" && a === "vec2") return a;
  if (c === "bvec3" && a === "vec3") return a;
  if (c === "bvec4" && a === "vec4") return a;
  throw new Error(`Invalid mix types: ${a}, ${b}, ${c}`);
}
function stepOutputType(a, b) {
  if (a === b || b === "float") return b;
  throw new Error(`Invalid step types: ${a}, ${b}`);
}
function smoothstepOutputType(a, b, c) {
  if (a === b) {
    if (a === c || a === "float") return c;
  }
  throw new Error(`Invalid smoothstep types: ${a}, ${b}, ${c}`);
}
function isNanOutputType(a, operation = "isNan") {
  if (a === "float") return "bool";
  if (a === "vec2") return "bvec2";
  if (a === "vec3") return "bvec3";
  if (a === "vec4") return "bvec4";
  throw new Error(`Invalid ${operation} types: ${a}`);
}
function isInfOutputType(a) {
  return isNanOutputType(a, "isInf");
}
const add = (a, b) => new Add({ a, b });
const sub = (a, b) => new Sub({ a, b });
const mul = (a, b) => new Mul({ a, b });
const div = (a, b) => new Div({ a, b });
const imod = (a, b) => new IMod({ a, b });
const mod = (a, b) => new Mod({ a, b });
const modf = (a) => new Modf({ a }).outputs;
const neg = (a) => new Neg({ a });
const abs = (a) => new Abs({ a });
const sign = (a) => new Sign({ a });
const floor = (a) => new Floor({ a });
const ceil = (a) => new Ceil({ a });
const trunc = (a) => new Trunc({ a });
const round = (a) => new Round({ a });
const fract = (a) => new Fract({ a });
const pow = (a, b) => new Pow({ a, b });
const exp = (a) => new Exp({ a });
const exp2 = (a) => new Exp2({ a });
const log = (a) => new Log({ a });
const log2 = (a) => new Log2({ a });
const sqr = (a) => new Sqr({ a });
const sqrt = (a) => new Sqrt({ a });
const inversesqrt = (a) => new InverseSqrt({ a });
const min = (a, b) => new Min({ a, b });
const max = (a, b) => new Max({ a, b });
const clamp = (a, min2, max2) => new Clamp({ a, min: min2, max: max2 });
const mix = (a, b, t) => new Mix({ a, b, t });
const step = (edge, x) => new Step({ edge, x });
const smoothstep = (edge0, edge1, x) => new Smoothstep({ edge0, edge1, x });
const isNan = (a) => new IsNan({ a });
const isInf = (a) => new IsInf({ a });
class Add extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "sum", outTypeFunc: addOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.sum} = ${inputs.a} + ${inputs.b};`];
    };
  }
}
class Sub extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "difference", outTypeFunc: subOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.difference} = ${inputs.a} - ${inputs.b};`];
    };
  }
}
class Mul extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "product", outTypeFunc: mulOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.product} = ${inputs.a} * ${inputs.b};`];
    };
  }
}
class Div extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "quotient", outTypeFunc: divOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.quotient} = ${inputs.a} / ${inputs.b};`];
    };
  }
}
class IMod extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "remainder", outTypeFunc: imodOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.remainder} = ${inputs.a} % ${inputs.b};`];
    };
  }
}
class Mod extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "remainder", outTypeFunc: modOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.remainder} = mod(${inputs.a}, ${inputs.b});`];
    };
  }
}
class Modf extends Dyno {
  constructor({ a }) {
    const inTypes = { a: valType(a) };
    const outType = modfOutputType(inTypes.a);
    const outTypes = {
      fract: outType,
      integer: outType
    };
    super({ inTypes, outTypes, inputs: { a } });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.fract} = modf(${inputs.a}, ${outputs.integer});`];
    };
  }
}
class Neg extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "neg", outTypeFunc: negOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.neg} = -${inputs.a};`];
    };
  }
}
class Abs extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "abs", outTypeFunc: absOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.abs} = abs(${inputs.a});`];
    };
  }
}
class Sign extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "sign", outTypeFunc: signOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.sign} = sign(${inputs.a});`];
    };
  }
}
class Floor extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "floor", outTypeFunc: floorOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.floor} = floor(${inputs.a});`];
    };
  }
}
class Ceil extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "ceil", outTypeFunc: ceilOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.ceil} = ceil(${inputs.a});`];
    };
  }
}
class Trunc extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "trunc", outTypeFunc: truncOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.trunc} = trunc(${inputs.a});`];
    };
  }
}
class Round extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "round", outTypeFunc: roundOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.round} = round(${inputs.a});`];
    };
  }
}
class Fract extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "fract", outTypeFunc: fractOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.fract} = fract(${inputs.a});`];
    };
  }
}
class Pow extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "power", outTypeFunc: powOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.power} = pow(${inputs.a}, ${inputs.b});`];
    };
  }
}
class Exp extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "exp", outTypeFunc: expOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.exp} = exp(${inputs.a});`];
    };
  }
}
class Exp2 extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "exp2", outTypeFunc: exp2OutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.exp2} = exp2(${inputs.a});`];
    };
  }
}
class Log extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "log", outTypeFunc: logOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.log} = log(${inputs.a});`];
    };
  }
}
class Log2 extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "log2", outTypeFunc: log2OutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.log2} = log2(${inputs.a});`];
    };
  }
}
class Sqr extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "sqr", outTypeFunc: sqrOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.sqr} = ${inputs.a} * ${inputs.a};`];
    };
  }
}
class Sqrt extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "sqrt", outTypeFunc: sqrtOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.sqrt} = sqrt(${inputs.a});`];
    };
  }
}
class InverseSqrt extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "inversesqrt", outTypeFunc: inversesqrtOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.inversesqrt} = inversesqrt(${inputs.a});`];
    };
  }
}
class Min extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "min", outTypeFunc: minOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.min} = min(${inputs.a}, ${inputs.b});`];
    };
  }
}
class Max extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "max", outTypeFunc: maxOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.max} = max(${inputs.a}, ${inputs.b});`];
    };
  }
}
class Clamp extends TrinaryOp {
  constructor({
    a,
    min: min2,
    max: max2
  }) {
    super({
      a,
      b: min2,
      c: max2,
      outKey: "clamp",
      outTypeFunc: clampOutputType
    });
    this.statements = ({ inputs, outputs }) => {
      const { a: a2, b: min3, c: max3 } = inputs;
      return [`${outputs.clamp} = clamp(${a2}, ${min3}, ${max3});`];
    };
  }
}
class Mix extends TrinaryOp {
  constructor({ a, b, t }) {
    super({ a, b, c: t, outKey: "mix", outTypeFunc: mixOutputType });
    this.statements = ({ inputs, outputs }) => {
      const { a: a2, b: b2, c: t2 } = inputs;
      return [`${outputs.mix} = mix(${a2}, ${b2}, ${t2});`];
    };
  }
}
class Step extends BinaryOp {
  constructor({ edge, x }) {
    super({
      a: edge,
      b: x,
      outKey: "step",
      outTypeFunc: stepOutputType
    });
    this.statements = ({ inputs, outputs }) => {
      const { a: edge2, b: x2 } = inputs;
      return [`${outputs.step} = step(${edge2}, ${x2});`];
    };
  }
}
class Smoothstep extends TrinaryOp {
  constructor({
    edge0,
    edge1,
    x
  }) {
    super({
      a: edge0,
      b: edge1,
      c: x,
      outKey: "smoothstep",
      outTypeFunc: smoothstepOutputType
    });
    this.statements = ({ inputs, outputs }) => {
      const { a: edge02, b: edge12, c: x2 } = inputs;
      return [`${outputs.smoothstep} = smoothstep(${edge02}, ${edge12}, ${x2});`];
    };
  }
}
class IsNan extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "isNan", outTypeFunc: isNanOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.isNan} = isNan(${inputs.a});`];
    };
  }
}
class IsInf extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "isInf", outTypeFunc: isInfOutputType });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.isInf} = isInf(${inputs.a});`];
    };
  }
}
const and = (a, b) => new And({ a, b });
const or = (a, b) => new Or({ a, b });
const xor = (a, b) => new Xor({ a, b });
const not = (a) => new Not({ a });
const shr = (a, b) => new Shr({ a, b });
const shl = (a, b) => new Shl({ a, b });
const lessThan = (a, b) => new LessThan({ a, b });
const lessThanEqual = (a, b) => new LessThanEqual({ a, b });
const greaterThan = (a, b) => new GreaterThan({ a, b });
const greaterThanEqual = (a, b) => new GreaterThanEqual({ a, b });
const equal = (a, b) => new Equal({ a, b });
const notEqual = (a, b) => new NotEqual({ a, b });
const any = (a) => new Any({ a });
const all = (a) => new All({ a });
const select = (cond, t, f) => new Select({ cond, t, f });
const compXor = (a) => new CompXor({ a });
class And extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outTypeFunc: (aType, bType) => aType, outKey: "and" });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.and === "bool") {
        return [`${outputs.and} = ${inputs.a} && ${inputs.b};`];
      }
      return [`${outputs.and} = ${inputs.a} & ${inputs.b};`];
    };
  }
}
class Or extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outTypeFunc: (aType, bType) => aType, outKey: "or" });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.or === "bool") {
        return [`${outputs.or} = ${inputs.a} || ${inputs.b};`];
      }
      return [`${outputs.or} = ${inputs.a} | ${inputs.b};`];
    };
  }
}
class Xor extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outTypeFunc: (aType, bType) => aType, outKey: "xor" });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.xor === "bool") {
        return [`${outputs.xor} = ${inputs.a} ^^ ${inputs.b};`];
      }
      return [`${outputs.xor} = ${inputs.a} ^ ${inputs.b};`];
    };
  }
}
class Not extends UnaryOp {
  constructor({ a }) {
    super({ a, outTypeFunc: (aType) => aType, outKey: "not" });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.not === "bool") {
        return [`${outputs.not} = !${inputs.a};`];
      }
      return [`${outputs.not} = not(${inputs.a});`];
    };
  }
}
class LessThan extends BinaryOp {
  constructor({ a, b }) {
    super({
      a,
      b,
      outTypeFunc: (aType, bType) => compareOutputType(aType, "lessThan"),
      outKey: "lessThan"
    });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.lessThan === "bool") {
        return [`${outputs.lessThan} = ${inputs.a} < ${inputs.b};`];
      }
      return [`${outputs.lessThan} = lessThan(${inputs.a}, ${inputs.b});`];
    };
  }
}
class LessThanEqual extends BinaryOp {
  constructor({ a, b }) {
    super({
      a,
      b,
      outTypeFunc: (aType, bType) => compareOutputType(aType, "lessThanEqual"),
      outKey: "lessThanEqual"
    });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.lessThanEqual === "bool") {
        return [`${outputs.lessThanEqual} = ${inputs.a} <= ${inputs.b};`];
      }
      return [
        `${outputs.lessThanEqual} = lessThanEqual(${inputs.a}, ${inputs.b});`
      ];
    };
  }
}
class GreaterThan extends BinaryOp {
  constructor({ a, b }) {
    super({
      a,
      b,
      outTypeFunc: (aType, bType) => compareOutputType(aType, "greaterThan"),
      outKey: "greaterThan"
    });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.greaterThan === "bool") {
        return [`${outputs.greaterThan} = ${inputs.a} > ${inputs.b};`];
      }
      return [
        `${outputs.greaterThan} = greaterThan(${inputs.a}, ${inputs.b});`
      ];
    };
  }
}
class GreaterThanEqual extends BinaryOp {
  constructor({ a, b }) {
    super({
      a,
      b,
      outTypeFunc: (aType, bType) => compareOutputType(aType, "greaterThanEqual"),
      outKey: "greaterThanEqual"
    });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.greaterThanEqual === "bool") {
        return [`${outputs.greaterThanEqual} = ${inputs.a} >= ${inputs.b};`];
      }
      return [
        `${outputs.greaterThanEqual} = greaterThanEqual(${inputs.a}, ${inputs.b});`
      ];
    };
  }
}
class Equal extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outTypeFunc: equalOutputType, outKey: "equal" });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.equal === "bool") {
        return [`${outputs.equal} = ${inputs.a} == ${inputs.b};`];
      }
      return [`${outputs.equal} = equal(${inputs.a}, ${inputs.b});`];
    };
  }
}
class NotEqual extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outTypeFunc: notEqualOutputType, outKey: "notEqual" });
    this.statements = ({ inputs, outputs }) => {
      if (this.outTypes.notEqual === "bool") {
        return [`${outputs.notEqual} = ${inputs.a} != ${inputs.b};`];
      }
      return [`${outputs.notEqual} = notEqual(${inputs.a}, ${inputs.b});`];
    };
  }
}
class Any extends UnaryOp {
  constructor({ a }) {
    super({ a, outTypeFunc: (aType) => "bool", outKey: "any" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.any} = any(${inputs.a});`];
    };
  }
}
class All extends UnaryOp {
  constructor({ a }) {
    super({ a, outTypeFunc: (aType) => "bool", outKey: "all" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.all} = all(${inputs.a});`];
    };
  }
}
class Select extends TrinaryOp {
  constructor({
    cond,
    t,
    f
  }) {
    super({
      a: cond,
      b: t,
      c: f,
      outKey: "select",
      outTypeFunc: (aType, bType, cType) => bType
    });
    this.statements = ({ inputs, outputs }) => {
      const { a: cond2, b: t2, c: f2 } = inputs;
      return [`${outputs.select} = (${cond2}) ? (${t2}) : (${f2});`];
    };
  }
}
function compareOutputType(type, operator) {
  if (isScalarType(type)) {
    return "bool";
  }
  if (type === "ivec2" || type === "uvec2" || type === "vec2") {
    return "bvec2";
  }
  if (type === "ivec3" || type === "uvec3" || type === "vec3") {
    return "bvec3";
  }
  if (type === "ivec4" || type === "uvec4" || type === "vec4") {
    return "bvec4";
  }
  throw new Error(`Invalid ${operator} type: ${type}`);
}
function equalOutputType(type, operator = "equal") {
  if (isScalarType(type)) {
    return "bool";
  }
  if (isBoolType(type)) {
    return type;
  }
  if (type === "ivec2" || type === "uvec2" || type === "vec2") {
    return "bvec2";
  }
  if (type === "ivec3" || type === "uvec3" || type === "vec3") {
    return "bvec3";
  }
  if (type === "ivec4" || type === "uvec4" || type === "vec4") {
    return "bvec4";
  }
  throw new Error(`Invalid ${operator} type: ${type}`);
}
function notEqualOutputType(type) {
  return equalOutputType(type, "notEqual");
}
function compXorOutputType(type) {
  if (isBoolType(type)) {
    return "bool";
  }
  if (isIntType(type)) {
    return "int";
  }
  if (isUintType(type)) {
    return "uint";
  }
  throw new Error(`Invalid compXor type: ${type}`);
}
class CompXor extends UnaryOp {
  constructor({ a }) {
    const outType = compXorOutputType(valType(a));
    super({ a, outTypeFunc: (aType) => outType, outKey: "compXor" });
    this.statements = ({ inputs, outputs }) => {
      if (isScalarType(this.outTypes.compXor)) {
        return [`${outputs.compXor} = ${inputs.a};`];
      }
      const components = isVector2Type(outType) ? ["x", "y"] : isVector3Type(outType) ? ["x", "y", "z"] : ["x", "y", "z", "w"];
      const operands = components.map((c) => `${inputs.a}.${c}`);
      const operator = isBoolType(outType) ? "^^" : "^";
      return [`${outputs.compXor} = ${operands.join(` ${operator} `)};`];
    };
  }
}
class Shr extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outTypeFunc: (aType, bType) => aType, outKey: "shr" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.shr} = ${inputs.a} >> ${inputs.b};`];
    };
  }
}
class Shl extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outTypeFunc: (aType, bType) => aType, outKey: "shl" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.shl} = ${inputs.a} << ${inputs.b};`];
    };
  }
}
const bool = (value) => new Bool({ value });
const int = (value) => new Int({ value });
const uint = (value) => new Uint({ value });
const float = (value) => new Float({ value });
const bvec2 = (value) => new BVec2({ value });
const bvec3 = (value) => new BVec3({ value });
const bvec4 = (value) => new BVec4({ value });
const ivec2 = (value) => new IVec2({ value });
const ivec3 = (value) => new IVec3({ value });
const ivec4 = (value) => new IVec4({ value });
const uvec2 = (value) => new UVec2({ value });
const uvec3 = (value) => new UVec3({ value });
const uvec4 = (value) => new UVec4({ value });
const vec2 = (value) => new Vec2({ value });
const vec3 = (value) => new Vec3({ value });
const vec4 = (value) => new Vec4({ value });
const mat2 = (value) => new Mat2({ value });
const mat3 = (value) => new Mat3({ value });
const mat4 = (value) => new Mat4({ value });
const floatBitsToInt = (value) => new FloatBitsToInt({ value });
const floatBitsToUint = (value) => new FloatBitsToUint({ value });
const intBitsToFloat = (value) => new IntBitsToFloat({ value });
const uintBitsToFloat = (value) => new UintBitsToFloat({ value });
const packSnorm2x16 = (value) => new PackSnorm2x16({ value });
const unpackSnorm2x16 = (value) => new UnpackSnorm2x16({ value });
const packUnorm2x16 = (value) => new PackUnorm2x16({ value });
const unpackUnorm2x16 = (value) => new UnpackUnorm2x16({ value });
const packHalf2x16 = (value) => new PackHalf2x16({ value });
const unpackHalf2x16 = (value) => new UnpackHalf2x16({ value });
const uintToRgba8 = (value) => new UintToRgba8({ value });
class SimpleCast extends UnaryOp {
  constructor({
    value,
    outType,
    outKey
  }) {
    super({ a: value, outTypeFunc: () => outType, outKey });
    this.statements = ({ inputs, outputs }) => [
      `${outputs[outKey]} = ${typeLiteral(outType)}(${inputs.a});`
    ];
  }
}
class Bool extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "bool", outKey: "bool" });
  }
}
class Int extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "int", outKey: "int" });
  }
}
class Uint extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "uint", outKey: "uint" });
  }
}
class Float extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "float", outKey: "float" });
  }
}
class BVec2 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "bvec2", outKey: "bvec2" });
  }
}
class BVec3 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "bvec3", outKey: "bvec3" });
  }
}
class BVec4 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "bvec4", outKey: "bvec4" });
  }
}
class IVec2 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "ivec2", outKey: "ivec2" });
  }
}
class IVec3 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "ivec3", outKey: "ivec3" });
  }
}
class IVec4 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "ivec4", outKey: "ivec4" });
  }
}
class UVec2 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "uvec2", outKey: "uvec2" });
  }
}
class UVec3 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "uvec3", outKey: "uvec3" });
  }
}
class UVec4 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "uvec4", outKey: "uvec4" });
  }
}
class Vec2 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "vec2", outKey: "vec2" });
  }
}
class Vec3 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "vec3", outKey: "vec3" });
  }
}
class Vec4 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "vec4", outKey: "vec4" });
  }
}
class Mat2 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "mat2", outKey: "mat2" });
  }
}
class Mat3 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "mat3", outKey: "mat3" });
  }
}
class Mat4 extends SimpleCast {
  constructor({
    value
  }) {
    super({ value, outType: "mat4", outKey: "mat4" });
  }
}
class FloatBitsToInt extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "int", outTypeFunc: () => "int" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.int} = floatBitsToInt(${inputs.a});`];
    };
  }
}
class FloatBitsToUint extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "uint", outTypeFunc: () => "uint" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.uint} = floatBitsToUint(${inputs.a});`];
    };
  }
}
class IntBitsToFloat extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "float", outTypeFunc: () => "float" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.float} = intBitsToFloat(${inputs.a});`];
    };
  }
}
class UintBitsToFloat extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "float", outTypeFunc: () => "float" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.float} = uintBitsToFloat(${inputs.a});`];
    };
  }
}
class PackSnorm2x16 extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "uint", outTypeFunc: () => "uint" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.uint} = packSnorm2x16(${inputs.a});`];
    };
  }
}
class UnpackSnorm2x16 extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "vec2", outTypeFunc: () => "vec2" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.vec2} = unpackSnorm2x16(${inputs.a});`];
    };
  }
}
class PackUnorm2x16 extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "uint", outTypeFunc: () => "uint" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.uint} = packUnorm2x16(${inputs.a});`];
    };
  }
}
class UnpackUnorm2x16 extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "vec2", outTypeFunc: () => "vec2" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.vec2} = unpackUnorm2x16(${inputs.a});`];
    };
  }
}
class PackHalf2x16 extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "uint", outTypeFunc: () => "uint" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.uint} = packHalf2x16(${inputs.a});`];
    };
  }
}
class UnpackHalf2x16 extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "vec2", outTypeFunc: () => "vec2" });
    this.statements = ({ inputs, outputs }) => {
      return [`${outputs.vec2} = unpackHalf2x16(${inputs.a});`];
    };
  }
}
class UintToRgba8 extends UnaryOp {
  constructor({ value }) {
    super({ a: value, outKey: "rgba8", outTypeFunc: () => "vec4" });
    this.statements = ({ inputs, outputs }) => {
      return [
        `uvec4 uRgba = uvec4(${inputs.a} & 0xffu, (${inputs.a} >> 8u) & 0xffu, (${inputs.a} >> 16u) & 0xffu, (${inputs.a} >> 24u) & 0xffu);`,
        `${outputs.rgba8} = vec4(uRgba) / 255.0;`
      ];
    };
  }
}
const length = (a) => new Length({ a });
const distance = (a, b) => new Distance({ a, b });
const dot = (a, b) => new Dot({ a, b });
const cross = (a, b) => new Cross({ a, b });
const normalize = (a) => new Normalize({ a });
const faceforward = (a, b, c) => new FaceForward({ a, b, c });
const reflectVec = (incident, normal) => new ReflectVec({ incident, normal });
const refractVec = (incident, normal, eta) => new RefractVec({ incident, normal, eta });
const split = (vector) => new Split({ vector });
const combine = ({
  vector,
  vectorType,
  x,
  y,
  z,
  w,
  r,
  g,
  b,
  a
}) => new Combine({ vector, vectorType, x, y, z, w, r, g, b, a });
const projectH = (a) => new ProjectH({ a });
const extendVec = (a, b) => new ExtendVec({ a, b });
const swizzle = (a, select2) => new Swizzle({ vector: a, select: select2 });
const compMult = (a, b) => new CompMult({ a, b });
const outer = (a, b) => new Outer({ a, b });
const transpose = (a) => new Transpose({ a });
const determinant = (a) => new Determinant({ a });
const inverse = (a) => new Inverse({ a });
class Length extends UnaryOp {
  constructor({ a }) {
    super({ a, outTypeFunc: (aType) => "float", outKey: "length" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.length} = length(${inputs.a});`
    ];
  }
}
class Distance extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "distance", outTypeFunc: (aType, bType) => "float" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.distance} = distance(${inputs.a}, ${inputs.b});`
    ];
  }
}
class Dot extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "dot", outTypeFunc: (aType, bType) => "float" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.dot} = dot(${inputs.a}, ${inputs.b});`
    ];
  }
}
class Cross extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "cross", outTypeFunc: (aType, bType) => "vec3" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.cross} = cross(${inputs.a}, ${inputs.b});`
    ];
  }
}
class Normalize extends UnaryOp {
  constructor({ a }) {
    super({ a, outTypeFunc: (aType) => aType, outKey: "normalize" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.normalize} = normalize(${inputs.a});`
    ];
  }
}
function projectHOutputType(type) {
  if (type === "vec3") {
    return "vec2";
  }
  if (type === "vec4") {
    return "vec3";
  }
  throw new Error("Invalid type");
}
class ProjectH extends UnaryOp {
  constructor({ a }) {
    super({
      a,
      outTypeFunc: (aType) => projectHOutputType(aType),
      outKey: "projected"
    });
    this.statements = ({ inputs, outputs }) => {
      if (this.inTypes.a === "vec3") {
        return [`${outputs.projected} = ${inputs.a}.xy / ${inputs.a}.z;`];
      }
      if (this.inTypes.a === "vec4") {
        return [`${outputs.projected} = ${inputs.a}.xyz / ${inputs.a}.w;`];
      }
      throw new Error("Invalid type");
    };
  }
}
function extendVecOutputType(type) {
  if (type === "float") return "vec2";
  if (type === "vec2") return "vec3";
  if (type === "vec3") return "vec4";
  throw new Error("Invalid type");
}
class ExtendVec extends BinaryOp {
  constructor({ a, b }) {
    const type = valType(a);
    const outType = extendVecOutputType(type);
    super({ a, b, outKey: "extend", outTypeFunc: () => outType });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.extend} = ${outType}(${inputs.a}, ${inputs.b});`
    ];
  }
}
class FaceForward extends TrinaryOp {
  constructor({ a, b, c }) {
    super({
      a,
      b,
      c,
      outKey: "forward",
      outTypeFunc: (aType, bType, cType) => aType
    });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.forward} = faceforward(${inputs.a}, ${inputs.b}, ${inputs.c});`
    ];
  }
}
class ReflectVec extends BinaryOp {
  constructor({
    incident,
    normal
  }) {
    super({
      a: incident,
      b: normal,
      outKey: "reflection",
      outTypeFunc: (aType, bType) => aType
    });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.reflection} = reflect(${inputs.a}, ${inputs.b});`
    ];
  }
}
class RefractVec extends TrinaryOp {
  constructor({
    incident,
    normal,
    eta
  }) {
    super({
      a: incident,
      b: normal,
      c: eta,
      outKey: "refraction",
      outTypeFunc: (aType, bType, cType) => aType
    });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.refraction} = refract(${inputs.a}, ${inputs.b}, ${inputs.c});`
    ];
  }
}
class CompMult extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "product", outTypeFunc: (aType, bType) => aType });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.product} = matrixCompMult(${a}, ${b});`
    ];
  }
}
function outerOutputType(aType, bType) {
  if (aType === "vec2") {
    if (bType === "vec2") return "mat2";
    if (bType === "vec3") return "mat3x2";
    if (bType === "vec4") return "mat4x2";
  }
  if (aType === "vec3") {
    if (bType === "vec2") return "mat2x3";
    if (bType === "vec3") return "mat3";
    if (bType === "vec4") return "mat4x3";
  }
  if (aType === "vec4") {
    if (bType === "vec2") return "mat2x4";
    if (bType === "vec3") return "mat3x4";
    if (bType === "vec4") return "mat4";
  }
  throw new Error(`Invalid outer type: ${aType}, ${bType}`);
}
class Outer extends BinaryOp {
  constructor({ a, b }) {
    super({ a, b, outKey: "outer", outTypeFunc: outerOutputType });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.outer} = outerProduct(${inputs.a}, ${inputs.b});`
    ];
  }
}
function transposeOutputType(type) {
  if (type === "mat2") return "mat2";
  if (type === "mat3") return "mat3";
  if (type === "mat4") return "mat4";
  if (type === "mat2x2") return "mat2x2";
  if (type === "mat2x3") return "mat3x2";
  if (type === "mat2x4") return "mat4x2";
  if (type === "mat3x2") return "mat2x3";
  if (type === "mat3x3") return "mat3x3";
  if (type === "mat3x4") return "mat4x3";
  if (type === "mat4x2") return "mat2x4";
  if (type === "mat4x3") return "mat3x4";
  if (type === "mat4x4") return "mat4x4";
  throw new Error(`Invalid transpose type: ${type}`);
}
class Transpose extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "transpose", outTypeFunc: transposeOutputType });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.transpose} = transpose(${inputs.a});`
    ];
  }
}
class Determinant extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "det", outTypeFunc: (aType) => "float" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.det} = determinant(${inputs.a});`
    ];
  }
}
class Inverse extends UnaryOp {
  constructor({ a }) {
    super({ a, outKey: "inverse", outTypeFunc: (aType) => aType });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.inverse} = inverse(${a});`
    ];
  }
}
function splitOutTypes(type) {
  const result = (value) => value;
  switch (type) {
    case "vec2":
      return result({ x: "float", y: "float", r: "float", g: "float" });
    case "vec3":
      return result({
        x: "float",
        y: "float",
        z: "float",
        r: "float",
        g: "float",
        b: "float"
      });
    case "vec4":
      return result({
        x: "float",
        y: "float",
        z: "float",
        w: "float",
        r: "float",
        g: "float",
        b: "float",
        a: "float"
      });
    case "ivec2":
      return result({ x: "int", y: "int", r: "int", g: "int" });
    case "ivec3":
      return result({
        x: "int",
        y: "int",
        z: "int",
        r: "int",
        g: "int",
        b: "int"
      });
    case "ivec4":
      return result({
        x: "int",
        y: "int",
        z: "int",
        w: "int",
        r: "int",
        g: "int",
        b: "int",
        a: "int"
      });
    case "uvec2":
      return result({ x: "uint", y: "uint", r: "uint", g: "uint" });
    case "uvec3":
      return result({
        x: "uint",
        y: "uint",
        z: "uint",
        r: "uint",
        g: "uint",
        b: "uint"
      });
    case "uvec4":
      return result({
        x: "uint",
        y: "uint",
        z: "uint",
        w: "uint",
        r: "uint",
        g: "uint",
        b: "uint",
        a: "uint"
      });
    default:
      throw new Error(`Invalid vector type: ${type}`);
  }
}
class Split extends Dyno {
  constructor({ vector }) {
    const type = valType(vector);
    const inTypes = { vector: type };
    const outTypes = splitOutTypes(inTypes.vector);
    super({ inTypes, outTypes, inputs: { vector } });
    this.statements = ({ inputs, outputs }) => {
      const { x, y, z, w, r, g, b, a } = outputs;
      const { vector: vector2 } = inputs;
      return [
        x ? `${x} = ${vector2}.x;` : null,
        y ? `${y} = ${vector2}.y;` : null,
        z ? `${z} = ${vector2}.z;` : null,
        w ? `${w} = ${vector2}.w;` : null,
        r ? `${r} = ${vector2}.r;` : null,
        g ? `${g} = ${vector2}.g;` : null,
        b ? `${b} = ${vector2}.b;` : null,
        a ? `${a} = ${vector2}.a;` : null
      ].filter(Boolean);
    };
  }
}
class Combine extends Dyno {
  constructor({
    vector,
    vectorType,
    x,
    y,
    z,
    w,
    r,
    g,
    b,
    a
  }) {
    if (!vector && !vectorType) {
      throw new Error("Either vector or vectorType must be provided");
    }
    const vType = vectorType ?? valType(vector);
    const elType = vectorElementType(vType);
    const dim = vectorDim(vType);
    const inTypes = {
      vector: vType,
      x: elType,
      y: elType,
      r: elType,
      g: elType
    };
    const inputs = { vector, x, y, r, g };
    if (dim >= 3) {
      Object.assign(inTypes, { z: elType, b: elType });
      Object.assign(inputs, { z, b });
    }
    if (dim >= 4) {
      Object.assign(inTypes, { w: elType, a: elType });
      Object.assign(inputs, { w, a });
    }
    super({ inTypes, outTypes: { vector: vType }, inputs });
    this.statements = ({ inputs: inputs2, outputs }) => {
      const { vector: vector2 } = outputs;
      const {
        vector: input,
        x: x2,
        y: y2,
        z: z2,
        w: w2,
        r: r2,
        g: g2,
        b: b2,
        a: a2
      } = inputs2;
      const statements = [
        `${vector2}.x = ${x2 ?? r2 ?? (input ? `${input}.x` : literalZero(elType))};`,
        `${vector2}.y = ${y2 ?? g2 ?? (input ? `${input}.y` : literalZero(elType))};`
      ];
      if (dim >= 3)
        statements.push(
          `${vector2}.z = ${z2 ?? b2 ?? (input ? `${input}.z` : literalZero(elType))};`
        );
      if (dim >= 4)
        statements.push(
          `${vector2}.w = ${w2 ?? a2 ?? (input ? `${input}.w` : literalZero(elType))};`
        );
      return statements;
    };
  }
  dynoOut() {
    return new DynoOutput(
      this,
      "vector"
    );
  }
}
function swizzleOutputType(type, swizzle2) {
  let result = null;
  if (isFloatType(type)) {
    result = swizzle2.length === 1 ? "float" : swizzle2.length === 2 ? "vec2" : swizzle2.length === 3 ? "vec3" : swizzle2.length === 4 ? "vec4" : null;
  } else if (isIntType(type)) {
    result = swizzle2.length === 1 ? "int" : swizzle2.length === 2 ? "ivec2" : swizzle2.length === 3 ? "ivec3" : swizzle2.length === 4 ? "ivec4" : null;
  } else if (isUintType(type)) {
    result = swizzle2.length === 1 ? "uint" : swizzle2.length === 2 ? "uvec2" : swizzle2.length === 3 ? "uvec3" : swizzle2.length === 4 ? "uvec4" : null;
  }
  if (result == null) {
    throw new Error(`Invalid swizzle: ${swizzle2}`);
  }
  return result;
}
class Swizzle extends UnaryOp {
  constructor({ vector, select: select2 }) {
    super({
      a: vector,
      outKey: "swizzle",
      outTypeFunc: (aType) => swizzleOutputType(aType, select2)
    });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.swizzle} = ${inputs.a}.${select2};`
    ];
  }
}
const remapIndex = (index, from, to) => {
  return new DynoRemapIndex({ index, from, to });
};
const pcgMix = (value) => {
  return new PcgMix({ value });
};
const pcgNext = (state) => {
  return new PcgNext({ state });
};
const pcgHash = (state) => {
  return new PcgHash({ state });
};
const hash = (value) => {
  return new Hash({ value });
};
const hash2 = (value) => {
  return new Hash2({ value });
};
const hash3 = (value) => {
  return new Hash3({ value });
};
const hash4 = (value) => {
  return new Hash4({ value });
};
const hashFloat = (value) => {
  return new HashFloat({ value });
};
const hashVec2 = (value) => {
  return new HashVec2({ value });
};
const hashVec3 = (value) => {
  return new HashVec3({ value });
};
const hashVec4 = (value) => {
  return new HashVec4({ value });
};
const normalizedDepth = (z, zNear, zFar) => {
  return new NormalizedDepth({ z, zNear, zFar }).outputs.depth;
};
const debugColorHue = (index) => {
  return new DebugColorHue({ index });
};
class DynoRemapIndex extends Dyno {
  constructor({
    from,
    to,
    index
  }) {
    super({
      inTypes: { from: "int", to: "int", index: "int" },
      outTypes: { index: "int" },
      inputs: { from, to, index },
      statements: ({ inputs, outputs }) => {
        return [
          `${outputs.index} = ${inputs.index} - ${inputs.from} + ${inputs.to};`
        ];
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "index");
  }
}
class PcgNext extends Dyno {
  constructor({ state }) {
    const type = valType(state);
    super({
      inTypes: { state: type },
      outTypes: { state: "uint" },
      inputs: { state },
      globals: () => [
        unindent(`
          uint pcg_next(uint state) {
            return state * 747796405u + 2891336453u;
          }
        `)
      ],
      statements: ({ inputs, outputs }) => {
        const toUint = type === "uint" ? `${inputs.state}` : type === "int" ? `uint(${inputs.state})` : `floatBitsToUint(${inputs.state})`;
        return [`${outputs.state} = pcg_next(${toUint});`];
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "state");
  }
}
class PcgHash extends Dyno {
  constructor({ state }) {
    super({
      inTypes: { state: "uint" },
      outTypes: { hash: "uint" },
      inputs: { state },
      globals: () => [
        unindent(`
          uint pcg_hash(uint state) {
            uint hash = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
            return (hash >> 22u) ^ hash;
          }
        `)
      ],
      statements: ({ inputs, outputs }) => [
        `${outputs.hash} = pcg_hash(${inputs.state});`
      ]
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class PcgMix extends Dyno {
  constructor({ value }) {
    const type = valType(value);
    const tempType = sameSizeUvec(type);
    super({
      inTypes: { value: type },
      outTypes: { state: "uint" },
      inputs: { value },
      globals: () => [
        unindent(`
          uint pcg_mix(uint value) {
            return value;
          }
          uint pcg_mix(uvec2 value) {
            return value.x + 0x9e3779b9u * value.y;
          }
          uint pcg_mix(uvec3 value) {
            return value.x + 0x9e3779b9u * value.y + 0x85ebca6bu * value.z;
          }
          uint pcg_mix(uvec4 value) {
            return value.x + 0x9e3779b9u * value.y + 0x85ebca6bu * value.z + 0xc2b2ae35u * value.w;
          }
        `)
      ],
      statements: ({ inputs, outputs }) => {
        const toUvec = isUintType(type) ? `${inputs.value}` : isIntType(type) ? `${tempType}(${inputs.value})` : `floatBitsToUint(${inputs.value})`;
        return [
          `${tempType} bits = ${toUvec};`,
          `${outputs.state} = pcg_mix(bits);`
        ];
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "state");
  }
}
class Hash extends DynoBlock {
  constructor({ value }) {
    super({
      inTypes: { value: valType(value) },
      outTypes: { hash: "uint" },
      inputs: { value },
      construct: ({ value: value2 }) => {
        if (!value2) {
          throw new Error("value is required");
        }
        let state = new PcgMix({ value: value2 }).outputs.state;
        state = new PcgNext({ state }).outputs.state;
        return new PcgHash({ state }).outputs;
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class Hash2 extends DynoBlock {
  constructor({ value }) {
    super({
      inTypes: { value: valType(value) },
      outTypes: { hash: "uvec2" },
      inputs: { value },
      construct: ({ value: value2 }) => {
        if (!value2) {
          throw new Error("value is required");
        }
        let state = new PcgMix({ value: value2 }).outputs.state;
        state = new PcgNext({ state }).outputs.state;
        const x = new PcgHash({ state }).outputs.hash;
        state = new PcgNext({ state }).outputs.state;
        const y = new PcgHash({ state }).outputs.hash;
        return { hash: combine({ vectorType: "uvec2", x, y }) };
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class Hash3 extends DynoBlock {
  constructor({ value }) {
    super({
      inTypes: { value: valType(value) },
      outTypes: { hash: "uvec3" },
      inputs: { value },
      construct: ({ value: value2 }) => {
        if (!value2) {
          throw new Error("value is required");
        }
        let state = new PcgMix({ value: value2 }).outputs.state;
        state = new PcgNext({ state }).outputs.state;
        const x = new PcgHash({ state }).outputs.hash;
        state = new PcgNext({ state }).outputs.state;
        const y = new PcgHash({ state }).outputs.hash;
        state = new PcgNext({ state }).outputs.state;
        const z = new PcgHash({ state }).outputs.hash;
        return { hash: combine({ vectorType: "uvec3", x, y, z }) };
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class Hash4 extends DynoBlock {
  constructor({ value }) {
    super({
      inTypes: { value: valType(value) },
      outTypes: { hash: "uvec4" },
      inputs: { value },
      construct: ({ value: value2 }) => {
        if (!value2) {
          throw new Error("value is required");
        }
        let state = new PcgMix({ value: value2 }).outputs.state;
        state = new PcgNext({ state }).outputs.state;
        const x = new PcgHash({ state }).outputs.hash;
        state = new PcgNext({ state }).outputs.state;
        const y = new PcgHash({ state }).outputs.hash;
        state = new PcgNext({ state }).outputs.state;
        const z = new PcgHash({ state }).outputs.hash;
        state = new PcgNext({ state }).outputs.state;
        const w = new PcgHash({ state }).outputs.hash;
        return { hash: combine({ vectorType: "uvec4", x, y, z, w }) };
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class HashFloat extends DynoBlock {
  constructor({ value }) {
    super({
      inTypes: { value: valType(value) },
      outTypes: { hash: "float" },
      inputs: { value },
      construct: ({ value: value2 }) => {
        if (!value2) {
          throw new Error("value is required");
        }
        const word = hash(value2);
        return { hash: mul(float(word), dynoConst("float", 1 / 2 ** 32)) };
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class HashVec2 extends DynoBlock {
  constructor({ value }) {
    super({
      inTypes: { value: valType(value) },
      outTypes: { hash: "vec2" },
      inputs: { value },
      construct: ({ value: value2 }) => {
        if (!value2) {
          throw new Error("value is required");
        }
        const words = hash2(value2);
        return { hash: mul(vec2(words), dynoConst("float", 1 / 2 ** 32)) };
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class HashVec3 extends DynoBlock {
  constructor({ value }) {
    super({
      inTypes: { value: valType(value) },
      outTypes: { hash: "vec3" },
      inputs: { value },
      construct: ({ value: value2 }) => {
        if (!value2) {
          throw new Error("value is required");
        }
        const words = hash3(value2);
        return { hash: mul(vec3(words), dynoConst("float", 1 / 2 ** 32)) };
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class HashVec4 extends DynoBlock {
  constructor({ value }) {
    super({
      inTypes: { value: valType(value) },
      outTypes: { hash: "vec4" },
      inputs: { value },
      construct: ({ value: value2 }) => {
        if (!value2) {
          throw new Error("value is required");
        }
        const words = hash4(value2);
        return { hash: mul(vec4(words), dynoConst("float", 1 / 2 ** 32)) };
      }
    });
  }
  dynoOut() {
    return new DynoOutput(this, "hash");
  }
}
class NormalizedDepth extends Dyno {
  constructor({
    z,
    zNear,
    zFar
  }) {
    super({
      inTypes: { z: "float", zNear: "float", zFar: "float" },
      outTypes: { depth: "float" },
      inputs: { z, zNear, zFar },
      statements: ({ inputs, outputs }) => [
        `float clamped = clamp(${inputs.z}, ${inputs.zNear}, ${inputs.zFar});`,
        `${outputs.depth} = (log2(clamped + 1.0) - log2(${inputs.zNear} + 1.0)) / (log2(${inputs.zFar} + 1.0) - log2(${inputs.zNear} + 1.0));`
      ]
    });
  }
  dynoOut() {
    return new DynoOutput(this, "depth");
  }
}
class DebugColorHue extends Dyno {
  constructor({ index }) {
    super({
      inTypes: { index: "int" },
      outTypes: { color: "vec3" },
      inputs: { index },
      statements: ({ inputs, outputs }) => [
        `${outputs.color} = debugColorHue(uint(${inputs.index}));`
      ]
    });
  }
  dynoOut() {
    return new DynoOutput(this, "color");
  }
}
const transformPos = (position, {
  scale,
  scales,
  rotate,
  translate
}) => {
  return new TransformPosition({ position, scale, scales, rotate, translate }).outputs.position;
};
const transformDir = (dir, {
  scale,
  scales,
  rotate
}) => {
  return new TransformDir({ dir, scale, scales, rotate }).outputs.dir;
};
const transformQuat = (quaternion, { rotate }) => {
  return new TransformQuaternion({ quaternion, rotate }).outputs.quaternion;
};
class TransformPosition extends Dyno {
  constructor({
    position,
    scale,
    scales,
    rotate,
    translate
  }) {
    super({
      inTypes: {
        position: "vec3",
        scale: "float",
        scales: "vec3",
        rotate: "vec4",
        translate: "vec3"
      },
      outTypes: { position: "vec3" },
      inputs: { position, scale, scales, rotate, translate },
      statements: ({ inputs, outputs }) => {
        const { position: position2 } = outputs;
        if (!position2) {
          return [];
        }
        const { scale: scale2, scales: scales2, rotate: rotate2, translate: translate2 } = inputs;
        return [
          `${position2} = ${inputs.position ?? "vec3(0.0, 0.0, 0.0)"};`,
          !scale2 ? null : `${position2} *= ${scale2};`,
          !scales2 ? null : `${position2} *= ${scales2};`,
          !rotate2 ? null : `${position2} = quatVec(${rotate2}, ${position2});`,
          !translate2 ? null : `${position2} += ${translate2};`
        ].filter(Boolean);
      }
    });
  }
}
class TransformDir extends Dyno {
  constructor({
    dir,
    scale,
    scales,
    rotate
  }) {
    super({
      inTypes: { dir: "vec3", scale: "float", scales: "vec3", rotate: "vec4" },
      outTypes: { dir: "vec3" },
      inputs: { dir, scale, scales, rotate },
      statements: ({ inputs, outputs }) => {
        const { dir: dir2 } = outputs;
        if (!dir2) {
          return [];
        }
        const { scale: scale2, scales: scales2, rotate: rotate2 } = inputs;
        return [
          `${dir2} = ${inputs.dir ?? "vec3(0.0, 0.0, 0.0)"};`,
          !scale2 ? null : `${dir2} *= ${scale2};`,
          !scales2 ? null : `${dir2} *= ${scales2};`,
          !rotate2 ? null : `${dir2} = quatVec(${rotate2}, ${dir2});`
        ].filter(Boolean);
      }
    });
  }
}
class TransformQuaternion extends Dyno {
  constructor({
    quaternion,
    rotate
  }) {
    super({
      inTypes: { quaternion: "vec4", rotate: "vec4" },
      outTypes: { quaternion: "vec4" },
      inputs: { quaternion, rotate },
      statements: ({ inputs, outputs }) => {
        const { quaternion: quaternion2 } = outputs;
        if (!quaternion2) {
          return [];
        }
        return [
          `${quaternion2} = ${inputs.quaternion ?? "vec4(0.0, 0.0, 0.0, 1.0)"};`,
          !rotate ? null : `${quaternion2} = quatQuat(${inputs.rotate}, ${quaternion2});`
        ].filter(Boolean);
      }
    });
  }
}
const dynoIf = () => {
  throw new Error("Not implemented");
};
const dynoSwitch = () => {
  throw new Error("Not implemented");
};
const dynoFor = () => {
  throw new Error("Not implemented");
};
const comment = () => {
  throw new Error("Not implemented");
};
const arrayIndex = () => {
  throw new Error("Not implemented");
};
const arrayLength = () => {
  throw new Error("Not implemented");
};
const textureSize = (texture2, lod) => new TextureSize({ texture: texture2, lod });
const texture = (texture2, coord, bias) => new Texture({ texture: texture2, coord, bias });
const texelFetch = (texture2, coord, lod) => new TexelFetch({ texture: texture2, coord, lod });
class TextureSize extends Dyno {
  constructor({ texture: texture2, lod }) {
    const textureType = valType(texture2);
    super({
      inTypes: { texture: textureType, lod: "int" },
      outTypes: { size: textureSizeType(textureType) },
      inputs: { texture: texture2, lod },
      statements: ({ inputs, outputs }) => [
        `${outputs.size} = textureSize(${inputs.texture}, ${inputs.lod ?? "0"});`
      ]
    });
  }
  dynoOut() {
    return new DynoOutput(this, "size");
  }
}
class Texture extends Dyno {
  constructor({
    texture: texture2,
    coord,
    bias
  }) {
    const textureType = valType(texture2);
    super({
      inTypes: {
        texture: textureType,
        coord: textureCoordType(textureType),
        bias: "float"
      },
      outTypes: { sample: textureReturnType(textureType) },
      inputs: { texture: texture2, coord, bias },
      statements: ({ inputs, outputs }) => [
        `${outputs.sample} = texture(${inputs.texture}, ${inputs.coord}${inputs.bias ? `, ${inputs.bias}` : ""});`
      ]
    });
  }
  dynoOut() {
    return new DynoOutput(this, "sample");
  }
}
class TexelFetch extends Dyno {
  constructor({
    texture: texture2,
    coord,
    lod
  }) {
    const textureType = valType(texture2);
    super({
      inTypes: {
        texture: textureType,
        coord: textureSizeType(textureType),
        lod: "int"
      },
      outTypes: { texel: textureReturnType(textureType) },
      inputs: { texture: texture2, coord, lod },
      statements: ({ inputs, outputs }) => [
        `${outputs.texel} = texelFetch(${inputs.texture}, ${inputs.coord}, ${inputs.lod ?? "0"});`
      ]
    });
  }
  dynoOut() {
    return new DynoOutput(this, "texel");
  }
}
function textureSizeType(textureType) {
  switch (textureType) {
    case "sampler2D":
    case "usampler2D":
    case "isampler2D":
    case "samplerCube":
    case "usamplerCube":
    case "isamplerCube":
    case "sampler2DShadow":
    case "samplerCubeShadow":
      return "ivec2";
    case "sampler3D":
    case "usampler3D":
    case "isampler3D":
    case "sampler2DArray":
    case "usampler2DArray":
    case "isampler2DArray":
    case "sampler2DArrayShadow":
      return "ivec3";
    default:
      throw new Error(`Invalid texture type: ${textureType}`);
  }
}
function textureCoordType(textureType) {
  switch (textureType) {
    case "sampler2D":
    case "usampler2D":
    case "isampler2D":
      return "vec2";
    case "sampler3D":
    case "usampler3D":
    case "isampler3D":
    case "samplerCube":
    case "usamplerCube":
    case "isamplerCube":
    case "sampler2DArray":
    case "usampler2DArray":
    case "isampler2DArray":
    case "sampler2DShadow":
      return "vec3";
    case "samplerCubeShadow":
    case "sampler2DArrayShadow":
      return "vec4";
    default:
      throw new Error(`Invalid texture type: ${textureType}`);
  }
}
function textureReturnType(textureType) {
  switch (textureType) {
    case "sampler2D":
    case "sampler2DArray":
    case "sampler3D":
    case "samplerCube":
    case "sampler2DShadow":
      return "vec4";
    case "usampler2D":
    case "usampler2DArray":
    case "usampler3D":
    case "usamplerCube":
      return "uvec4";
    case "isampler2D":
    case "isampler2DArray":
    case "isampler3D":
    case "isamplerCube":
      return "ivec4";
    case "samplerCubeShadow":
    case "sampler2DArrayShadow":
      return "float";
    default:
      throw new Error(`Invalid texture type: ${textureType}`);
  }
}
const radians = (degrees2) => new Radians({ degrees: degrees2 });
const degrees = (radians2) => new Degrees({ radians: radians2 });
const sin = (radians2) => new Sin({ radians: radians2 });
const cos = (radians2) => new Cos({ radians: radians2 });
const tan = (radians2) => new Tan({ radians: radians2 });
const asin = (sin2) => new Asin({ sin: sin2 });
const acos = (cos2) => new Acos({ cos: cos2 });
const atan = (tan2) => new Atan({ tan: tan2 });
const atan2 = (y, x) => new Atan2({ y, x });
const sinh = (x) => new Sinh({ x });
const cosh = (x) => new Cosh({ x });
const tanh = (x) => new Tanh({ x });
const asinh = (x) => new Asinh({ x });
const acosh = (x) => new Acosh({ x });
const atanh = (x) => new Atanh({ x });
class Radians extends UnaryOp {
  constructor({ degrees: degrees2 }) {
    super({ a: degrees2, outTypeFunc: (aType) => aType, outKey: "radians" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.radians} = radians(${inputs.a});`
    ];
  }
}
class Degrees extends UnaryOp {
  constructor({ radians: radians2 }) {
    super({ a: radians2, outTypeFunc: (aType) => aType, outKey: "degrees" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.degrees} = degrees(${inputs.a});`
    ];
  }
}
class Sin extends UnaryOp {
  constructor({ radians: radians2 }) {
    super({ a: radians2, outTypeFunc: (aType) => aType, outKey: "sin" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.sin} = sin(${inputs.a});`
    ];
  }
}
class Cos extends UnaryOp {
  constructor({ radians: radians2 }) {
    super({ a: radians2, outTypeFunc: (aType) => aType, outKey: "cos" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.cos} = cos(${inputs.a});`
    ];
  }
}
class Tan extends UnaryOp {
  constructor({ radians: radians2 }) {
    super({ a: radians2, outTypeFunc: (aType) => aType, outKey: "tan" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.tan} = tan(${inputs.a});`
    ];
  }
}
class Asin extends UnaryOp {
  constructor({ sin: sin2 }) {
    super({ a: sin2, outTypeFunc: (aType) => aType, outKey: "asin" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.asin} = asin(${inputs.a});`
    ];
  }
}
class Acos extends UnaryOp {
  constructor({ cos: cos2 }) {
    super({ a: cos2, outTypeFunc: (aType) => aType, outKey: "acos" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.acos} = acos(${inputs.a});`
    ];
  }
}
class Atan extends UnaryOp {
  constructor({ tan: tan2 }) {
    super({ a: tan2, outTypeFunc: (aType) => aType, outKey: "atan" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.atan} = atan(${inputs.a});`
    ];
  }
}
class Atan2 extends BinaryOp {
  constructor({ y, x }) {
    super({
      a: y,
      b: x,
      outTypeFunc: (aType, bType) => aType,
      outKey: "atan2"
    });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.atan2} = atan2(${inputs.a}, ${inputs.b});`
    ];
  }
}
class Sinh extends UnaryOp {
  constructor({ x }) {
    super({ a: x, outTypeFunc: (aType) => aType, outKey: "sinh" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.sinh} = sinh(${inputs.a});`
    ];
  }
}
class Cosh extends UnaryOp {
  constructor({ x }) {
    super({ a: x, outTypeFunc: (aType) => aType, outKey: "cosh" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.cosh} = cosh(${inputs.a});`
    ];
  }
}
class Tanh extends UnaryOp {
  constructor({ x }) {
    super({ a: x, outTypeFunc: (aType) => aType, outKey: "tanh" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.tanh} = tanh(${inputs.a});`
    ];
  }
}
class Asinh extends UnaryOp {
  constructor({ x }) {
    super({ a: x, outTypeFunc: (aType) => aType, outKey: "asinh" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.asinh} = asinh(${inputs.a});`
    ];
  }
}
class Acosh extends UnaryOp {
  constructor({ x }) {
    super({ a: x, outTypeFunc: (aType) => aType, outKey: "acosh" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.acosh} = acosh(${inputs.a});`
    ];
  }
}
class Atanh extends UnaryOp {
  constructor({ x }) {
    super({ a: x, outTypeFunc: (aType) => aType, outKey: "atanh" });
    this.statements = ({ inputs, outputs }) => [
      `${outputs.atanh} = atanh(${inputs.a});`
    ];
  }
}
const dyno = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  Abs,
  Acos,
  Acosh,
  Add,
  All,
  And,
  Any,
  Asin,
  Asinh,
  Atan,
  Atan2,
  Atanh,
  BVec2,
  BVec3,
  BVec4,
  BinaryOp,
  Bool,
  Ceil,
  Clamp,
  Combine,
  CombineCovSplat,
  CombineGsplat,
  CompMult,
  CompXor,
  Compilation,
  Cos,
  Cosh,
  CovSplat,
  Cross,
  DebugColorHue,
  Degrees,
  Determinant,
  Distance,
  Div,
  Dot,
  Dyno,
  DynoBlock,
  DynoBool,
  DynoBvec2,
  DynoBvec3,
  DynoBvec4,
  DynoConst,
  DynoFloat,
  DynoInt,
  DynoIsampler2D,
  DynoIsampler2DArray,
  DynoIsampler3D,
  DynoIsamplerCube,
  DynoIvec2,
  DynoIvec3,
  DynoIvec4,
  DynoLiteral,
  DynoMat2,
  DynoMat2x2,
  DynoMat2x3,
  DynoMat2x4,
  DynoMat3,
  DynoMat3x2,
  DynoMat3x3,
  DynoMat3x4,
  DynoMat4,
  DynoMat4x2,
  DynoMat4x3,
  DynoMat4x4,
  DynoOutput,
  DynoProgram,
  DynoProgramTemplate,
  DynoRemapIndex,
  DynoSampler2D,
  DynoSampler2DArray,
  DynoSampler2DArrayShadow,
  DynoSampler2DShadow,
  DynoSampler3D,
  DynoSamplerCube,
  DynoSamplerCubeShadow,
  DynoUint,
  DynoUniform,
  DynoUsampler2D,
  DynoUsampler2DArray,
  DynoUsampler3D,
  DynoUsamplerCube,
  DynoUvec2,
  DynoUvec3,
  DynoUvec4,
  DynoValue,
  DynoVec2,
  DynoVec3,
  DynoVec4,
  Equal,
  Exp,
  Exp2,
  ExtendVec,
  FaceForward,
  Float,
  FloatBitsToInt,
  FloatBitsToUint,
  Floor,
  Fract,
  GreaterThan,
  GreaterThanEqual,
  Gsplat,
  GsplatNormal,
  GsplatToCovSplat,
  Hash,
  Hash2,
  Hash3,
  Hash4,
  HashFloat,
  HashVec2,
  HashVec3,
  HashVec4,
  IMod,
  IVec2,
  IVec3,
  IVec4,
  Int,
  IntBitsToFloat,
  Inverse,
  InverseSqrt,
  IsInf,
  IsNan,
  Length,
  LessThan,
  LessThanEqual,
  Log,
  Log2,
  Mat2,
  Mat3,
  Mat4,
  Max,
  Min,
  Mix,
  Mod,
  Modf,
  Mul,
  Neg,
  Normalize,
  NormalizedDepth,
  Not,
  NotEqual,
  NumCovSplats,
  NumExtSplats,
  NumPackedSplats,
  Or,
  Outer,
  OutputCovSplat,
  OutputExtCovSplat,
  OutputExtendedSplat,
  OutputPackedSplat,
  OutputRgba8,
  PackHalf2x16,
  PackSnorm2x16,
  PackUnorm2x16,
  PcgHash,
  PcgMix,
  PcgNext,
  Pow,
  ProjectH,
  Radians,
  ReadCovSplat,
  ReadExtSplat,
  ReadPackedSplat,
  ReadPackedSplatRange,
  ReflectVec,
  RefractVec,
  Round,
  Select,
  Shl,
  Shr,
  Sign,
  SimpleCast,
  Sin,
  Sinh,
  Smoothstep,
  SplatTexCoord,
  Split,
  SplitCovSplat,
  SplitGsplat,
  Sqr,
  Sqrt,
  Step,
  Sub,
  Swizzle,
  TCovSplats,
  TExtSplats,
  TPackedSplats,
  Tan,
  Tanh,
  TexelFetch,
  Texture,
  TextureSize,
  TransformDir,
  TransformGsplat,
  TransformPosition,
  TransformQuaternion,
  Transpose,
  TrinaryOp,
  Trunc,
  UVec2,
  UVec3,
  UVec4,
  Uint,
  UintBitsToFloat,
  UintToRgba8,
  UnaryOp,
  UnpackHalf2x16,
  UnpackSnorm2x16,
  UnpackUnorm2x16,
  Vec2,
  Vec3,
  Vec4,
  Xor,
  abs,
  acos,
  acosh,
  add,
  all,
  and,
  any,
  arrayIndex,
  arrayLength,
  asin,
  asinh,
  atan,
  atan2,
  atanh,
  bool,
  bvec2,
  bvec3,
  bvec4,
  ceil,
  clamp,
  combine,
  combineCovSplat,
  combineGsplat,
  comment,
  compMult,
  compXor,
  cos,
  cosh,
  cross,
  debugColorHue,
  defineCovSplat,
  defineExtSplats,
  defineGsplat,
  defineGsplatNormal,
  definePackedSplats,
  degrees,
  determinant,
  distance,
  div,
  dot,
  dyno: dyno$1,
  dynoBlock,
  dynoBool,
  dynoBvec2,
  dynoBvec3,
  dynoBvec4,
  dynoConst,
  dynoDeclare,
  dynoFloat,
  dynoFor,
  dynoIf,
  dynoInt,
  dynoIsampler2D,
  dynoIsampler2DArray,
  dynoIsampler3D,
  dynoIsamplerCube,
  dynoIvec2,
  dynoIvec3,
  dynoIvec4,
  dynoLiteral,
  dynoMat2,
  dynoMat2x2,
  dynoMat2x3,
  dynoMat2x4,
  dynoMat3,
  dynoMat3x2,
  dynoMat3x3,
  dynoMat3x4,
  dynoMat4,
  dynoMat4x2,
  dynoMat4x3,
  dynoMat4x4,
  dynoSampler2D,
  dynoSampler2DArray,
  dynoSampler2DArrayShadow,
  dynoSampler2DShadow,
  dynoSampler3D,
  dynoSamplerCube,
  dynoSamplerCubeShadow,
  dynoSwitch,
  dynoUint,
  dynoUsampler2D,
  dynoUsampler2DArray,
  dynoUsampler3D,
  dynoUsamplerCube,
  dynoUvec2,
  dynoUvec3,
  dynoUvec4,
  dynoVec2,
  dynoVec3,
  dynoVec4,
  equal,
  exp,
  exp2,
  extendVec,
  faceforward,
  float,
  floatBitsToInt,
  floatBitsToUint,
  floor,
  fract,
  greaterThan,
  greaterThanEqual,
  gsplatNormal,
  gsplatToCovSplat,
  hash,
  hash2,
  hash3,
  hash4,
  hashFloat,
  hashVec2,
  hashVec3,
  hashVec4,
  imod,
  int,
  intBitsToFloat,
  inverse,
  inversesqrt,
  isAllFloatType,
  isBoolType,
  isFloatType,
  isInf,
  isIntType,
  isMat2,
  isMat3,
  isMat4,
  isMatFloatType,
  isNan,
  isScalarType,
  isUintType,
  isVector2Type,
  isVector3Type,
  isVector4Type,
  isVectorType,
  ivec2,
  ivec3,
  ivec4,
  length,
  lessThan,
  lessThanEqual,
  literalNegOne,
  literalOne,
  literalZero,
  log,
  log2,
  mat2,
  mat3,
  mat4,
  max,
  min,
  mix,
  mod,
  modf,
  mul,
  neg,
  normalize,
  normalizedDepth,
  not,
  notEqual,
  numCovSplats,
  numExtSplats,
  numPackedSplats,
  numberAsFloat,
  numberAsInt,
  numberAsUint,
  or,
  outer,
  outputCovSplat,
  outputCovSplatDepth,
  outputExtCovSplat,
  outputExtendedSplat,
  outputPackedSplat,
  outputRgba8,
  outputSplatDepth,
  packHalf2x16,
  packSnorm2x16,
  packUnorm2x16,
  pcgHash,
  pcgMix,
  pcgNext,
  pow,
  projectH,
  radians,
  readCovSplat,
  readExtSplat,
  readPackedSplat,
  readPackedSplatRange,
  reflectVec,
  refractVec,
  remapIndex,
  round,
  sameSizeIvec,
  sameSizeUvec,
  sameSizeVec,
  select,
  shl,
  shr,
  sign,
  sin,
  sinh,
  smoothstep,
  splatTexCoord,
  split,
  splitCovSplat,
  splitGsplat,
  sqr,
  sqrt,
  step,
  sub,
  swizzle,
  tan,
  tanh,
  texelFetch,
  texture,
  textureSize,
  transformDir,
  transformGsplat,
  transformPos,
  transformQuat,
  transpose,
  trunc,
  typeLiteral,
  uint,
  uintBitsToFloat,
  uintToRgba8,
  uniform,
  unindent,
  unindentLines,
  unpackHalf2x16,
  unpackSnorm2x16,
  unpackUnorm2x16,
  uvec2,
  uvec3,
  uvec4,
  valType,
  vec2,
  vec3,
  vec4,
  vectorDim,
  vectorElementType,
  xor
}, Symbol.toStringTag, { value: "Module" }));
var computeUvec4_default = "precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\nprecision highp isampler2D;\nprecision highp sampler2DArray;\nprecision highp usampler2DArray;\nprecision highp isampler2DArray;\nprecision highp sampler3D;\nprecision highp usampler3D;\nprecision highp isampler3D;\n\n#include <splatDefines>\n\nuniform uint targetLayer;\nuniform int targetBase;\nuniform int targetCount;\n\nout uvec4 target;\n\n{{ GLOBALS }}\n\nvoid produceSplat(int _index) {\n    {{ STATEMENTS }}\n}\n\nvoid main() {\n    int targetIndex = int(targetLayer << SPLAT_TEX_LAYER_BITS) + int(uint(gl_FragCoord.y) << SPLAT_TEX_WIDTH_BITS) + int(gl_FragCoord.x);\n    int index = targetIndex - targetBase;\n\n    target = uvec4(0u, 0u, 0u, 0u);\n    if ((index >= 0) && (index < targetCount)) {\n        produceSplat(index);\n    }\n}";
var computeUvec4_Vec4_default = "precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\nprecision highp isampler2D;\nprecision highp sampler2DArray;\nprecision highp usampler2DArray;\nprecision highp isampler2DArray;\nprecision highp sampler3D;\nprecision highp usampler3D;\nprecision highp isampler3D;\n\n#include <splatDefines>\n\nuniform uint targetLayer;\nuniform int targetBase;\nuniform int targetCount;\n\nlayout(location = 0) out uvec4 target;\nlayout(location = 1) out vec4 target3;\n\n{{ GLOBALS }}\n\nvoid produceSplat(int _index) {\n    {{ STATEMENTS }}\n}\n\nvoid main() {\n    int targetIndex = int(targetLayer << SPLAT_TEX_LAYER_BITS) + int(uint(gl_FragCoord.y) << SPLAT_TEX_WIDTH_BITS) + int(gl_FragCoord.x);\n    int index = targetIndex - targetBase;\n\n    \n    target = uvec4(0u, 0u, 0u, 0u);\n\n    \n    target3 = floatToVec4(1.0 / 0.0);\n\n    if ((index >= 0) && (index < targetCount)) {\n        produceSplat(index);\n    }\n}";
var computeUvec4x2_Vec4_default = "precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\nprecision highp isampler2D;\nprecision highp sampler2DArray;\nprecision highp usampler2DArray;\nprecision highp isampler2DArray;\nprecision highp sampler3D;\nprecision highp usampler3D;\nprecision highp isampler3D;\n\n#include <splatDefines>\n\nuniform uint targetLayer;\nuniform int targetBase;\nuniform int targetCount;\n\nlayout(location = 0) out uvec4 target;\nlayout(location = 1) out uvec4 target2;\nlayout(location = 2) out vec4 target3;\n\n{{ GLOBALS }}\n\nvoid produceSplat(int _index) {\n    {{ STATEMENTS }}\n}\n\nvoid main() {\n    int targetIndex = int(targetLayer << SPLAT_TEX_LAYER_BITS) + int(uint(gl_FragCoord.y) << SPLAT_TEX_WIDTH_BITS) + int(gl_FragCoord.x);\n    int index = targetIndex - targetBase;\n\n    \n    target = uvec4(0u, 0u, 0u, 0u);\n    target2 = uvec4(0u, 0u, 0u, 0u);\n\n    \n    target3 = floatToVec4(1.0 / 0.0);\n\n    if ((index >= 0) && (index < targetCount)) {\n        produceSplat(index);\n    }\n}";
var computeVec4_default = "precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\nprecision highp isampler2D;\nprecision highp sampler2DArray;\nprecision highp usampler2DArray;\nprecision highp isampler2DArray;\nprecision highp sampler3D;\nprecision highp usampler3D;\nprecision highp isampler3D;\n\n#include <splatDefines>\n\nuniform uint targetLayer;\nuniform int targetBase;\nuniform int targetCount;\n\nout vec4 target;\n\n{{ GLOBALS }}\n\nvoid computeReadback(int _index) {\n    {{ STATEMENTS }}\n}\n\nvoid main() {\n    int targetIndex = int(targetLayer << SPLAT_TEX_LAYER_BITS) + int(uint(gl_FragCoord.y) << SPLAT_TEX_WIDTH_BITS) + int(gl_FragCoord.x);\n    int index = targetIndex - targetBase;\n\n    if ((index >= 0) && (index < targetCount)) {\n        computeReadback(index);\n    } else {\n        target = vec4(0.0, 0.0, 0.0, 0.0);\n    }\n}";
var splatDefines_default = "const float LN_SCALE_MIN = -12.0;\nconst float LN_SCALE_MAX = 9.0;\n\nconst uint SPLAT_TEX_WIDTH_BITS = 11u;\nconst uint SPLAT_TEX_HEIGHT_BITS = 11u;\nconst uint SPLAT_TEX_DEPTH_BITS = 11u;\nconst uint SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;\n\nconst uint SPLAT_TEX_WIDTH = 1u << SPLAT_TEX_WIDTH_BITS;\nconst uint SPLAT_TEX_HEIGHT = 1u << SPLAT_TEX_HEIGHT_BITS;\nconst uint SPLAT_TEX_DEPTH = 1u << SPLAT_TEX_DEPTH_BITS;\n\nconst uint SPLAT_TEX_WIDTH_MASK = SPLAT_TEX_WIDTH - 1u;\nconst uint SPLAT_TEX_HEIGHT_MASK = SPLAT_TEX_HEIGHT - 1u;\nconst uint SPLAT_TEX_DEPTH_MASK = SPLAT_TEX_DEPTH - 1u;\n\nconst uint F16_INF = 0x7c00u;\nconst float PI = 3.1415926535897932384626433832795;\n\nconst float INFINITY = 1.0 / 0.0;\nconst float NEG_INFINITY = -INFINITY;\n\nfloat sqr(float x) {\n    return x * x;\n}\n\nfloat pow4(float x) {\n    float x2 = x * x;\n    return x2 * x2;\n}\n\nfloat pow8(float x) {\n    float x4 = pow4(x);\n    return x4 * x4;\n}\n\nvec3 srgbToLinear(vec3 rgb) {\n    return pow(rgb, vec3(2.2));\n}\n\nvec3 linearToSrgb(vec3 rgb) {\n    return pow(rgb, vec3(1.0 / 2.2));\n}\n\nuint encodeQuatOctXy88R8(vec4 q) {\n    \n    if (q.w < 0.0) {\n        q = -q;\n    }\n    \n    float theta = 2.0 * acos(q.w);\n    float halfTheta = theta * 0.5;\n    float s = sin(halfTheta);\n    \n    vec3 axis = (abs(s) < 1e-6) ? vec3(1.0, 0.0, 0.0) : q.xyz / s;\n    \n    \n    \n    float sum = abs(axis.x) + abs(axis.y) + abs(axis.z);\n    vec2 p = vec2(axis.x, axis.y) / sum;\n    \n    if (axis.z < 0.0) {\n        float oldPx = p.x;\n        p.x = (1.0 - abs(p.y)) * (p.x >= 0.0 ? 1.0 : -1.0);\n        p.y = (1.0 - abs(oldPx)) * (p.y >= 0.0 ? 1.0 : -1.0);\n    }\n    \n    float u_f = p.x * 0.5 + 0.5;\n    float v_f = p.y * 0.5 + 0.5;\n    \n    uint quantU = uint(clamp(round(u_f * 255.0), 0.0, 255.0));\n    uint quantV = uint(clamp(round(v_f * 255.0), 0.0, 255.0));\n    \n    \n    \n    uint angleInt = uint(clamp(round((theta / 3.14159265359) * 255.0), 0.0, 255.0));\n    \n    \n    return (angleInt << 16u) | (quantV << 8u) | quantU;\n}\n\nvec4 decodeQuatOctXy88R8(uint encoded) {\n    \n    uint quantU = encoded & uint(0xFFu);               \n    uint quantV = (encoded >> 8u) & uint(0xFFu);         \n    uint angleInt = encoded >> 16u;                      \n\n    \n    float u_f = float(quantU) / 255.0;\n    float v_f = float(quantV) / 255.0;\n    vec2 f = vec2(u_f * 2.0 - 1.0, v_f * 2.0 - 1.0);\n\n    vec3 axis = vec3(f.xy, 1.0 - abs(f.x) - abs(f.y));\n    float t = max(-axis.z, 0.0);\n    axis.x += (axis.x >= 0.0) ? -t : t;\n    axis.y += (axis.y >= 0.0) ? -t : t;\n    axis = normalize(axis);\n    \n    \n    float theta = (float(angleInt) / 255.0) * 3.14159265359;\n    float halfTheta = theta * 0.5;\n    float s = sin(halfTheta);\n    float w = cos(halfTheta);\n    \n    return vec4(axis * s, w);\n}\n\nuint encodeQuatOctXy1010R12(vec4 q) {\n    \n    if (q.w < 0.0) {\n        q = -q;\n    }\n    \n    float halfTheta = acos(q.w);\n    float theta = 2.0 * halfTheta;\n    float s = sin(halfTheta);\n    \n    vec3 axis = (abs(s) < 1e-6) ? vec3(1.0, 0.0, 0.0) : q.xyz / s;\n    \n    \n    \n    float sum = abs(axis.x) + abs(axis.y) + abs(axis.z);\n    vec2 p = vec2(axis.x, axis.y) / sum;\n    \n    if (axis.z < 0.0) {\n        float oldPx = p.x;\n        p.x = (1.0 - abs(p.y)) * (p.x >= 0.0 ? 1.0 : -1.0);\n        p.y = (1.0 - abs(oldPx)) * (p.y >= 0.0 ? 1.0 : -1.0);\n    }\n    \n    float u_f = p.x * 0.5 + 0.5;\n    float v_f = p.y * 0.5 + 0.5;\n    \n    uint quantU = uint(clamp(round(u_f * 1023.0), 0.0, 1023.0));\n    uint quantV = uint(clamp(round(v_f * 1023.0), 0.0, 1023.0));\n    \n    \n    \n    uint angleInt = uint(clamp(round((theta / PI) * 4095.0), 0.0, 4095.0));\n    \n    \n    return (angleInt << 20u) | (quantV << 10u) | quantU;\n}\n\nvec4 decodeQuatOctXy1010R12(uint encoded) {\n    \n    uint quantU = encoded & uint(0x3FFu);               \n    uint quantV = (encoded >> 10u) & uint(0x3FFu);         \n    uint angleInt = encoded >> 20u;                      \n\n    \n    float u_f = float(quantU) / 1023.0;\n    float v_f = float(quantV) / 1023.0;\n    vec2 f = vec2(u_f * 2.0 - 1.0, v_f * 2.0 - 1.0);\n\n    vec3 axis = vec3(f.xy, 1.0 - abs(f.x) - abs(f.y));\n    float t = max(-axis.z, 0.0);\n    axis.x += (axis.x >= 0.0) ? -t : t;\n    axis.y += (axis.y >= 0.0) ? -t : t;\n    axis = normalize(axis);\n    \n    \n    float theta = (float(angleInt) / 4095.0) * PI;\n    float halfTheta = theta * 0.5;\n    float s = sin(halfTheta);\n    float w = cos(halfTheta);\n    \n    return vec4(axis * s, w);\n}\n\nuvec4 packSplatEncoding(\n    vec3 center, vec3 scales, vec4 quaternion, vec4 rgba, vec4 rgbMinMaxLnScaleMinMax\n) {\n    float rgbMin = rgbMinMaxLnScaleMinMax.x;\n    float rgbMax = rgbMinMaxLnScaleMinMax.y;\n    vec3 encRgb = (rgba.rgb - vec3(rgbMin)) / (rgbMax - rgbMin);\n    uvec4 uRgba = uvec4(round(clamp(vec4(encRgb, rgba.a) * 255.0, 0.0, 255.0)));\n\n    uint uQuat = encodeQuatOctXy88R8(quaternion);\n    \n    \n    uvec3 uQuat3 = uvec3(uQuat & 0xffu, (uQuat >> 8u) & 0xffu, (uQuat >> 16u) & 0xffu);\n\n    \n    float lnScaleMin = rgbMinMaxLnScaleMinMax.z;\n    float lnScaleMax = rgbMinMaxLnScaleMinMax.w;\n    float lnScaleScale = 254.0 / (lnScaleMax - lnScaleMin);\n    uvec3 uScales = uvec3(\n        (scales.x == 0.0) ? 0u : uint(round(clamp((log(scales.x) - lnScaleMin) * lnScaleScale, 0.0, 254.0))) + 1u,\n        (scales.y == 0.0) ? 0u : uint(round(clamp((log(scales.y) - lnScaleMin) * lnScaleScale, 0.0, 254.0))) + 1u,\n        (scales.z == 0.0) ? 0u : uint(round(clamp((log(scales.z) - lnScaleMin) * lnScaleScale, 0.0, 254.0))) + 1u\n    );\n\n    \n    uint word0 = uRgba.r | (uRgba.g << 8u) | (uRgba.b << 16u) | (uRgba.a << 24u);\n    uint word1 = packHalf2x16(center.xy);\n    uint word2 = packHalf2x16(vec2(center.z, 0.0)) | (uQuat3.x << 16u) | (uQuat3.y << 24u);\n    uint word3 = uScales.x | (uScales.y << 8u) | (uScales.z << 16u) | (uQuat3.z << 24u);\n    return uvec4(word0, word1, word2, word3);\n}\n\nuvec4 packSplat(vec3 center, vec3 scales, vec4 quaternion, vec4 rgba) {\n    return packSplatEncoding(center, scales, quaternion, rgba, vec4(0.0, 1.0, LN_SCALE_MIN, LN_SCALE_MAX));\n}\n\nvoid unpackSplatEncoding(uvec4 packedData, out vec3 center, out vec3 scales, out vec4 quaternion, out vec4 rgba, vec4 rgbMinMaxLnScaleMinMax) {\n    uint word0 = packedData.x, word1 = packedData.y, word2 = packedData.z, word3 = packedData.w;\n\n    uvec4 uRgba = uvec4(word0 & 0xffu, (word0 >> 8u) & 0xffu, (word0 >> 16u) & 0xffu, (word0 >> 24u) & 0xffu);\n    float rgbMin = rgbMinMaxLnScaleMinMax.x;\n    float rgbMax = rgbMinMaxLnScaleMinMax.y;\n    rgba = (vec4(uRgba) / 255.0);\n    rgba.rgb = rgba.rgb * (rgbMax - rgbMin) + rgbMin;\n\n    center = vec4(\n        unpackHalf2x16(word1),\n        unpackHalf2x16(word2 & 0xffffu)\n    ).xyz;\n\n    uvec3 uScales = uvec3(word3 & 0xffu, (word3 >> 8u) & 0xffu, (word3 >> 16u) & 0xffu);\n    float lnScaleMin = rgbMinMaxLnScaleMinMax.z;\n    float lnScaleMax = rgbMinMaxLnScaleMinMax.w;\n    float lnScaleScale = (lnScaleMax - lnScaleMin) / 254.0;\n    scales = vec3(\n        (uScales.x == 0u) ? 0.0 : exp(lnScaleMin + float(uScales.x - 1u) * lnScaleScale),\n        (uScales.y == 0u) ? 0.0 : exp(lnScaleMin + float(uScales.y - 1u) * lnScaleScale),\n        (uScales.z == 0u) ? 0.0 : exp(lnScaleMin + float(uScales.z - 1u) * lnScaleScale)\n    );\n\n    uint uQuat = ((word2 >> 16u) & 0xFFFFu) | ((word3 >> 8u) & 0xFF0000u);\n    quaternion = decodeQuatOctXy88R8(uQuat);\n    \n    \n}\n\nvoid unpackSplat(uvec4 packedData, out vec3 center, out vec3 scales, out vec4 quaternion, out vec4 rgba) {\n    unpackSplatEncoding(packedData, center, scales, quaternion, rgba, vec4(0.0, 1.0, LN_SCALE_MIN, LN_SCALE_MAX));\n}\n\nuvec4 packSplatCovEncoding(\n    vec3 center, vec4 rgba, vec3 xxyyzz, vec3 xyxzyz, vec4 rgbMinMaxLnScaleMinMax\n) {\n    float rgbMin = rgbMinMaxLnScaleMinMax.x;\n    float rgbMax = rgbMinMaxLnScaleMinMax.y;\n    vec3 encRgb = (rgba.rgb - vec3(rgbMin)) / (rgbMax - rgbMin);\n    uvec4 uRgba = uvec4(round(clamp(vec4(encRgb, rgba.a) * 255.0, 0.0, 255.0)));\n\n    float lnScaleMin = rgbMinMaxLnScaleMinMax.z;\n    float lnScaleMax = rgbMinMaxLnScaleMinMax.w;\n    float diagScale = 255.0 / (2.0 * (lnScaleMax - lnScaleMin));\n    uvec3 uXxyyzz = uvec3(round(clamp((log(xxyyzz) - 2.0 * lnScaleMin) * diagScale, 0.0, 255.0)));\n\n    vec3 xyxzyzCor = vec3(\n        clamp(xyxzyz.x / sqrt(xxyyzz.x * xxyyzz.y), -1.0, 1.0),\n        clamp(xyxzyz.y / sqrt(xxyyzz.x * xxyyzz.z), -1.0, 1.0),\n        clamp(xyxzyz.z / sqrt(xxyyzz.y * xxyyzz.z), -1.0, 1.0)\n    );\n    ivec3 iXyxzyzCor = ivec3(round(xyxzyzCor * 127.0));\n\n    \n    uint word0 = uRgba.r | (uRgba.g << 8u) | (uRgba.b << 16u) | (uRgba.a << 24u);\n    uint word1 = packHalf2x16(center.xy);\n    uint word2 = packHalf2x16(vec2(center.z, 0.0)) |\n        ((uint(iXyxzyzCor.y) & 0xffu) << 16u) |\n        ((uint(iXyxzyzCor.z) & 0xffu) << 24u);\n    uint word3 =\n        uXxyyzz.x | (uXxyyzz.y << 8u) | (uXxyyzz.z << 16u) |\n        ((uint(iXyxzyzCor.x) & 0xffu) << 24u);\n    return uvec4(word0, word1, word2, word3);\n}\n\nvoid unpackSplatCovEncoding(uvec4 packedData, out vec3 center, out vec4 rgba, out vec3 xxyyzz, out vec3 xyxzyz, vec4 rgbMinMaxLnScaleMinMax) {\n    uint word0 = packedData.x, word1 = packedData.y, word2 = packedData.z, word3 = packedData.w;\n\n    uvec4 uRgba = uvec4(word0 & 0xffu, (word0 >> 8u) & 0xffu, (word0 >> 16u) & 0xffu, (word0 >> 24u) & 0xffu);\n    float rgbMin = rgbMinMaxLnScaleMinMax.x;\n    float rgbMax = rgbMinMaxLnScaleMinMax.y;\n    rgba = (vec4(uRgba) / 255.0);\n    rgba.rgb = rgba.rgb * (rgbMax - rgbMin) + rgbMin;\n\n    center = vec3(\n        unpackHalf2x16(word1),\n        unpackHalf2x16(word2 & 0xffffu).x\n    );\n\n    uvec3 uXxyyzz = uvec3(word3 & 0xffu, (word3 >> 8u) & 0xffu, (word3 >> 16u) & 0xffu);\n    ivec3 iXyxzyzCor = ivec3(int(word3) >> 24, int(word2 << 8u) >> 24, int(word2) >> 24);\n\n    float lnScaleMin = rgbMinMaxLnScaleMinMax.z;\n    float lnScaleMax = rgbMinMaxLnScaleMinMax.w;\n    float diagScale = 2.0 * (lnScaleMax - lnScaleMin) / 255.0;\n    xxyyzz = exp(2.0 * lnScaleMin + vec3(uXxyyzz) * diagScale);\n\n    vec3 xyxzyzCor = vec3(iXyxzyzCor) / 127.0;\n    xyxzyz = xyxzyzCor * vec3(\n        sqrt(xxyyzz.x * xxyyzz.y),\n        sqrt(xxyyzz.x * xxyyzz.z),\n        sqrt(xxyyzz.y * xxyyzz.z)\n    );\n}\n\nvoid packSplatExtCov(\n    out uvec4 packedData, out uvec4 packedData2,\n    vec3 center, vec4 rgba, vec3 xxyyzz, vec3 xyxzyz\n) {\n    packedData.x = floatBitsToUint(center.x);\n    packedData.y = floatBitsToUint(center.y);\n    packedData.z = floatBitsToUint(center.z);\n    packedData.w = packHalf2x16(vec2(rgba.a, rgba.b));\n    packedData2.x = packHalf2x16(rgba.rg);\n\n    vec3 xyxzyzCor = vec3(\n        clamp(xyxzyz.x / sqrt(xxyyzz.x * xxyyzz.y), -1.0, 1.0),\n        clamp(xyxzyz.y / sqrt(xxyyzz.x * xxyyzz.z), -1.0, 1.0),\n        clamp(xyxzyz.z / sqrt(xxyyzz.y * xxyyzz.z), -1.0, 1.0)\n    );\n    xyxzyzCor = sign(xyxzyzCor) * clamp(log(abs(xyxzyzCor)), -100.0, -0.0000001);\n    xxyyzz = log(xxyyzz);\n\n    packedData2.y = packHalf2x16(vec2(xxyyzz.x, xxyyzz.y));\n    packedData2.z = packHalf2x16(vec2(xxyyzz.z, xyxzyzCor.x));\n    packedData2.w = packHalf2x16(vec2(xyxzyzCor.y, xyxzyzCor.z));\n}\n\nvoid unpackSplatExtCov(\n    uvec4 packedData, uvec4 packedData2,\n    out vec3 center, out vec4 rgba, out vec3 xxyyzz, out vec3 xyxzyz\n) {\n    center.x = uintBitsToFloat(packedData.x);\n    center.y = uintBitsToFloat(packedData.y);\n    center.z = uintBitsToFloat(packedData.z);\n\n    vec2 ab = unpackHalf2x16(packedData.w);\n    vec2 rg = unpackHalf2x16(packedData2.x);\n    rgba = vec4(rg, ab.y, ab.x);\n\n    vec2 xxyy = unpackHalf2x16(packedData2.y);\n    vec2 zzxy = unpackHalf2x16(packedData2.z);\n    vec2 xzyz = unpackHalf2x16(packedData2.w);\n    xxyyzz = exp(vec3(xxyy.x, xxyy.y, zzxy.x));\n    xyxzyz = vec3(zzxy.y, xzyz.x, xzyz.y);\n    xyxzyz = -sign(xyxzyz) * exp(-abs(xyxzyz));\n    xyxzyz *= vec3(\n        sqrt(xxyyzz.x * xxyyzz.y),\n        sqrt(xxyyzz.x * xxyyzz.z),\n        sqrt(xxyyzz.y * xxyyzz.z)\n    );\n}\n\nvoid packSplatExt(\n    out uvec4 packedData, out uvec4 packedData2,\n    vec3 center, vec3 scales, vec4 quaternion, vec4 rgba\n) {\n    packedData.x = floatBitsToUint(center.x);\n    packedData.y = floatBitsToUint(center.y);\n    packedData.z = floatBitsToUint(center.z);\n    packedData.w = packHalf2x16(vec2(rgba.a, 0.0));\n\n    packedData2.x = packHalf2x16(rgba.rg);\n    packedData2.y = packHalf2x16(vec2(rgba.b, log(scales.x)));\n    packedData2.z = packHalf2x16(log(scales.yz));\n    packedData2.w = encodeQuatOctXy1010R12(quaternion);\n}\n\nvec4 unpackSplatExtCenterAlpha(uvec4 packedData) {\n    return vec4(\n        uintBitsToFloat(packedData.x),\n        uintBitsToFloat(packedData.y),\n        uintBitsToFloat(packedData.z),\n        unpackHalf2x16(packedData.w).x\n    );\n}\n\nfloat unpackSplatExtAlpha(uvec4 packedData) {\n    return unpackHalf2x16(packedData.w).x;\n}\n\nvoid unpackSplatExt(\n    uvec4 packedData, uvec4 packedData2,\n    out vec3 center, out vec3 scales, out vec4 quaternion, out vec4 rgba\n) {\n    center.x = uintBitsToFloat(packedData.x);\n    center.y = uintBitsToFloat(packedData.y);\n    center.z = uintBitsToFloat(packedData.z);\n    rgba.a = unpackHalf2x16(packedData.w).x;\n\n    rgba.rg = unpackHalf2x16(packedData2.x);\n    vec2 split = unpackHalf2x16(packedData2.y);\n    rgba.b = split.x;\n    scales.x = exp(split.y);\n    scales.yz = exp(unpackHalf2x16(packedData2.z));\n    quaternion = decodeQuatOctXy1010R12(packedData2.w);\n}\n\nuint encodeExtRgb(vec3 rgb) {\n    vec3 absRgb = abs(rgb);\n    float maxAbs = max(absRgb.r, max(absRgb.g, absRgb.b));\n\n    int base = clamp(int(floor(log2(maxAbs))) + 15, 0, 31);\n    float divisor = exp2(float(base - 15)) / 255.0;\n\n    uvec3 uRgb = uvec3(round(clamp(absRgb / divisor, 0.0, 255.0)));\n    uint expSigns = (uint(base) << 3u) | ((rgb.r < 0.0 ? 0x1u : 0u) | (rgb.g < 0.0 ? 0x2u : 0u) | (rgb.b < 0.0 ? 0x4u : 0u));\n    return uRgb.r | (uRgb.g << 8u) | (uRgb.b << 16u) | (expSigns << 24u);\n}\n\nvec3 decodeExtRgb(uint encoded) {\n    uint biasedBase = (encoded >> 27u) & 0x1fu;\n    float divisor = exp2(float(int(biasedBase) - 15)) / 255.0;\n\n    vec3 rgb = vec3(uvec3(encoded & 0xffu, (encoded >> 8u) & 0xffu, (encoded >> 16u) & 0xffu));\n    rgb *= divisor;\n\n    return vec3(\n        ((encoded & 0x1000000u) != 0u) ? -rgb.r : rgb.r,\n        ((encoded & 0x2000000u) != 0u) ? -rgb.g : rgb.g,\n        ((encoded & 0x4000000u) != 0u) ? -rgb.b : rgb.b\n    );\n}\n\nvec3 quatVec(vec4 q, vec3 v) {\n    \n    vec3 t = 2.0 * cross(q.xyz, v);\n    return v + q.w * t + cross(q.xyz, t);\n}\n\nvec4 quatQuat(vec4 q1, vec4 q2) {\n    return vec4(\n        q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,\n        q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,\n        q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,\n        q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z\n    );\n}\n\nmat3 quaternionToMatrix(vec4 q) {\n    return mat3(\n        (1.0 - 2.0 * (q.y * q.y + q.z * q.z)),\n        (2.0 * (q.x * q.y + q.w * q.z)),\n        (2.0 * (q.x * q.z - q.w * q.y)),\n        (2.0 * (q.x * q.y - q.w * q.z)),\n        (1.0 - 2.0 * (q.x * q.x + q.z * q.z)),\n        (2.0 * (q.y * q.z + q.w * q.x)),\n        (2.0 * (q.x * q.z + q.w * q.y)),\n        (2.0 * (q.y * q.z - q.w * q.x)),\n        (1.0 - 2.0 * (q.x * q.x + q.y * q.y))\n    );\n}\n\nmat3 scaleQuaternionToMatrix(vec3 s, vec4 q) {\n    \n    return mat3(\n        s.x * (1.0 - 2.0 * (q.y * q.y + q.z * q.z)),\n        s.x * (2.0 * (q.x * q.y + q.w * q.z)),\n        s.x * (2.0 * (q.x * q.z - q.w * q.y)),\n        s.y * (2.0 * (q.x * q.y - q.w * q.z)),\n        s.y * (1.0 - 2.0 * (q.x * q.x + q.z * q.z)),\n        s.y * (2.0 * (q.y * q.z + q.w * q.x)),\n        s.z * (2.0 * (q.x * q.z + q.w * q.y)),\n        s.z * (2.0 * (q.y * q.z - q.w * q.x)),\n        s.z * (1.0 - 2.0 * (q.x * q.x + q.y * q.y))\n    );\n}\n\nvec4 slerp(vec4 q1, vec4 q2, float t) {\n    \n    float cosHalfTheta = dot(q1, q2);\n\n    \n    if (abs(cosHalfTheta) >= 0.999) {\n        return q1;\n    }\n    \n    \n    \n    if (cosHalfTheta < 0.0) {\n        q2 = -q2;\n        cosHalfTheta = -cosHalfTheta;\n    }\n\n    \n    float halfTheta = acos(cosHalfTheta);\n    float sinHalfTheta = sqrt(1.0 - cosHalfTheta * cosHalfTheta);\n\n    \n    float ratioA = sin((1.0 - t) * halfTheta) / sinHalfTheta;\n    float ratioB = sin(t * halfTheta) / sinHalfTheta;\n\n    \n    return q1 * ratioA + q2 * ratioB;\n}\n\nivec3 splatTexCoord(int index) {\n    uint x = uint(index) & SPLAT_TEX_WIDTH_MASK;\n    uint y = (uint(index) >> SPLAT_TEX_WIDTH_BITS) & SPLAT_TEX_HEIGHT_MASK;\n    uint z = uint(index) >> SPLAT_TEX_LAYER_BITS;\n    return ivec3(x, y, z);\n}\n\nvec4 uintToVec4(uint u32) {\n    uvec4 bytes = uvec4(\n        u32 & 0xFFu,\n        (u32 >> 8u) & 0xFFu,\n        (u32 >> 16u) & 0xFFu,\n        (u32 >> 24u) & 0xFFu\n    );\n    return vec4(bytes) / 255.0;\n}\n\nvec4 floatToVec4(float f) {\n    uint u32 = floatBitsToUint(f);\n    return uintToVec4(u32);\n}\n\nvec3 debugColorHue(uint i) {\n    \n    float hue = fract(float(i) * 0.61803398875);\n    \n    vec3 rgb = clamp(abs(mod(hue*6.0 + vec3(0.0,4.0,2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);\n    return mix(vec3(1.0), rgb, 0.85); \n}";
var splatFragment_default = "precision highp float;\nprecision highp int;\n\n#include <splatDefines>\n\nuniform float near;\nuniform float far;\nuniform bool encodeLinear;\nuniform float time;\nuniform bool debugFlag;\nuniform float maxStdDev;\nuniform float minAlpha;\nuniform bool disableFalloff;\nuniform float falloff;\n\nout vec4 fragColor;\n\nin vec4 vRgba;\nin vec2 vSplatUv;\nin vec3 vNdc;\nflat in uint vSplatIndex;\nflat in float adjustedStdDev;\n\n#include <logdepthbuf_pars_fragment>\n\nvoid main() {\n    vec4 rgba = vRgba;\n\n    float z2 = dot(vSplatUv, vSplatUv);\n    if (z2 > (adjustedStdDev * adjustedStdDev)) {\n        discard;\n    }\n\n    if (false) {\n    \n        float a = rgba.a;\n        float shifted = sqrt(z2) - max(0.0, a - 1.0);\n        float exponent = -0.5 * max(1.0, a) * sqr(max(0.0, shifted));\n        float min1a = min(1.0, a);\n        rgba.a = mix(min1a, min1a * exp(exponent), falloff);\n    } else {\n        \n        if (rgba.a <= 1.0) {\n            rgba.a = mix(rgba.a, rgba.a * exp(-0.5 * z2), falloff);\n        } else {\n            float a = exp((rgba.a*rgba.a - 1.0) / 2.718281828459045);\n            float alpha = 1.0 - pow(1.0 - exp(-0.5 * z2), a);\n            rgba.a = mix(1.0, alpha, falloff);\n        }\n    }\n\n    if (rgba.a < minAlpha) {\n        discard;\n    }\n    if (encodeLinear) {\n        rgba.rgb = srgbToLinear(rgba.rgb);\n    }\n\n    #ifdef PREMULTIPLIED_ALPHA\n        fragColor = vec4(rgba.rgb * rgba.a, rgba.a);\n    #else\n        fragColor = rgba;\n    #endif\n\n    #include <logdepthbuf_fragment>\n}";
var splatVertex_default = "precision highp float;\nprecision highp int;\nprecision highp usampler2DArray;\n\n#include <splatDefines>\n\nout vec4 vRgba;\nout vec2 vSplatUv;\nout vec3 vNdc;\nflat out uint vSplatIndex;\nflat out float adjustedStdDev;\n\nuniform vec2 renderSize;\nuniform vec4 renderToViewQuat;\nuniform vec3 renderToViewPos;\nuniform mat3 renderToViewBasis;\nuniform float maxStdDev;\nuniform float minPixelRadius;\nuniform float maxPixelRadius;\nuniform bool enableExtSplats;\nuniform bool enableCovSplats;\nuniform float time;\nuniform float deltaTime;\nuniform bool debugFlag;\nuniform float minAlpha;\nuniform bool enable2DGS;\nuniform float blurAmount;\nuniform float preBlurAmount;\nuniform float focalDistance;\nuniform float apertureAngle;\nuniform float clipXY;\nuniform float focalAdjustment;\n\nuniform usampler2D ordering;\nuniform usampler2DArray extSplats;\nuniform usampler2DArray extSplats2;\n\nbool isPerspectiveMatrix( mat4 m ) {\n    return m[ 2 ][ 3 ] == -1.0;\n}\n\n#include <logdepthbuf_pars_vertex>\n\nvoid main() {\n    \n    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);\n\n    ivec2 orderingCoord = ivec2((gl_InstanceID >> 2) & 4095, gl_InstanceID >> 14);\n    uint splatIndex = texelFetch(ordering, orderingCoord, 0)[gl_InstanceID & 3];\n    if (splatIndex == 0xffffffffu) {\n        \n        return;\n    }\n\n    ivec3 texCoord = splatTexCoord(int(splatIndex));\n    vec3 center, scales, xxyyzz, xyxzyz;\n    vec4 quaternion, rgba;\n    mat3 cov3D;\n    bvec3 zeroScales = bvec3(false);\n\n    if (enableExtSplats) {\n        uvec4 ext1 = texelFetch(extSplats, texCoord, 0);\n        float alpha = unpackSplatExtAlpha(ext1);\n        if ((alpha == 0.0) || (alpha < minAlpha)) {\n            return;\n        }\n        uvec4 ext2 = texelFetch(extSplats2, texCoord, 0);\n\n        if (!enableCovSplats) {\n            unpackSplatExt(ext1, ext2, center, scales, quaternion, rgba);\n            zeroScales = equal(scales, vec3(0.0));\n            if (all(zeroScales)) {\n                return;\n            }\n        } else {\n            unpackSplatExtCov(ext1, ext2, center, rgba, xxyyzz, xyxzyz);\n            if (all(equal(xxyyzz, vec3(0.0))) && all(equal(xyxzyz, vec3(0.0)))) {\n                return;\n            }\n        }\n    } else {\n        uvec4 packedData = texelFetch(extSplats, texCoord, 0);\n        if (!enableCovSplats) {\n            unpackSplatEncoding(packedData, center, scales, quaternion, rgba, vec4(0.0, 1.0, LN_SCALE_MIN, LN_SCALE_MAX));\n            zeroScales = equal(scales, vec3(0.0));\n            if (all(zeroScales)) {\n                return;\n            }\n        } else {\n            unpackSplatCovEncoding(packedData, center, rgba, xxyyzz, xyxzyz, vec4(0.0, 1.0, LN_SCALE_MIN, LN_SCALE_MAX));\n            if (all(equal(xxyyzz, vec3(0.0))) && all(equal(xyxzyz, vec3(0.0)))) {\n                return;\n            }\n        }\n\n        rgba.a *= 2.0;\n        if ((rgba.a == 0.0) || (rgba.a < minAlpha)) {\n            return;\n        }\n    }\n\n    adjustedStdDev = maxStdDev;\n\n    \n    vec3 viewCenter = (!enableCovSplats ? quatVec(renderToViewQuat, center) : (renderToViewBasis * center)) + renderToViewPos;\n\n    \n    if (viewCenter.z >= 0.0) {\n        return;\n    }\n\n    \n    vec4 clipCenter = projectionMatrix * vec4(viewCenter, 1.0);\n\n    \n    if (abs(clipCenter.z) >= clipCenter.w) {\n        return;\n    }\n\n    \n    float clip = clipXY * clipCenter.w;\n    if (abs(clipCenter.x) > clip || abs(clipCenter.y) > clip) {\n        return;\n    }\n\n    vRgba = rgba;\n    vSplatUv = position.xy * adjustedStdDev;\n\n    \n    vSplatIndex = splatIndex;\n\n    if (!enableCovSplats) {\n        \n        vec4 viewQuaternion = quatQuat(renderToViewQuat, quaternion);\n\n        if (enable2DGS && any(zeroScales)) {\n            vec3 offset;\n            if (zeroScales.z) {\n                offset = vec3(vSplatUv.xy * scales.xy, 0.0);\n            } else if (zeroScales.y) {\n                offset = vec3(vSplatUv.x * scales.x, 0.0, vSplatUv.y * scales.z);\n            } else {\n                offset = vec3(0.0, vSplatUv.xy * scales.yz);\n            }\n\n            vec3 viewPos = viewCenter + quatVec(viewQuaternion, offset);\n            gl_Position = projectionMatrix * vec4(viewPos, 1.0);\n            vNdc = gl_Position.xyz / gl_Position.w;\n\n            #include <logdepthbuf_vertex>\n            return;\n        }\n\n        \n        mat3 RS = scaleQuaternionToMatrix(scales, viewQuaternion);\n        cov3D = RS * transpose(RS);\n    } else {\n        cov3D = mat3(\n            xxyyzz.x, xyxzyz.x, xyxzyz.y,\n            xyxzyz.x, xxyyzz.y, xyxzyz.z,\n            xyxzyz.y, xyxzyz.z, xxyyzz.z\n        );\n        cov3D = renderToViewBasis * cov3D * transpose(renderToViewBasis);\n    }\n\n    \n    vec2 scaledRenderSize = renderSize * focalAdjustment;\n    vec2 focal = 0.5 * scaledRenderSize * vec2(projectionMatrix[0][0], projectionMatrix[1][1]);\n\n    mat3 J;\n    if (isOrthographic) {\n        J = mat3(\n            focal.x, 0.0, 0.0,\n            0.0, focal.y, 0.0,\n            0.0, 0.0, 0.0\n        );\n    } else {\n        float invZ = 1.0 / viewCenter.z;\n        vec2 J1 = focal * invZ;\n        vec2 J2 = -(J1 * viewCenter.xy) * invZ;\n        J = mat3(\n            J1.x, 0.0, J2.x,\n            0.0, J1.y, J2.y,\n            0.0, 0.0, 0.0\n        );\n    }\n\n    \n    \n    mat3 cov2D = transpose(J) * cov3D * J;\n    float a = cov2D[0][0];\n    float d = cov2D[1][1];\n    float b = cov2D[0][1];\n\n    \n    a += preBlurAmount;\n    d += preBlurAmount;\n\n    float fullBlurAmount = blurAmount;\n    if ((focalDistance > 0.0) && (apertureAngle > 0.0)) {\n        float focusRadius = maxPixelRadius;\n        if (viewCenter.z < 0.0) {\n            float focusBlur = abs((-viewCenter.z - focalDistance) / viewCenter.z);\n            float apertureRadius = focal.x * tan(0.5 * apertureAngle);\n            focusRadius = focusBlur * apertureRadius;\n        }\n        fullBlurAmount = clamp(sqr(focusRadius), blurAmount, sqr(maxPixelRadius));\n    }\n\n    \n    float detOrig = a * d - b * b;\n    a += fullBlurAmount;\n    d += fullBlurAmount;\n    float det = a * d - b * b;\n\n    \n    float blurAdjust = sqrt(max(0.0, detOrig / det));\n    rgba.a *= blurAdjust;\n    if (rgba.a < minAlpha) {\n        return;\n    }\n    vRgba.a = rgba.a;\n\n    \n    float eigenAvg = 0.5 * (a + d);\n    float eigenDelta = sqrt(max(0.0, eigenAvg * eigenAvg - det));\n    float eigen1 = eigenAvg + eigenDelta;\n    float eigen2 = eigenAvg - eigenDelta;\n\n    vec2 eigenVec1 = (abs(b) > 0.001) ? normalize(vec2(b, eigen1 - a))\n        : ((a >= d) ? vec2(1.0, 0.0) : vec2(0.0, 1.0));\n    vec2 eigenVec2 = vec2(eigenVec1.y, -eigenVec1.x);\n\n    float scale1 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen1));\n    float scale2 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen2));\n    if (scale1 < minPixelRadius && scale2 < minPixelRadius) {\n        return;\n    }\n\n    \n    vec2 pixelOffset = position.x * eigenVec1 * scale1 + position.y * eigenVec2 * scale2;\n    vec2 ndcOffset = (2.0 / scaledRenderSize) * pixelOffset;\n\n    \n    vec3 ndcCenter = clipCenter.xyz / clipCenter.w;\n    vec3 ndc = vec3(ndcCenter.xy + ndcOffset, ndcCenter.z);\n\n    vNdc = ndc;\n    gl_Position = vec4(ndc.xy * clipCenter.w, clipCenter.zw);\n\n    #include <logdepthbuf_vertex>\n}";
let shaders = null;
function getShaders() {
  if (!shaders) {
    THREE__namespace.ShaderChunk.splatDefines = splatDefines_default;
    shaders = {
      splatVertex: splatVertex_default,
      splatFragment: splatFragment_default,
      computeVec4Template: computeVec4_default,
      computeUvec4Vec4Template: computeUvec4_Vec4_default,
      computeUvec4x2Vec4Template: computeUvec4x2_Vec4_default,
      computeUvec4Template: computeUvec4_default
    };
  }
  return shaders;
}
const _Readback = class _Readback {
  constructor({ renderer } = {}) {
    this.renderer = renderer;
    this.capacity = 0;
    this.count = 0;
  }
  dispose() {
    if (this.target) {
      this.target.dispose();
      this.target = void 0;
    }
  }
  // Ensure we have a buffer large enough for the readback of count indices.
  // Pass in previous bufer of the desired type.
  static ensureBuffer(count, buffer) {
    const roundedCount = Math.ceil(Math.max(1, count) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    const bytes = roundedCount * 4;
    if (buffer.byteLength >= bytes) {
      return buffer;
    }
    const newBuffer = new ArrayBuffer(bytes);
    if (buffer instanceof ArrayBuffer) {
      return newBuffer;
    }
    const ctor = buffer.constructor;
    return new ctor(newBuffer);
  }
  ensureBuffer(count, buffer) {
    return _Readback.ensureBuffer(count, buffer);
  }
  // Ensure our render target is large enough for the readback of capacity indices.
  ensureCapacity(capacity) {
    const { width, height, depth, maxSplats } = getTextureSize(capacity);
    if (!this.target || maxSplats > this.capacity) {
      this.dispose();
      this.capacity = maxSplats;
      this.target = new THREE__namespace.WebGLArrayRenderTarget(width, height, depth, {
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        magFilter: THREE__namespace.NearestFilter,
        minFilter: THREE__namespace.NearestFilter
      });
      this.target.texture.format = THREE__namespace.RGBAFormat;
      this.target.texture.type = THREE__namespace.UnsignedByteType;
      this.target.texture.internalFormat = "RGBA8";
      this.target.scissorTest = true;
    }
  }
  // Get a program and THREE.RawShaderMaterial for a given Rgba8Readback,
  // generating it if necessary and caching the result.
  prepareProgramMaterial(reader) {
    let program = _Readback.readbackProgram.get(reader);
    if (!program) {
      const graph = dynoBlock(
        { index: "int" },
        { rgba8: "vec4" },
        ({ index }) => {
          reader.inputs.index = index;
          const rgba8 = new OutputRgba8({ rgba8: reader.outputs.rgba8 });
          return { rgba8 };
        }
      );
      if (!_Readback.programTemplate) {
        _Readback.programTemplate = new DynoProgramTemplate(
          getShaders().computeVec4Template
        );
      }
      program = new DynoProgram({
        graph,
        inputs: { index: "_index" },
        outputs: { rgba8: "target" },
        template: _Readback.programTemplate
      });
      Object.assign(program.uniforms, {
        targetLayer: { value: 0 },
        targetBase: { value: 0 },
        targetCount: { value: 0 }
      });
      _Readback.readbackProgram.set(reader, program);
    }
    const material = program.prepareMaterial();
    _Readback.fullScreenQuad.material = material;
    return { program, material };
  }
  saveRenderState(renderer) {
    return {
      target: renderer.getRenderTarget(),
      xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear
    };
  }
  resetRenderState(renderer, state) {
    renderer.setRenderTarget(state.target);
    renderer.xr.enabled = state.xrEnabled;
    renderer.autoClear = state.autoClear;
  }
  process({
    count,
    material
  }) {
    const renderer = this.renderer;
    if (!renderer) {
      throw new Error("No renderer");
    }
    if (!this.target) {
      throw new Error("No target");
    }
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    material.uniforms.targetBase.value = 0;
    material.uniforms.targetCount.value = count;
    let baseIndex = 0;
    while (baseIndex < count) {
      const layer = Math.floor(baseIndex / layerSize);
      const layerBase = layer * layerSize;
      const layerYEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((count - layerBase) / SPLAT_TEX_WIDTH)
      );
      material.uniforms.targetLayer.value = layer;
      this.target.scissor.set(0, 0, SPLAT_TEX_WIDTH, layerYEnd);
      renderer.setRenderTarget(this.target, layer);
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      _Readback.fullScreenQuad.render(renderer);
      baseIndex += SPLAT_TEX_WIDTH * layerYEnd;
    }
    this.count = count;
  }
  async read({
    readback
  }) {
    const renderer = this.renderer;
    if (!renderer) {
      throw new Error("No renderer");
    }
    if (!this.target) {
      throw new Error("No target");
    }
    const roundedCount = Math.ceil(this.count / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    if (readback.byteLength < roundedCount * 4) {
      throw new Error(
        `Readback buffer too small: ${readback.byteLength} < ${roundedCount * 4}`
      );
    }
    const readbackUint8 = new Uint8Array(
      readback instanceof ArrayBuffer ? readback : readback.buffer
    );
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    let baseIndex = 0;
    const promises = [];
    while (baseIndex < this.count) {
      const layer = Math.floor(baseIndex / layerSize);
      const layerBase = layer * layerSize;
      const layerYEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((this.count - layerBase) / SPLAT_TEX_WIDTH)
      );
      renderer.setRenderTarget(this.target, layer);
      const readbackSize = SPLAT_TEX_WIDTH * layerYEnd * 4;
      const subReadback = readbackUint8.subarray(
        layerBase * 4,
        layerBase * 4 + readbackSize
      );
      const promise = renderer == null ? void 0 : renderer.readRenderTargetPixelsAsync(
        this.target,
        0,
        0,
        SPLAT_TEX_WIDTH,
        layerYEnd,
        subReadback
      );
      promises.push(promise);
      baseIndex += SPLAT_TEX_WIDTH * layerYEnd;
    }
    return Promise.all(promises).then(() => readback);
  }
  // Perform render operation to run the Rgba8Readback program
  // but don't perform the readback yet.
  render({
    reader,
    count,
    renderer
  }) {
    this.renderer = renderer || this.renderer;
    if (!this.renderer) {
      throw new Error("No renderer");
    }
    this.ensureCapacity(count);
    const { program, material } = this.prepareProgramMaterial(reader);
    program.update();
    const renderState = this.saveRenderState(this.renderer);
    this.process({ count, material });
    this.resetRenderState(this.renderer, renderState);
  }
  // Perform a readback of the render target, returning a buffer of the
  // given type.
  async readback({
    readback
  }) {
    if (!this.renderer) {
      throw new Error("No renderer");
    }
    const renderState = this.saveRenderState(this.renderer);
    const promise = this.read({ readback });
    this.resetRenderState(this.renderer, renderState);
    return promise;
  }
  // Perform a render and readback operation for the given Rgba8Readback,
  // and readback buffer (call ensureBuffer first).
  async renderReadback({
    reader,
    count,
    renderer,
    readback
  }) {
    this.renderer = renderer || this.renderer;
    if (!this.renderer) {
      throw new Error("No renderer");
    }
    this.ensureCapacity(count);
    const { program, material } = this.prepareProgramMaterial(reader);
    program.update();
    const renderState = this.saveRenderState(this.renderer);
    this.process({ count, material });
    const promise = this.read({ readback });
    this.resetRenderState(this.renderer, renderState);
    return promise;
  }
  getTexture() {
    var _a;
    return (_a = this.target) == null ? void 0 : _a.texture;
  }
};
_Readback.programTemplate = null;
_Readback.readbackProgram = /* @__PURE__ */ new WeakMap();
_Readback.fullScreenQuad = new Pass_js.FullScreenQuad(
  new THREE__namespace.RawShaderMaterial({ visible: false })
);
let Readback = _Readback;
var SplatEditSdfType = /* @__PURE__ */ ((SplatEditSdfType2) => {
  SplatEditSdfType2["ALL"] = "all";
  SplatEditSdfType2["PLANE"] = "plane";
  SplatEditSdfType2["SPHERE"] = "sphere";
  SplatEditSdfType2["BOX"] = "box";
  SplatEditSdfType2["ELLIPSOID"] = "ellipsoid";
  SplatEditSdfType2["CYLINDER"] = "cylinder";
  SplatEditSdfType2["CAPSULE"] = "capsule";
  SplatEditSdfType2["INFINITE_CONE"] = "infinite_cone";
  return SplatEditSdfType2;
})(SplatEditSdfType || {});
function sdfTypeToNumber(type) {
  switch (type) {
    case "all":
      return 0;
    case "plane":
      return 1;
    case "sphere":
      return 2;
    case "box":
      return 3;
    case "ellipsoid":
      return 4;
    case "cylinder":
      return 5;
    case "capsule":
      return 6;
    case "infinite_cone":
      return 7;
    default:
      throw new Error(`Unknown SDF type: ${type}`);
  }
}
var SplatEditRgbaBlendMode = /* @__PURE__ */ ((SplatEditRgbaBlendMode2) => {
  SplatEditRgbaBlendMode2["MULTIPLY"] = "multiply";
  SplatEditRgbaBlendMode2["SET_RGB"] = "set_rgb";
  SplatEditRgbaBlendMode2["ADD_RGBA"] = "add_rgba";
  return SplatEditRgbaBlendMode2;
})(SplatEditRgbaBlendMode || {});
function rgbaBlendModeToNumber(mode) {
  switch (mode) {
    case "multiply":
      return 0;
    case "set_rgb":
      return 1;
    case "add_rgba":
      return 2;
    default:
      throw new Error(`Unknown blend mode: ${mode}`);
  }
}
class SplatEditSdf extends THREE__namespace.Object3D {
  constructor(options = {}) {
    super();
    const { type, invert, opacity, color, displace, radius } = options;
    this.type = type ?? "sphere";
    this.invert = invert ?? false;
    this.opacity = opacity ?? 1;
    this.color = color ?? new THREE__namespace.Color(1, 1, 1);
    this.displace = displace ?? new THREE__namespace.Vector3(0, 0, 0);
    this.radius = radius ?? 0;
  }
}
const _SplatEdit = class _SplatEdit extends THREE__namespace.Object3D {
  constructor(options = {}) {
    const {
      name,
      rgbaBlendMode = "multiply",
      sdfSmooth = 0,
      softEdge = 0,
      invert = false,
      sdfs = null
    } = options;
    super();
    this.rgbaBlendMode = rgbaBlendMode;
    this.sdfSmooth = sdfSmooth;
    this.softEdge = softEdge;
    this.invert = invert;
    this.sdfs = sdfs;
    this.ordering = _SplatEdit.nextOrdering++;
    this.name = name ?? `Edit ${this.ordering}`;
  }
  addSdf(sdf) {
    if (this.sdfs == null) {
      this.sdfs = [];
    }
    if (!this.sdfs.includes(sdf)) {
      this.sdfs.push(sdf);
    }
  }
  removeSdf(sdf) {
    if (this.sdfs == null) {
      return;
    }
    this.sdfs = this.sdfs.filter((s) => s !== sdf);
  }
};
_SplatEdit.nextOrdering = 1;
let SplatEdit = _SplatEdit;
class SplatEdits {
  constructor({ maxSdfs, maxEdits }) {
    this.maxSdfs = Math.max(16, maxSdfs ?? 0);
    this.numSdfs = 0;
    this.sdfData = new Uint32Array(this.maxSdfs * 8 * 4);
    this.sdfFloatData = new Float32Array(this.sdfData.buffer);
    this.sdfTexture = this.newSdfTexture(this.sdfData, this.maxSdfs);
    this.dynoSdfArray = new DynoUniform({
      key: "sdfArray",
      type: SdfArray,
      globals: () => [defineSdfArray],
      value: {
        numSdfs: 0,
        sdfTexture: this.sdfTexture
      },
      update: (uniform2) => {
        uniform2.numSdfs = this.numSdfs;
        uniform2.sdfTexture = this.sdfTexture;
        return uniform2;
      }
    });
    this.maxEdits = Math.max(16, maxEdits ?? 0);
    this.numEdits = 0;
    this.editData = new Uint32Array(this.maxEdits * 4);
    this.editFloatData = new Float32Array(this.editData.buffer);
    this.dynoNumEdits = new DynoInt({ value: 0 });
    this.dynoEdits = this.newEdits(this.editData, this.maxEdits);
  }
  newSdfTexture(data, maxSdfs) {
    const texture2 = new THREE__namespace.DataTexture(
      data,
      8,
      maxSdfs,
      THREE__namespace.RGBAIntegerFormat,
      THREE__namespace.UnsignedIntType
    );
    texture2.internalFormat = "RGBA32UI";
    texture2.needsUpdate = true;
    return texture2;
  }
  newEdits(data, maxEdits) {
    return new DynoUniform({
      key: "edits",
      type: "uvec4",
      count: maxEdits,
      globals: () => [defineEdit],
      value: data
    });
  }
  // Ensure our SDF texture and edits uniform array have enough capacity.
  // Reallocate if not.
  ensureCapacity({
    maxSdfs,
    maxEdits
  }) {
    let dynoUpdated = false;
    if (maxSdfs > this.sdfTexture.image.height) {
      this.sdfTexture.dispose();
      this.maxSdfs = Math.max(this.maxSdfs * 2, maxSdfs);
      this.sdfData = new Uint32Array(this.maxSdfs * 8 * 4);
      this.sdfFloatData = new Float32Array(this.sdfData.buffer);
      this.sdfTexture = this.newSdfTexture(this.sdfData, this.maxSdfs);
    }
    if (maxEdits > (this.dynoEdits.count ?? 0)) {
      this.maxEdits = Math.max(this.maxEdits * 2, maxEdits);
      this.editData = new Uint32Array(this.maxEdits * 4);
      this.editFloatData = new Float32Array(this.editData.buffer);
      this.dynoEdits = this.newEdits(this.editData, this.maxEdits);
      dynoUpdated = true;
    }
    return dynoUpdated;
  }
  updateEditData(offset, value) {
    const updated = this.editData[offset] !== value;
    this.editData[offset] = value;
    return updated;
  }
  updateEditFloatData(offset, value) {
    tempFloat32[0] = value;
    const updated = this.editFloatData[offset] !== tempFloat32[0];
    if (updated) {
      this.editFloatData[offset] = tempFloat32[0];
    }
    return updated;
  }
  encodeEdit(editIndex, {
    sdfFirst,
    sdfCount,
    invert,
    rgbaBlendMode,
    softEdge,
    sdfSmooth
  }) {
    const base = editIndex * 4;
    let updated = false;
    updated = this.updateEditData(base + 0, rgbaBlendMode | (invert ? 1 << 8 : 0)) || updated;
    updated = this.updateEditData(base + 1, sdfFirst | sdfCount << 16) || updated;
    updated = this.updateEditFloatData(base + 2, softEdge) || updated;
    updated = this.updateEditFloatData(base + 3, sdfSmooth) || updated;
    return updated;
  }
  updateSdfData(offset, value) {
    const updated = this.sdfData[offset] !== value;
    this.sdfData[offset] = value;
    return updated;
  }
  updateSdfFloatData(offset, value) {
    tempFloat32[0] = value;
    const updated = this.sdfFloatData[offset] !== tempFloat32[0];
    if (updated) {
      this.sdfFloatData[offset] = tempFloat32[0];
    }
    return updated;
  }
  encodeSdf(sdfIndex, {
    sdfType,
    invert,
    center,
    quaternion,
    scale,
    sizes
  }, values) {
    const base = sdfIndex * (8 * 4);
    const flags = sdfType | (invert ? 1 << 8 : 0);
    let updated = false;
    updated = this.updateSdfFloatData(base + 0, (center == null ? void 0 : center.x) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 1, (center == null ? void 0 : center.y) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 2, (center == null ? void 0 : center.z) ?? 0) || updated;
    updated = this.updateSdfData(base + 3, flags) || updated;
    updated = this.updateSdfFloatData(base + 4, (quaternion == null ? void 0 : quaternion.x) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 5, (quaternion == null ? void 0 : quaternion.y) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 6, (quaternion == null ? void 0 : quaternion.z) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 7, (quaternion == null ? void 0 : quaternion.w) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 8, (scale == null ? void 0 : scale.x) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 9, (scale == null ? void 0 : scale.y) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 10, (scale == null ? void 0 : scale.z) ?? 0) || updated;
    updated = this.updateSdfData(base + 11, 0) || updated;
    updated = this.updateSdfFloatData(base + 12, (sizes == null ? void 0 : sizes.x) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 13, (sizes == null ? void 0 : sizes.y) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 14, (sizes == null ? void 0 : sizes.z) ?? 0) || updated;
    updated = this.updateSdfFloatData(base + 15, (sizes == null ? void 0 : sizes.w) ?? 0) || updated;
    const nValues = Math.min(4, values.length);
    for (let i = 0; i < nValues; ++i) {
      const vBase = base + 16 + i * 4;
      updated = this.updateSdfFloatData(vBase + 0, values[i].x) || updated;
      updated = this.updateSdfFloatData(vBase + 1, values[i].y) || updated;
      updated = this.updateSdfFloatData(vBase + 2, values[i].z) || updated;
      updated = this.updateSdfFloatData(vBase + 3, values[i].w) || updated;
    }
    return updated;
  }
  // Update the SDFs and edits from an array of SplatEdits and their
  // associated SplatEditSdfs, updating it for the dyno shader program.
  update(edits) {
    const sdfCount = edits.reduce((total, { sdfs }) => total + sdfs.length, 0);
    const dynoUpdated = this.ensureCapacity({
      maxEdits: edits.length,
      maxSdfs: sdfCount
    });
    const values = [new THREE__namespace.Vector4(), new THREE__namespace.Vector4()];
    const center = new THREE__namespace.Vector3();
    const quaternion = new THREE__namespace.Quaternion();
    const scale = new THREE__namespace.Vector3();
    const sizes = new THREE__namespace.Vector4();
    let sdfIndex = 0;
    let updated = dynoUpdated;
    if (edits.length !== this.dynoNumEdits.value) {
      this.dynoNumEdits.value = edits.length;
      this.numEdits = edits.length;
      updated = true;
    }
    for (const [editIndex, { edit, sdfs }] of edits.entries()) {
      updated = this.encodeEdit(editIndex, {
        sdfFirst: sdfIndex,
        sdfCount: sdfs.length,
        invert: edit.invert,
        rgbaBlendMode: rgbaBlendModeToNumber(edit.rgbaBlendMode),
        softEdge: edit.softEdge,
        sdfSmooth: edit.sdfSmooth
      }) || updated;
      let sdfUpdated = false;
      for (const sdf of sdfs) {
        sizes.set(sdf.scale.x, sdf.scale.y, sdf.scale.z, sdf.radius);
        sdf.scale.setScalar(1);
        sdf.updateMatrixWorld();
        const worldToSdf = sdf.matrixWorld.clone().invert();
        worldToSdf.decompose(center, quaternion, scale);
        sdf.scale.set(sizes.x, sizes.y, sizes.z);
        sdf.updateMatrixWorld();
        values[0].set(sdf.color.r, sdf.color.g, sdf.color.b, sdf.opacity);
        values[1].set(sdf.displace.x, sdf.displace.y, sdf.displace.z, 1);
        sdfUpdated = this.encodeSdf(
          sdfIndex,
          {
            sdfType: sdfTypeToNumber(sdf.type),
            invert: sdf.invert,
            center,
            quaternion,
            scale,
            sizes
          },
          values
        ) || sdfUpdated;
        sdfIndex += 1;
      }
      this.numSdfs = sdfIndex;
      if (sdfUpdated) {
        this.sdfTexture.needsUpdate = true;
      }
      updated || (updated = sdfUpdated);
    }
    return { updated, dynoUpdated };
  }
  // Modify a Gsplat in a dyno shader program using the current edits and SDFs.
  modify(gsplat) {
    return applyGsplatRgbaDisplaceEdits(
      gsplat,
      this.dynoSdfArray,
      this.dynoNumEdits,
      this.dynoEdits
    );
  }
  modifyCov(covsplat) {
    return applyCovSplatRgbaDisplaceEdits(
      covsplat,
      this.dynoSdfArray,
      this.dynoNumEdits,
      this.dynoEdits
    );
  }
}
const SdfArray = { type: "SdfArray" };
const defineSdfArray = unindent(`
  struct SdfArray {
    int numSdfs;
    usampler2D sdfTexture;
  };

  void unpackSdfArray(
    usampler2D sdfTexture, int sdfIndex, out uint flags,
    out vec3 center, out vec4 quaternion, out vec3 scale, out vec4 sizes,
    int numValues, out vec4 values[4]
  ) {
    uvec4 temp = texelFetch(sdfTexture, ivec2(0, sdfIndex), 0);
    flags = temp.w;
    center = vec3(uintBitsToFloat(temp.x), uintBitsToFloat(temp.y), uintBitsToFloat(temp.z));

    temp = texelFetch(sdfTexture, ivec2(1, sdfIndex), 0);
    quaternion = vec4(uintBitsToFloat(temp.x), uintBitsToFloat(temp.y), uintBitsToFloat(temp.z), uintBitsToFloat(temp.w));

    temp = texelFetch(sdfTexture, ivec2(2, sdfIndex), 0);
    scale = vec3(uintBitsToFloat(temp.x), uintBitsToFloat(temp.y), uintBitsToFloat(temp.z));

    temp = texelFetch(sdfTexture, ivec2(3, sdfIndex), 0);
    sizes = vec4(uintBitsToFloat(temp.x), uintBitsToFloat(temp.y), uintBitsToFloat(temp.z), uintBitsToFloat(temp.w));

    for (int i = 0; i < numValues; ++i) {
      temp = texelFetch(sdfTexture, ivec2(4 + i, sdfIndex), 0);
      values[i] = vec4(uintBitsToFloat(temp.x), uintBitsToFloat(temp.y), uintBitsToFloat(temp.z), uintBitsToFloat(temp.w));
    }
  }

  const uint SDF_FLAG_TYPE = 0xFFu;
  const uint SDF_FLAG_INVERT = 1u << 8u;

  const uint SDF_TYPE_ALL = 0u;
  const uint SDF_TYPE_PLANE = 1u;
  const uint SDF_TYPE_SPHERE = 2u;
  const uint SDF_TYPE_BOX = 3u;
  const uint SDF_TYPE_ELLIPSOID = 4u;
  const uint SDF_TYPE_CYLINDER = 5u;
  const uint SDF_TYPE_CAPSULE = 6u;
  const uint SDF_TYPE_INFINITE_CONE = 7u;

  float evaluateSdfArray(
    usampler2D sdfTexture, int numSdfs, int sdfFirst, int sdfCount, vec3 pos,
    float smoothK, int numValues, out vec4 outValues[4]
  ) {
    float distanceAccum = (smoothK == 0.0) ? 1.0 / 0.0 : 0.0;
    float maxExp = -1.0 / 0.0;
    for (int i = 0; i < numValues; ++i) {
        outValues[i] = vec4(0.0);
    }

    uint flags;
    vec3 center, scale;
    vec4 quaternion, sizes;
    vec4 values[4];

    int sdfLast = min(sdfFirst + sdfCount, numSdfs);
    for (int index = sdfFirst; index < sdfLast; ++index) {
      unpackSdfArray(sdfTexture, index, flags, center, quaternion, scale, sizes, numValues, values);
      uint sdfType = flags & SDF_FLAG_TYPE;
      vec3 sdfPos = quatVec(quaternion, pos * scale) + center;

      float distance;
      switch (sdfType) {
        case SDF_TYPE_ALL:
          distance = -1.0 / 0.0;
          break;
        case SDF_TYPE_PLANE: {
          distance = sdfPos.z;
          break;
        }
        case SDF_TYPE_SPHERE: {
          distance = length(sdfPos) - sizes.w;
          break;
        }
        case SDF_TYPE_BOX: {
          vec3 q = abs(sdfPos) - sizes.xyz + sizes.w;
          distance = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - sizes.w;
          break;
        }
        case SDF_TYPE_ELLIPSOID: {
          vec3 sizes = sizes.xyz;
          float k0 = length(sdfPos / sizes);
          float k1 = length(sdfPos / dot(sizes, sizes));
          distance = k0 * (k0 - 1.0) / k1;
          break;
        }
        case SDF_TYPE_CYLINDER: {
          vec2 d = abs(vec2(length(sdfPos.xz), sdfPos.y)) - sizes.wy;
          distance = min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
          break;
        }
        case SDF_TYPE_CAPSULE: {
          sdfPos.y -= clamp(sdfPos.y, -0.5 * sizes.y, 0.5 * sizes.y);
          distance = length(sdfPos) - sizes.w;
          break;
        }
        case SDF_TYPE_INFINITE_CONE: {
          float angle = 0.25 * PI * sizes.w;
          vec2 c = vec2(sin(angle), cos(angle));
          vec2 q = vec2(length(sdfPos.xy), -sdfPos.z);
          float d = length(q - c * max(dot(q, c), 0.0));
          distance = d * (((q.x * c.y - q.y * c.x) < 0.0) ? -1.0 : 1.0);
          break;
        }
      }

      if ((flags & SDF_FLAG_INVERT) != 0u) {
        distance = -distance;
      }

      if (smoothK == 0.0) {
        if (distance < distanceAccum) {
          distanceAccum = distance;
          for (int i = 0; i < numValues; ++i) {
            outValues[i] = values[i];
          }
        }
      } else {
        float scaledDistance = -distance / smoothK;
        if (scaledDistance > maxExp) {
          float scale = exp(maxExp - scaledDistance);
          distanceAccum *= scale;
          for (int i = 0; i < numValues; ++i) {
            outValues[i] *= scale;
          }
          maxExp = scaledDistance;
        }

        float weight = exp(scaledDistance - maxExp);
        distanceAccum += weight;
        for (int i = 0; i < numValues; ++i) {
          outValues[i] += weight * values[i];
        }
      }
    }

    if (smoothK == 0.0) {
      return distanceAccum;
    } else {
      // Very distant SDFs may result in 0 accumulation
      if (distanceAccum == 0.0) {
        return 1.0 / 0.0;
      }
      for (int i = 0; i < numValues; ++i) {
        outValues[i] /= distanceAccum;
      }
      return (-log(distanceAccum) - maxExp) * smoothK;
    }
  }

  float modulateSdfArray(
    usampler2D sdfTexture, int numSdfs, int sdfFirst, int sdfCount, vec3 pos,
    float smoothK, int numValues, out vec4 values[4],
    float softEdge, bool invert
  ) {
    float distance = evaluateSdfArray(sdfTexture, numSdfs, sdfFirst, sdfCount, pos, smoothK, numValues, values);
    if (invert) {
      distance = -distance;
    }

    return (softEdge == 0.0) ? ((distance < 0.0) ? 1.0 : 0.0)
      : clamp(-distance / softEdge + 0.5, 0.0, 1.0);
  }
`);
const defineEdit = unindent(`
  const uint EDIT_FLAG_BLEND = 0xFFu;
  const uint EDIT_BLEND_MULTIPLY = 0u;
  const uint EDIT_BLEND_SET_RGB = 1u;
  const uint EDIT_BLEND_ADD_RGBA = 2u;
  const uint EDIT_FLAG_INVERT = 0x100u;

  void decodeEdit(
    uvec4 packedEdit, out int sdfFirst, out int sdfCount,
    out bool invert, out uint rgbaBlendMode, out float softEdge, out float sdfSmooth
  ) {
    rgbaBlendMode = packedEdit.x & EDIT_FLAG_BLEND;
    invert = (packedEdit.x & EDIT_FLAG_INVERT) != 0u;

    sdfFirst = int(packedEdit.y & 0xFFFFu);
    sdfCount = int(packedEdit.y >> 16u);

    softEdge = uintBitsToFloat(packedEdit.z);
    sdfSmooth = uintBitsToFloat(packedEdit.w);
  }

  void applyRgbaDisplaceEdit(
    usampler2D sdfTexture, int numSdfs, int sdfFirst, int sdfCount, inout vec3 pos,
    float smoothK, float softEdge, bool invert, uint rgbaBlendMode, inout vec4 rgba
  ) {
    vec4 values[4];
    float modulate = modulateSdfArray(sdfTexture, numSdfs, sdfFirst, sdfCount, pos, smoothK, 2, values, softEdge, invert);
    // On Android, moving values[0] is necessary to work around a compiler bug.
    vec4 sdfRgba = values[0];
    vec4 sdfDisplaceScale = values[1];

    vec4 target;
    switch (rgbaBlendMode) {
      case EDIT_BLEND_MULTIPLY:
        target = rgba * sdfRgba;
        break;
      case EDIT_BLEND_SET_RGB:
        target = vec4(sdfRgba.rgb, rgba.a * sdfRgba.a);
        break;
      case EDIT_BLEND_ADD_RGBA:
        target = rgba + sdfRgba;
        break;
      default:
        // Debug output if blend mode not set
        target = vec4(fract(pos), 1.0);
    }
    rgba = mix(rgba, target, modulate);
    pos += sdfDisplaceScale.xyz * modulate;
  }

  void applyPackedRgbaDisplaceEdit(uvec4 packedEdit, usampler2D sdfTexture, int numSdfs, inout vec3 pos, inout vec4 rgba) {
    int sdfFirst, sdfCount;
    bool invert;
    uint rgbaBlendMode;
    float softEdge, sdfSmooth;
    decodeEdit(packedEdit, sdfFirst, sdfCount, invert, rgbaBlendMode, softEdge, sdfSmooth);
    applyRgbaDisplaceEdit(sdfTexture, numSdfs, sdfFirst, sdfCount, pos, sdfSmooth, softEdge, invert, rgbaBlendMode, rgba);
  }
`);
function applyGsplatRgbaDisplaceEdits(gsplat, sdfArray, numEdits, rgbaDisplaceEdits) {
  const dyno2 = new Dyno({
    inTypes: {
      gsplat: Gsplat,
      sdfArray: SdfArray,
      numEdits: "int",
      rgbaDisplaceEdits: "uvec4"
    },
    outTypes: { gsplat: Gsplat },
    globals: () => [defineSdfArray, defineEdit],
    inputs: { gsplat, sdfArray, numEdits, rgbaDisplaceEdits },
    statements: ({ inputs, outputs }) => {
      const { sdfArray: sdfArray2, numEdits: numEdits2, rgbaDisplaceEdits: rgbaDisplaceEdits2 } = inputs;
      const { gsplat: gsplat2 } = outputs;
      return unindentLines(`
        ${gsplat2} = ${inputs.gsplat};
        if (isGsplatActive(${gsplat2}.flags)) {
          for (int editIndex = 0; editIndex < ${numEdits2}; ++editIndex) {
            applyPackedRgbaDisplaceEdit(
              ${rgbaDisplaceEdits2}[editIndex], ${sdfArray2}.sdfTexture, ${sdfArray2}.numSdfs,
              ${gsplat2}.center, ${gsplat2}.rgba
            );
          }
        }
      `);
    }
  });
  return dyno2.outputs.gsplat;
}
function applyCovSplatRgbaDisplaceEdits(covsplat, sdfArray, numEdits, rgbaDisplaceEdits) {
  const dyno2 = new Dyno({
    inTypes: {
      covsplat: CovSplat,
      sdfArray: SdfArray,
      numEdits: "int",
      rgbaDisplaceEdits: "uvec4"
    },
    outTypes: { covsplat: CovSplat },
    globals: () => [defineSdfArray, defineEdit],
    inputs: { covsplat, sdfArray, numEdits, rgbaDisplaceEdits },
    statements: ({ inputs, outputs }) => {
      const { sdfArray: sdfArray2, numEdits: numEdits2, rgbaDisplaceEdits: rgbaDisplaceEdits2 } = inputs;
      const { covsplat: covsplat2 } = outputs;
      return unindentLines(`
        ${covsplat2} = ${inputs.covsplat};
        if (isCovSplatActive(${covsplat2}.flags)) {
          for (int editIndex = 0; editIndex < ${numEdits2}; ++editIndex) {
            applyPackedRgbaDisplaceEdit(
              ${rgbaDisplaceEdits2}[editIndex], ${sdfArray2}.sdfTexture, ${sdfArray2}.numSdfs,
              ${covsplat2}.center, ${covsplat2}.rgba
            );
          }
        }
      `);
    }
  });
  return dyno2.outputs.covsplat;
}
const tempFloat32 = new Float32Array(1);
class SplatModifier {
  constructor(modifier) {
    this.modifier = modifier;
    this.cache = /* @__PURE__ */ new Map();
  }
  apply(generator) {
    let modified = this.cache.get(generator);
    if (!modified) {
      modified = dynoBlock(
        { index: "int" },
        { gsplat: Gsplat },
        ({ index }) => {
          const { gsplat } = generator.apply({ index });
          return this.modifier.apply({ gsplat });
        }
      );
      this.cache.set(generator, modified);
    }
    return modified;
  }
}
class SplatTransformer {
  // Create the dyno uniforms that parameterize the transform, setting them
  // to initial values that are different from any valid transform.
  constructor() {
    this.scale = new DynoFloat({ value: Number.NEGATIVE_INFINITY });
    this.rotate = new DynoVec4({
      value: new THREE__namespace.Quaternion(
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY
      )
    });
    this.translate = new DynoVec3({
      value: new THREE__namespace.Vector3(
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY
      )
    });
  }
  // Apply the transform to a Vec3 position in a dyno program.
  apply(position) {
    return transformPos(position, {
      scale: this.scale,
      rotate: this.rotate,
      translate: this.translate
    });
  }
  applyDir(dir) {
    return transformDir(dir, {
      rotate: this.rotate
    });
  }
  // Apply the transform to a Gsplat in a dyno program.
  applyGsplat(gsplat) {
    return transformGsplat(gsplat, {
      scale: this.scale,
      rotate: this.rotate,
      translate: this.translate
    });
  }
  // Update the uniforms to match the given transform matrix.
  updateFromMatrix(transform) {
    const scale = new THREE__namespace.Vector3();
    const quaternion = new THREE__namespace.Quaternion();
    const position = new THREE__namespace.Vector3();
    transform.decompose(position, quaternion, scale);
    const newScale = (scale.x + scale.y + scale.z) / 3;
    let updated = false;
    if (newScale !== this.scale.value) {
      this.scale.value = newScale;
      updated = true;
    }
    if (!position.equals(this.translate.value)) {
      this.translate.value.copy(position);
      updated = true;
    }
    if (!quaternion.equals(this.rotate.value)) {
      this.rotate.value.copy(quaternion);
      updated = true;
    }
    return updated;
  }
  // Update this transform to match the object's to-world transform.
  update(object) {
    object.updateMatrixWorld();
    return this.updateFromMatrix(object.matrixWorld);
  }
}
class CovSplatTransformer {
  constructor() {
    this.basis = new DynoMat3({ value: new THREE__namespace.Matrix3() });
    this.offset = new DynoVec3({ value: new THREE__namespace.Vector3() });
  }
  // Apply the transform to a Vec3 position in a dyno program.
  apply(position) {
    const rebased = mul(this.basis, position);
    return add(rebased, this.offset);
  }
  applyDir(dir) {
    return mul(this.basis, dir);
  }
  // Apply the transform to a Gsplat in a dyno program.
  applyCovSplat(covsplat) {
    return new Dyno({
      inTypes: { covsplat: CovSplat, basis: "mat3", offset: "vec3" },
      outTypes: { covsplat: CovSplat },
      inputs: { covsplat, basis: this.basis, offset: this.offset },
      statements: ({ inputs, outputs }) => {
        const { covsplat: covsplat2, basis, offset } = inputs;
        if (!covsplat2 || !basis || !offset) {
          return [`${outputs.covsplat}.flags = 0u;`];
        }
        return unindentLines(`
          ${outputs.covsplat}.flags = 0u;
          if (isCovSplatActive(${covsplat2}.flags)) {
            ${outputs.covsplat}.flags = ${covsplat2}.flags;
            ${outputs.covsplat}.index = ${covsplat2}.index;
            ${outputs.covsplat}.rgba = ${covsplat2}.rgba;

            ${outputs.covsplat}.center = ${basis} * ${covsplat2}.center + ${offset};
            
            mat3 cov = mat3(
              ${covsplat2}.xxyyzz.x, ${covsplat2}.xyxzyz.x, ${covsplat2}.xyxzyz.y,
              ${covsplat2}.xyxzyz.x, ${covsplat2}.xxyyzz.y, ${covsplat2}.xyxzyz.z,
              ${covsplat2}.xyxzyz.y, ${covsplat2}.xyxzyz.z, ${covsplat2}.xxyyzz.z
            );
            cov = ${basis} * cov * transpose(${basis});
            ${outputs.covsplat}.xxyyzz = vec3(cov[0][0], cov[1][1], cov[2][2]);
            ${outputs.covsplat}.xyxzyz = vec3(cov[0][1], cov[0][2], cov[1][2]);
          }
        `);
      }
    }).outputs.covsplat;
  }
  // Update the uniforms to match the given transform matrix.
  updateFromMatrix(transform) {
    const basis = new THREE__namespace.Matrix3().setFromMatrix4(transform);
    const offset = new THREE__namespace.Vector3().setFromMatrixColumn(transform, 3);
    const updated = !basis.equals(this.basis.value) || !offset.equals(this.offset.value);
    if (updated) {
      this.basis.value.copy(basis);
      this.offset.value.copy(offset);
    }
    return updated;
  }
  // Update this transform to match the object's to-world transform.
  update(object) {
    object.updateMatrixWorld();
    return this.updateFromMatrix(object.matrixWorld);
  }
}
class SplatGenerator extends THREE__namespace.Object3D {
  constructor({
    numSplats,
    generator,
    covGenerator,
    construct,
    update
  }) {
    super();
    this.numSplats = numSplats ?? 0;
    this.generator = generator;
    this.covGenerator = covGenerator;
    this.frameUpdate = update;
    this.version = 0;
    this.mappingVersion = 0;
    if (construct) {
      const constructed = construct(this);
      Object.assign(this, constructed);
    }
  }
  updateVersion() {
    this.version += 1;
  }
  updateMappingVersion() {
    this.mappingVersion += 1;
    this.version += 1;
  }
  set needsUpdate(value) {
    if (value) {
      this.updateVersion();
    }
  }
}
function get_raycast_buffer() {
  const ret = wasm.get_raycast_buffer();
  return ret;
}
function get_raycast_buffer2() {
  const ret = wasm.get_raycast_buffer2();
  return ret;
}
function raycast_ext_buffers(origin_x, origin_y, origin_z, dir_x, dir_y, dir_z, min_opacity, near, far, count) {
  const ret = wasm.raycast_ext_buffers(origin_x, origin_y, origin_z, dir_x, dir_y, dir_z, min_opacity, near, far, count);
  return ret;
}
function raycast_packed_buffer(origin_x, origin_y, origin_z, dir_x, dir_y, dir_z, min_opacity, near, far, count, ln_scale_min, ln_scale_max) {
  const ret = wasm.raycast_packed_buffer(origin_x, origin_y, origin_z, dir_x, dir_y, dir_z, min_opacity, near, far, count, ln_scale_min, ln_scale_max);
  return ret;
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg___wbindgen_throw_81fc77679af83bc6: function(arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
      let deferred0_0;
      let deferred0_1;
      try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
      } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
      }
    },
    __wbg_new_227d7c05414eb861: function() {
      const ret = new Error();
      return ret;
    },
    __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
      const ret = arg1.stack;
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbindgen_cast_0000000000000001: function(arg0, arg1) {
      const ret = getArrayF32FromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_cast_0000000000000002: function(arg0, arg1) {
      const ret = getArrayU32FromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_init_externref_table: function() {
      const table = wasm.__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, void 0);
      table.set(offset + 0, void 0);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    }
  };
  return {
    __proto__: null,
    "./spark_rs_bg.js": import0
  };
}
function getArrayF32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayU32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}
let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
  if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
    cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
  }
  return cachedFloat32ArrayMemory0;
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
  if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
    cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
  }
  return cachedUint32ArrayMemory0;
}
let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
const cachedTextEncoder = new TextEncoder();
if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function(arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length
    };
  };
}
let WASM_VECTOR_LEN = 0;
let wasm;
function __wbg_finalize_init(instance, module2) {
  wasm = instance.exports;
  cachedDataViewMemory0 = null;
  cachedFloat32ArrayMemory0 = null;
  cachedUint32ArrayMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
async function __wbg_load(module2, imports) {
  if (typeof Response === "function" && module2 instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module2, imports);
      } catch (e) {
        const validResponse = module2.ok && expectedResponseType(module2.type);
        if (validResponse && module2.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module2.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module2, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module: module2 };
    } else {
      return instance;
    }
  }
  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}
async function __wbg_init(module_or_path) {
  if (wasm !== void 0) return wasm;
  if (module_or_path !== void 0) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (module_or_path === void 0) {
    module_or_path = new URL("data:application/wasm;base64,AGFzbQEAAAAB4AEeYAJ/fwF/YAN/f38Bf2ACf38AYAV/f39/fwBgA39/fwBgBH9/f38AYAAAYAR/f39/AX9gAX8AYAABb2ABfQF9YAZ/f39/f38AYAJ/fwFvYAABf2AFf39+f38AYAV/f3x/fwBgBX9/fX9/AGAFf39/f38Bf2ACf28AYAF/AX9gB39/f31/f38AYAZ/f39+f38AYAZ/f398f38AYAZ/f399f38AYAx9fX19fX19fX1/fX0Bb2AKfX19fX19fX19fwFvYAZ/f39/f38Bf2AEf35/fwBgBH99f38AYAR/fH9/AALlAgcQLi9zcGFya19yc19iZy5qcxpfX3diZ19uZXdfMjI3ZDdjMDU0MTRlYjg2MQAJEC4vc3BhcmtfcnNfYmcuanMcX193Ymdfc3RhY2tfM2IwZDk3NGJiZjMxZTQ0ZgASEC4vc3BhcmtfcnNfYmcuanMcX193YmdfZXJyb3JfYTZmYTIwMmI1OGFhMWNkMwACEC4vc3BhcmtfcnNfYmcuanMnX193YmdfX193YmluZGdlbl90aHJvd184MWZjNzc2NzlhZjgzYmM2AAIQLi9zcGFya19yc19iZy5qcx9fX3diaW5kZ2VuX2luaXRfZXh0ZXJucmVmX3RhYmxlAAYQLi9zcGFya19yc19iZy5qcyBfX3diaW5kZ2VuX2Nhc3RfMDAwMDAwMDAwMDAwMDAwMQAMEC4vc3BhcmtfcnNfYmcuanMgX193YmluZGdlbl9jYXN0XzAwMDAwMDAwMDAwMDAwMDIADANYVxMBAQoKCAcUAgcGCgACAg0AAAALAwMCBAQEAggIAwQGCwgDAwUVCxYXAQMBBAUAAAQCBwcGCBgZGhEDDhAPBQcCAQAEAAAAAAACAQEJCQYAAgICAgYGDQQJAnABNjZvAIAIBQMBABEGCQF/AUGAgMAACwflAQwGbWVtb3J5AgASZ2V0X3JheWNhc3RfYnVmZmVyAFMTZ2V0X3JheWNhc3RfYnVmZmVyMgBUE3JheWNhc3RfZXh0X2J1ZmZlcnMAPhVyYXljYXN0X3BhY2tlZF9idWZmZXIAPQxzaW1kX2VuYWJsZWQAXQp3YXNtX3N0YXJ0ADsPX193YmluZGdlbl9mcmVlACURX193YmluZGdlbl9tYWxsb2MANRJfX3diaW5kZ2VuX3JlYWxsb2MA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AgwgACADNgIMIAAgBTYCCAwDCyAAIAIgBmo2AgRB5JjAAEHkmMAAKAIAIgBBD2pBeHEiAUEIayIENgIAQdyYwABB3JjAACgCACACaiICIAAgAWtqQQhqIgE2AgAgBCABQQFyNgIEIAAgAmpBKDYCBEHwmMAAQYCAgAE2AgAMAwtB5JjAACAANgIAQdyYwABB3JjAACgCACAFaiIBNgIAIAAgAUEBcjYCBAwBC0HgmMAAIAA2AgBB2JjAAEHYmMAAKAIAIAVqIgE2AgAgACABQQFyNgIEIAAgAWogATYCAAsgAkEIag8LQQAhAEHcmMAAKAIAIgEgBU0NAEHcmMAAIAEgBWsiATYCAEHkmMAAQeSYwAAoAgAiACAFaiICNgIAIAIgAUEBcjYCBCAAIAVBA3I2AgQMAQsgAA8LIABBCGoL4RcCGX8CfCMAQbAEayIDJAAgA0IANwOYASADQgA3A5ABIANCADcDiAEgA0IANwOAASADQgA3A3ggA0IANwNwIANCADcDaCADQgA3A2AgA0IANwNYIANCADcDUCADQgA3A0ggA0IANwNAIANCADcDOCADQgA3AzAgA0IANwMoIANCADcDICADQgA3AxggA0IANwMQIANCADcDCCADQgA3AwAgA0IANwO4AiADQgA3A7ACIANCADcDqAIgA0IANwOgAiADQgA3A5gCIANCADcDkAIgA0IANwOIAiADQgA3A4ACIANCADcD+AEgA0IANwPwASADQgA3A+gBIANCADcD4AEgA0IANwPYASADQgA3A9ABIANCADcDyAEgA0IANwPAASADQgA3A7gBIANCADcDsAEgA0IANwOoASADQgA3A6ABIANCADcD2AMgA0IANwPQAyADQgA3A8gDIANCADcDwAMgA0IANwO4AyADQgA3A7ADIANCADcDqAMgA0IANwOgAyADQgA3A5gDIANCADcDkAMgA0IANwOIAyADQgA3A4ADIANCADcD+AIgA0IANwPwAiADQgA3A+gCIANCADcD4AIgA0IANwPYAiADQgA3A9ACIANCADcDyAIgA0IANwPAAiADQeADakEAQdAA/AsAQZSSwAAoAgAiCSEGIAJBA2tBGG0iBUEAIAVBAEobIgshBSALQQJ0QaSSwABqIQcDQCADIARBA3RqIAVBAEgEfEQAAAAAAAAAAAUgBygCALcLOQMA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NTIvbGlicmFyeS9zdGQvc3JjL3N5cy90aHJlYWRfbG9jYWwvbm9fdGhyZWFkcy5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L3N0ZC9zcmMvc3lzL3N5bmMvcndsb2NrL25vX3RocmVhZHMucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjL3RocmVhZC9sb2NhbC5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2FsbG9jL3NyYy9zdHJpbmcucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjL3Bhbmlja2luZy5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL3dhc20tYmluZGdlbi0wLjIuMTE3L3NyYy9leHRlcm5yZWYucnMAc3BhcmstbGliL3NyYy9zcGxhdF9lbmNvZGUucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjL3N5bmMvb25jZS5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2FsbG9jL3NyYy9yYXdfdmVjL21vZC5ycwAvcnVzdC9kZXBzL2RsbWFsbG9jLTAuMi4xMy9zcmMvZGxtYWxsb2MucnMAc3BhcmstcnMvc3JjL2xpYi5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL2NvbnNvbGVfZXJyb3JfcGFuaWNfaG9vay0wLjEuNy9zcmMvbGliLnJzAEF0dGVtcHRlZCB0byBpbml0aWFsaXplIHRocmVhZC1sb2NhbCB3aGlsZSBpdCBpcyBiZWluZyBk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", typeof document === "undefined" ? require("url").pathToFileURL(__filename).href : _documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === "SCRIPT" && _documentCurrentScript.src || new URL("gaussian-splat-lite.cjs", document.baseURI).href);
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  const { instance, module: module2 } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance);
}
const _PackedSplats = class _PackedSplats {
  constructor(options = {}) {
    this.maxSplats = 0;
    this.numSplats = 0;
    this.packedArray = null;
    this.maxSh = 3;
    this.isInitialized = false;
    this.target = null;
    this.source = null;
    this.needsUpdate = true;
    this.extra = {};
    this.dyno = new DynoPackedSplats({ packedSplats: this });
    this.dynoRgbMinMaxLnScaleMinMax = new DynoVec4({
      key: "rgbMinMaxLnScaleMinMax",
      value: new THREE__namespace.Vector4(0, 1, LN_SCALE_MIN, LN_SCALE_MAX),
      update: (value) => {
        var _a, _b, _c, _d;
        value.set(
          ((_a = this.splatEncoding) == null ? void 0 : _a.rgbMin) ?? 0,
          ((_b = this.splatEncoding) == null ? void 0 : _b.rgbMax) ?? 1,
          ((_c = this.splatEncoding) == null ? void 0 : _c.lnScaleMin) ?? LN_SCALE_MIN,
          ((_d = this.splatEncoding) == null ? void 0 : _d.lnScaleMax) ?? LN_SCALE_MAX
        );
        return value;
      }
    });
    this.dynoNumSh = new DynoInt({
      key: "numSh",
      value: 0,
      update: () => {
        return Math.min(this.getNumSh(), this.maxSh);
      }
    });
    this.dynoShMax = new DynoVec3({
      key: "shMax",
      value: new THREE__namespace.Vector3(),
      update: (value) => {
        var _a, _b, _c;
        value.set(
          ((_a = this.splatEncoding) == null ? void 0 : _a.sh1Max) ?? 1,
          ((_b = this.splatEncoding) == null ? void 0 : _b.sh2Max) ?? 1,
          ((_c = this.splatEncoding) == null ? void 0 : _c.sh3Max) ?? 1
        );
        return value;
      }
    });
    this.initialized = Promise.resolve(this);
    this.reinitialize(options);
  }
  reinitialize(options) {
    this.isInitialized = false;
    this.extra = {};
    this.maxSplats = options.maxSplats ?? 0;
    this.splatEncoding = options.splatEncoding;
    if (options.url || options.fileBytes || options.stream || options.construct) {
      this.initialized = this.asyncInitialize(options).then(() => {
        this.isInitialized = true;
        return this;
      });
    } else {
      this.initialize(options);
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
    }
  }
  initialize(options) {
    this.extra = options.extra ?? {};
    this.splatEncoding = options.splatEncoding ?? this.splatEncoding;
    if (options.packedArray) {
      this.packedArray = options.packedArray;
      this.numSplats = options.numSplats ?? this.packedArray.length / 4;
      this.maxSplats = Math.floor(this.packedArray.length / 4);
      this.maxSplats = Math.floor(this.maxSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      this.numSplats = Math.min(
        this.maxSplats,
        options.numSplats ?? Number.POSITIVE_INFINITY
      );
    } else {
      this.maxSplats = options.maxSplats ?? 0;
      this.numSplats = 0;
    }
  }
  async asyncInitialize(options) {
    const {
      url,
      fileBytes,
      fileType,
      fileName,
      stream,
      streamLength,
      construct
    } = options;
    const loader = new SplatLoader();
    if (fileBytes || url || stream) {
      await loader.loadInternalAsync({
        packedSplats: this,
        url,
        fileBytes,
        fileType,
        fileName,
        stream,
        streamLength,
        onProgress: options.onProgress
      });
    }
    if (construct) {
      const maybePromise = construct(this);
      if (maybePromise instanceof Promise) {
        await maybePromise;
      }
    }
  }
  // Call this when you are finished with the PackedSplats and want to free
  // any buffers it holds.
  dispose() {
    if (this.target) {
      this.target.dispose();
      this.target.texture.source.data = null;
      this.target = null;
    }
    if (this.source) {
      this.source.dispose();
      this.source.source.data = null;
      this.source = null;
    }
    this.packedArray = null;
    for (const key in this.extra) {
      const dyno2 = this.extra[key];
      if (dyno2 instanceof DynoUniform) {
        const texture2 = dyno2.value;
        if (texture2 == null ? void 0 : texture2.isTexture) {
          texture2.dispose();
          texture2.source.data = null;
        }
      }
    }
    this.extra = {};
  }
  prepareFetchSplat() {
  }
  getNumSplats() {
    return this.numSplats;
  }
  hasRgbDir() {
    return Math.min(this.getNumSh(), this.maxSh) > 0;
  }
  getNumSh() {
    return !this.extra.sh1 ? 0 : !this.extra.sh2 ? 1 : !this.extra.sh3 ? 2 : 3;
  }
  setMaxSh(maxSh) {
    this.maxSh = maxSh;
  }
  fetchSplat({
    index,
    viewOrigin
  }) {
    let gsplat = readPackedSplat(this.dyno, index);
    if (this.hasRgbDir() && viewOrigin) {
      const splatCenter = splitGsplat(gsplat).outputs.center;
      const viewDir = normalize(sub(splatCenter, viewOrigin));
      const { sh1Texture, sh2Texture, sh3Texture } = this.ensureShTextures();
      let { rgb } = evaluatePackedSH({
        coord: splatTexCoord(index),
        viewDir,
        numSh: this.dynoNumSh,
        sh1Texture,
        sh2Texture,
        sh3Texture,
        shMax: this.dynoShMax
      });
      rgb = add(rgb, splitGsplat(gsplat).outputs.rgb);
      gsplat = combineGsplat({ gsplat, rgb });
    }
    return gsplat;
  }
  ensureShTextures() {
    if (!this.extra.sh1) {
      return {};
    }
    let sh1Texture = this.extra.sh1Texture;
    if (!sh1Texture) {
      let sh1 = this.extra.sh1;
      const { width, height, depth, maxSplats } = getTextureSize(
        sh1.length / 2
      );
      if (sh1.length < maxSplats * 2) {
        const newSh1 = new Uint32Array(maxSplats * 2);
        newSh1.set(sh1);
        this.extra.sh1 = newSh1;
        sh1 = newSh1;
      }
      const texture2 = new THREE__namespace.DataArrayTexture(sh1, width, height, depth);
      texture2.format = THREE__namespace.RGIntegerFormat;
      texture2.type = THREE__namespace.UnsignedIntType;
      texture2.internalFormat = "RG32UI";
      texture2.needsUpdate = true;
      sh1Texture = new DynoUsampler2DArray({
        value: texture2,
        key: "sh1"
      });
      this.extra.sh1Texture = sh1Texture;
    }
    if (!this.extra.sh2) {
      return { sh1Texture };
    }
    let sh2Texture = this.extra.sh2Texture;
    if (!sh2Texture) {
      let sh2 = this.extra.sh2;
      const { width, height, depth, maxSplats } = getTextureSize(
        sh2.length / 4
      );
      if (sh2.length < maxSplats * 4) {
        const newSh2 = new Uint32Array(maxSplats * 4);
        newSh2.set(sh2);
        this.extra.sh2 = newSh2;
        sh2 = newSh2;
      }
      const texture2 = new THREE__namespace.DataArrayTexture(sh2, width, height, depth);
      texture2.format = THREE__namespace.RGBAIntegerFormat;
      texture2.type = THREE__namespace.UnsignedIntType;
      texture2.internalFormat = "RGBA32UI";
      texture2.needsUpdate = true;
      sh2Texture = new DynoUsampler2DArray({
        value: texture2,
        key: "sh2"
      });
      this.extra.sh2Texture = sh2Texture;
    }
    if (!this.extra.sh3) {
      return { sh1Texture, sh2Texture };
    }
    let sh3Texture = this.extra.sh3Texture;
    if (!sh3Texture) {
      let sh3 = this.extra.sh3;
      const { width, height, depth, maxSplats } = getTextureSize(
        sh3.length / 4
      );
      if (sh3.length < maxSplats * 4) {
        const newSh3 = new Uint32Array(maxSplats * 4);
        newSh3.set(sh3);
        this.extra.sh3 = newSh3;
        sh3 = newSh3;
      }
      const texture2 = new THREE__namespace.DataArrayTexture(sh3, width, height, depth);
      texture2.format = THREE__namespace.RGBAIntegerFormat;
      texture2.type = THREE__namespace.UnsignedIntType;
      texture2.internalFormat = "RGBA32UI";
      texture2.needsUpdate = true;
      sh3Texture = new DynoUsampler2DArray({
        value: texture2,
        key: "sh3"
      });
      this.extra.sh3Texture = sh3Texture;
    }
    return { sh1Texture, sh2Texture, sh3Texture };
  }
  // Ensures that this.packedArray can fit numSplats Gsplats. If it's too small,
  // resize exponentially and copy over the original data.
  //
  // Typically you don't need to call this, because calling this.setSplat(index, ...)
  // and this.pushSplat(...) will automatically call ensureSplats() so we have
  // enough splats.
  ensureSplats(numSplats) {
    const targetSize = numSplats <= this.maxSplats ? this.maxSplats : (
      // Grow exponentially to avoid frequent reallocations
      Math.max(numSplats, 2 * this.maxSplats)
    );
    const currentSize = !this.packedArray ? 0 : this.packedArray.length / 4;
    if (!this.packedArray || targetSize > currentSize) {
      this.maxSplats = getTextureSize(targetSize).maxSplats;
      const newArray2 = new Uint32Array(this.maxSplats * 4);
      if (this.packedArray) {
        newArray2.set(this.packedArray);
      }
      this.packedArray = newArray2;
    }
    return this.packedArray;
  }
  // Ensure the extra array for the given level is large enough to hold numSplats
  ensureSplatsSh(level, numSplats) {
    let wordsPerSplat;
    let key;
    if (level === 0) {
      return this.ensureSplats(numSplats);
    }
    if (level === 1) {
      wordsPerSplat = 2;
      key = "sh1";
    } else if (level === 2) {
      wordsPerSplat = 4;
      key = "sh2";
    } else if (level === 3) {
      wordsPerSplat = 4;
      key = "sh3";
    } else {
      throw new Error(`Invalid level: ${level}`);
    }
    let maxSplats = !this.extra[key] ? 0 : this.extra[key].length / wordsPerSplat;
    const targetSize = numSplats <= maxSplats ? maxSplats : Math.max(numSplats, 2 * maxSplats);
    if (!this.extra[key] || targetSize > maxSplats) {
      maxSplats = getTextureSize(targetSize).maxSplats;
      const newArray2 = new Uint32Array(maxSplats * wordsPerSplat);
      if (this.extra[key]) {
        newArray2.set(this.extra[key]);
      }
      this.extra[key] = newArray2;
    }
    return this.extra[key];
  }
  // Unpack the 16-byte Gsplat data at index into the Three.js components
  // center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion,
  // opacity: number 0..1, color: THREE.Color 0..1.
  getSplat(index) {
    if (!this.packedArray || index >= this.numSplats) {
      throw new Error("Invalid index");
    }
    return unpackSplat(this.packedArray, index, this.splatEncoding);
  }
  // Set all PackedSplat components at index with the provided Gsplat attributes
  // (can be the same objects returned by getSplat). Ensures there is capacity
  // for at least index+1 Gsplats.
  setSplat(index, center, scales, quaternion, opacity, color) {
    const packedSplats = this.ensureSplats(index + 1);
    setPackedSplat(
      packedSplats,
      index,
      center.x,
      center.y,
      center.z,
      scales.x,
      scales.y,
      scales.z,
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
      opacity,
      color.r,
      color.g,
      color.b
    );
    this.numSplats = Math.max(this.numSplats, index + 1);
  }
  // Effectively calls this.setSplat(this.numSplats++, center, ...), useful on
  // construction where you just want to iterate and create a collection of Gsplats.
  pushSplat(center, scales, quaternion, opacity, color) {
    const packedSplats = this.ensureSplats(this.numSplats + 1);
    setPackedSplat(
      packedSplats,
      this.numSplats,
      center.x,
      center.y,
      center.z,
      scales.x,
      scales.y,
      scales.z,
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
      opacity,
      color.r,
      color.g,
      color.b
    );
    ++this.numSplats;
  }
  // Iterate over Gsplats index 0..=(this.numSplats-1), unpack each Gsplat
  // and invoke the callback function with the Gsplat attributes.
  forEachSplat(callback) {
    if (!this.packedArray || !this.numSplats) {
      return;
    }
    for (let i = 0; i < this.numSplats; ++i) {
      const unpacked = unpackSplat(this.packedArray, i, this.splatEncoding);
      callback(
        i,
        unpacked.center,
        unpacked.scales,
        unpacked.quaternion,
        unpacked.opacity,
        unpacked.color
      );
    }
  }
  // Ensures our PackedSplats.target render target has enough space to generate
  // maxSplats total Gsplats, and reallocate if not large enough.
  ensureGenerate(maxSplats) {
    if (this.target && (maxSplats ?? 1) <= this.maxSplats) {
      return false;
    }
    if (this.target) {
      this.target.dispose();
    }
    const textureSize2 = getTextureSize(maxSplats ?? 1);
    const { width, height, depth } = textureSize2;
    this.maxSplats = textureSize2.maxSplats;
    this.target = new THREE__namespace.WebGLArrayRenderTarget(width, height, depth, {
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      magFilter: THREE__namespace.NearestFilter,
      minFilter: THREE__namespace.NearestFilter
    });
    this.target.texture.format = THREE__namespace.RGBAIntegerFormat;
    this.target.texture.type = THREE__namespace.UnsignedIntType;
    this.target.texture.internalFormat = "RGBA32UI";
    this.target.scissorTest = true;
    return true;
  }
  // Given an array of splatCounts (.numSplats for each
  // SplatGenerator/SplatMesh in the scene), compute a
  // "mapping layout" in the composite array of generated outputs.
  generateMapping(splatCounts) {
    let maxSplats = 0;
    const mapping = splatCounts.map((numSplats) => {
      const base = maxSplats;
      const rounded = Math.ceil(numSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      maxSplats += rounded;
      return { base, count: numSplats };
    });
    return { maxSplats, mapping };
  }
  // Returns a THREE.DataArrayTexture representing the PackedSplats content as
  // a Uint32x4 data array texture (2048 x 2048 x depth in size)
  getTexture() {
    if (this.target) {
      return this.target.texture;
    }
    if (this.source || this.packedArray) {
      const source = this.maybeUpdateSource();
      return source;
    }
    return _PackedSplats.getEmptyArray;
  }
  // Check if source texture needs to be created/updated
  maybeUpdateSource() {
    if (!this.packedArray) {
      throw new Error("No packed splats");
    }
    if (this.needsUpdate || !this.source) {
      this.needsUpdate = false;
      if (this.source) {
        const { width, height, depth } = this.source.image;
        if (this.maxSplats !== width * height * depth) {
          this.source.dispose();
          this.source = null;
        }
      }
      if (!this.source) {
        const { width, height, depth } = getTextureSize(this.maxSplats);
        this.source = new THREE__namespace.DataArrayTexture(
          this.packedArray,
          width,
          height,
          depth
        );
        this.source.format = THREE__namespace.RGBAIntegerFormat;
        this.source.type = THREE__namespace.UnsignedIntType;
        this.source.internalFormat = "RGBA32UI";
        this.source.needsUpdate = true;
      } else if (this.packedArray.buffer !== this.source.image.data.buffer) {
        this.source.image.data = new Uint8Array(this.packedArray.buffer);
      }
      this.source.needsUpdate = true;
    }
    return this.source;
  }
  // Get a program and THREE.RawShaderMaterial for a given GsplatGenerator,
  // generating it if necessary and caching the result.
  prepareProgramMaterial(generator) {
    let program = _PackedSplats.generatorProgram.get(generator);
    if (!program) {
      const graph = dynoBlock(
        { index: "int" },
        {},
        ({ index }, _outputs, { roots }) => {
          generator.inputs.index = index;
          const gsplat = generator.outputs.gsplat;
          const output = outputPackedSplat(
            gsplat,
            this.dynoRgbMinMaxLnScaleMinMax
          );
          roots.push(output);
          return void 0;
        }
      );
      if (!_PackedSplats.programTemplate) {
        _PackedSplats.programTemplate = new DynoProgramTemplate(
          getShaders().computeUvec4Template
        );
      }
      program = new DynoProgram({
        graph,
        inputs: { index: "_index" },
        outputs: { output: "target" },
        template: _PackedSplats.programTemplate
      });
      Object.assign(program.uniforms, {
        targetLayer: { value: 0 },
        targetBase: { value: 0 },
        targetCount: { value: 0 }
      });
      _PackedSplats.generatorProgram.set(generator, program);
    }
    const material = program.prepareMaterial();
    _PackedSplats.fullScreenQuad.material = material;
    return { program, material };
  }
  saveRenderState(renderer) {
    return {
      target: renderer.getRenderTarget(),
      xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear
    };
  }
  resetRenderState(renderer, state) {
    renderer.setRenderTarget(state.target);
    renderer.xr.enabled = state.xrEnabled;
    renderer.autoClear = state.autoClear;
  }
  // Executes a dyno program specified by generator which is any DynoBlock that
  // maps { index: "int" } to { gsplat: Gsplat }. This is called in
  // SparkRenderer.updateInternal() to re-generate Gsplats in the scene for
  // SplatGenerator instances whose version is newer than what was generated
  // for it last time.
  generate({
    generator,
    base,
    count,
    renderer
  }) {
    if (!this.target) {
      throw new Error("Target must be initialized with ensureSplats");
    }
    if (base + count > this.maxSplats) {
      throw new Error("Base + count exceeds maxSplats");
    }
    const { program, material } = this.prepareProgramMaterial(generator);
    program.update();
    const renderState = this.saveRenderState(renderer);
    const nextBase = Math.ceil((base + count) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    material.uniforms.targetBase.value = base;
    material.uniforms.targetCount.value = count;
    while (base < nextBase) {
      const layer = Math.floor(base / layerSize);
      material.uniforms.targetLayer.value = layer;
      const layerBase = layer * layerSize;
      const layerYStart = Math.floor((base - layerBase) / SPLAT_TEX_WIDTH);
      const layerYEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((nextBase - layerBase) / SPLAT_TEX_WIDTH)
      );
      this.target.scissor.set(
        0,
        layerYStart,
        SPLAT_TEX_WIDTH,
        layerYEnd - layerYStart
      );
      renderer.setRenderTarget(this.target, layer);
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      _PackedSplats.fullScreenQuad.render(renderer);
      base += SPLAT_TEX_WIDTH * (layerYEnd - layerYStart);
    }
    this.resetRenderState(renderer, renderState);
    return { nextBase };
  }
};
_PackedSplats.getEmptyArray = (() => {
  const { width, height, depth, maxSplats } = getTextureSize(1);
  const emptyArray = new Uint32Array(maxSplats * 4);
  const texture2 = new THREE__namespace.DataArrayTexture(
    emptyArray,
    width,
    height,
    depth
  );
  texture2.format = THREE__namespace.RGBAIntegerFormat;
  texture2.type = THREE__namespace.UnsignedIntType;
  texture2.internalFormat = "RGBA32UI";
  texture2.needsUpdate = true;
  return texture2;
})();
_PackedSplats.programTemplate = null;
_PackedSplats.generatorProgram = /* @__PURE__ */ new WeakMap();
_PackedSplats.fullScreenQuad = new Pass_js.FullScreenQuad(
  new THREE__namespace.RawShaderMaterial({ visible: false })
);
_PackedSplats.emptyUint32x4 = (() => {
  const { width, height, depth, maxSplats } = getTextureSize(1);
  const emptyArray = new Uint32Array(maxSplats * 4);
  const texture2 = new THREE__namespace.DataArrayTexture(
    emptyArray,
    width,
    height,
    depth
  );
  texture2.format = THREE__namespace.RGBAIntegerFormat;
  texture2.type = THREE__namespace.UnsignedIntType;
  texture2.internalFormat = "RGBA32UI";
  texture2.needsUpdate = true;
  return texture2;
})();
_PackedSplats.emptyUint32x2 = (() => {
  const { width, height, depth, maxSplats } = getTextureSize(1);
  const emptyArray = new Uint32Array(maxSplats * 2);
  const texture2 = new THREE__namespace.DataArrayTexture(
    emptyArray,
    width,
    height,
    depth
  );
  texture2.format = THREE__namespace.RGIntegerFormat;
  texture2.type = THREE__namespace.UnsignedIntType;
  texture2.internalFormat = "RG32UI";
  texture2.needsUpdate = true;
  return texture2;
})();
let PackedSplats = _PackedSplats;
class DynoPackedSplats extends DynoUniform {
  constructor({ packedSplats } = {}) {
    super({
      key: "packedSplats",
      type: TPackedSplats,
      globals: () => [definePackedSplats],
      value: {
        textureArray: PackedSplats.getEmptyArray,
        numSplats: 0,
        rgbMinMaxLnScaleMinMax: new THREE__namespace.Vector4(
          0,
          1,
          LN_SCALE_MIN,
          LN_SCALE_MAX
        )
      },
      update: (value) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
        value.textureArray = ((_a = this.packedSplats) == null ? void 0 : _a.getTexture()) ?? PackedSplats.getEmptyArray;
        value.numSplats = ((_b = this.packedSplats) == null ? void 0 : _b.numSplats) ?? 0;
        value.rgbMinMaxLnScaleMinMax.set(
          ((_d = (_c = this.packedSplats) == null ? void 0 : _c.splatEncoding) == null ? void 0 : _d.rgbMin) ?? 0,
          ((_f = (_e = this.packedSplats) == null ? void 0 : _e.splatEncoding) == null ? void 0 : _f.rgbMax) ?? 1,
          ((_h = (_g = this.packedSplats) == null ? void 0 : _g.splatEncoding) == null ? void 0 : _h.lnScaleMin) ?? LN_SCALE_MIN,
          ((_j = (_i = this.packedSplats) == null ? void 0 : _i.splatEncoding) == null ? void 0 : _j.lnScaleMax) ?? LN_SCALE_MAX
        );
        return value;
      }
    });
    this.packedSplats = packedSplats;
  }
}
const defineEvalPackedSH1 = unindent(`
  vec3 evaluatePackedSH1(uvec2 packedData, vec3 viewDir, float sh1Max) {
    // Extract sint7 values packed into 2 x uint32
    vec3 sh1_0 = vec3(ivec3(
      int(packedData.x << 25u) >> 25,
      int(packedData.x << 18u) >> 25,
      int(packedData.x << 11u) >> 25
    ));
    vec3 sh1_1 = vec3(ivec3(
      int(packedData.x << 4u) >> 25,
      int((packedData.x >> 3u) | (packedData.y << 29u)) >> 25,
      int(packedData.y << 22u) >> 25
    ));
    vec3 sh1_2 = vec3(ivec3(
      int(packedData.y << 15u) >> 25,
      int(packedData.y << 8u) >> 25,
      int(packedData.y << 1u) >> 25
    ));

    vec3 rgb = sh1_0 * (-0.4886025 * viewDir.y)
      + sh1_1 * (0.4886025 * viewDir.z)
      + sh1_2 * (-0.4886025 * viewDir.x);
    return rgb * (sh1Max / 63.0);
  }
`);
const defineEvalPackedSH2 = unindent(`
  vec3 evaluatePackedSH2(uvec4 packedData, vec3 viewDir, float sh2Max) {
    // Extract sint8 values packed into 4 x uint32
    vec3 sh2_0 = vec3(ivec3(
      int(packedData.x << 24u) >> 24,
      int(packedData.x << 16u) >> 24,
      int(packedData.x << 8u) >> 24
    ));
    vec3 sh2_1 = vec3(ivec3(
      int(packedData.x) >> 24,
      int(packedData.y << 24u) >> 24,
      int(packedData.y << 16u) >> 24
    ));
    vec3 sh2_2 = vec3(ivec3(
      int(packedData.y << 8u) >> 24,
      int(packedData.y) >> 24,
      int(packedData.z << 24u) >> 24
    ));
    vec3 sh2_3 = vec3(ivec3(
      int(packedData.z << 16u) >> 24,
      int(packedData.z << 8u) >> 24,
      int(packedData.z) >> 24
    ));
    vec3 sh2_4 = vec3(ivec3(
      int(packedData.w << 24u) >> 24,
      int(packedData.w << 16u) >> 24,
      int(packedData.w << 8u) >> 24
    ));

    vec3 rgb = sh2_0 * (1.0925484 * viewDir.x * viewDir.y)
      + sh2_1 * (-1.0925484 * viewDir.y * viewDir.z)
      + sh2_2 * (0.3153915 * (2.0 * viewDir.z * viewDir.z - viewDir.x * viewDir.x - viewDir.y * viewDir.y))
      + sh2_3 * (-1.0925484 * viewDir.x * viewDir.z)
      + sh2_4 * (0.5462742 * (viewDir.x * viewDir.x - viewDir.y * viewDir.y));
    return rgb * (sh2Max / 127.0);
  }
`);
const defineEvalPackedSH3 = unindent(`
  vec3 evaluatePackedSH3(uvec4 packedData, vec3 viewDir, float sh3Max) {
    // Extract sint6 values packed into 4 x uint32
    vec3 sh3_0 = vec3(ivec3(
      int(packedData.x << 26u) >> 26,
      int(packedData.x << 20u) >> 26,
      int(packedData.x << 14u) >> 26
    ));
    vec3 sh3_1 = vec3(ivec3(
      int(packedData.x << 8u) >> 26,
      int(packedData.x << 2u) >> 26,
      int((packedData.x >> 4u) | (packedData.y << 28u)) >> 26
    ));
    vec3 sh3_2 = vec3(ivec3(
      int(packedData.y << 22u) >> 26,
      int(packedData.y << 16u) >> 26,
      int(packedData.y << 10u) >> 26
    ));
    vec3 sh3_3 = vec3(ivec3(
      int(packedData.y << 4u) >> 26,
      int((packedData.y >> 2u) | (packedData.z << 30u)) >> 26,
      int(packedData.z << 24u) >> 26
    ));
    vec3 sh3_4 = vec3(ivec3(
      int(packedData.z << 18u) >> 26,
      int(packedData.z << 12u) >> 26,
      int(packedData.z << 6u) >> 26
    ));
    vec3 sh3_5 = vec3(ivec3(
      int(packedData.z) >> 26,
      int(packedData.w << 26u) >> 26,
      int(packedData.w << 20u) >> 26
    ));
    vec3 sh3_6 = vec3(ivec3(
      int(packedData.w << 14u) >> 26,
      int(packedData.w << 8u) >> 26,
      int(packedData.w << 2u) >> 26
    ));

    float xx = viewDir.x * viewDir.x;
    float yy = viewDir.y * viewDir.y;
    float zz = viewDir.z * viewDir.z;
    float xy = viewDir.x * viewDir.y;
    float yz = viewDir.y * viewDir.z;
    float zx = viewDir.z * viewDir.x;

    vec3 rgb = sh3_0 * (-0.5900436 * viewDir.y * (3.0 * xx - yy))
      + sh3_1 * (2.8906114 * xy * viewDir.z) +
      + sh3_2 * (-0.4570458 * viewDir.y * (4.0 * zz - xx - yy))
      + sh3_3 * (0.3731763 * viewDir.z * (2.0 * zz - 3.0 * xx - 3.0 * yy))
      + sh3_4 * (-0.4570458 * viewDir.x * (4.0 * zz - xx - yy))
      + sh3_5 * (1.4453057 * viewDir.z * (xx - yy))
      + sh3_6 * (-0.5900436 * viewDir.x * (xx - 3.0 * yy));
    return rgb * (sh3Max / 31.0);
  }
`);
function evaluatePackedSH({
  coord,
  viewDir,
  numSh,
  sh1Texture,
  sh2Texture,
  sh3Texture,
  shMax
}) {
  return new Dyno({
    inTypes: {
      coord: "ivec3",
      viewDir: "vec3",
      numSh: "int",
      sh1Texture: "usampler2DArray",
      sh2Texture: "usampler2DArray",
      sh3Texture: "usampler2DArray",
      shMax: "vec3"
    },
    outTypes: { rgb: "vec3" },
    inputs: {
      coord,
      viewDir,
      numSh,
      sh1Texture,
      sh2Texture,
      sh3Texture,
      shMax
    },
    globals: () => [
      defineEvalPackedSH1,
      defineEvalPackedSH2,
      defineEvalPackedSH3
    ],
    statements: ({ inputs, outputs }) => {
      const lines = ["vec3 rgb = vec3(0.0);"];
      if (inputs.sh1Texture) {
        lines.push(
          ...unindentLines(`
          if (${inputs.numSh} >= 1) {
            vec3 sh1Rgb = evaluatePackedSH1(texelFetch(${inputs.sh1Texture}, ${inputs.coord}, 0).rg, ${inputs.viewDir}, ${inputs.shMax}.x);
            rgb += sh1Rgb;
          `)
        );
        if (inputs.sh2Texture) {
          lines.push(
            ...unindentLines(`
            if (${inputs.numSh} >= 2) {
              vec3 sh2Rgb = evaluatePackedSH2(texelFetch(${inputs.sh2Texture}, ${inputs.coord}, 0), ${inputs.viewDir}, ${inputs.shMax}.y);
              rgb += sh2Rgb;
            `)
          );
          if (inputs.sh3Texture) {
            lines.push(
              ...unindentLines(`
              if (${inputs.numSh} >= 3) {
                vec3 sh3Rgb = evaluatePackedSH3(texelFetch(${inputs.sh3Texture}, ${inputs.coord}, 0), ${inputs.viewDir}, ${inputs.shMax}.z);
                rgb += sh3Rgb;
              }
            `)
            );
          }
          lines.push("}");
        }
        lines.push("}");
      }
      lines.push(`${outputs.rgb} = rgb;`);
      return lines;
    }
  }).outputs;
}
const jsContent = '(function() {\n  "use strict";\n  class ChunkDecoder {\n    static __wrap(ptr) {\n      ptr = ptr >>> 0;\n      const obj = Object.create(ChunkDecoder.prototype);\n      obj.__wbg_ptr = ptr;\n      ChunkDecoderFinalization.register(obj, obj.__wbg_ptr, obj);\n      return obj;\n    }\n    __destroy_into_raw() {\n      const ptr = this.__wbg_ptr;\n      this.__wbg_ptr = 0;\n      ChunkDecoderFinalization.unregister(this);\n      return ptr;\n    }\n    free() {\n      const ptr = this.__destroy_into_raw();\n      wasm.__wbg_chunkdecoder_free(ptr, 0);\n    }\n    /**\n     * @returns {any}\n     */\n    finish() {\n      const ptr = this.__destroy_into_raw();\n      const ret = wasm.chunkdecoder_finish(ptr);\n      if (ret[2]) {\n        throw takeFromExternrefTable0(ret[1]);\n      }\n      return takeFromExternrefTable0(ret[0]);\n    }\n    /**\n     * @param {Uint8Array} bytes\n     */\n    push(bytes) {\n      const ret = wasm.chunkdecoder_push(this.__wbg_ptr, bytes);\n      if (ret[1]) {\n        throw takeFromExternrefTable0(ret[0]);\n      }\n    }\n  }\n  if (Symbol.dispose) ChunkDecoder.prototype[Symbol.dispose] = ChunkDecoder.prototype.free;\n  function decode_to_extsplats(file_type, path_name) {\n    var ptr0 = isLikeNone(file_type) ? 0 : passStringToWasm0(file_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n    var len0 = WASM_VECTOR_LEN;\n    var ptr1 = isLikeNone(path_name) ? 0 : passStringToWasm0(path_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n    var len1 = WASM_VECTOR_LEN;\n    const ret = wasm.decode_to_extsplats(ptr0, len0, ptr1, len1);\n    if (ret[2]) {\n      throw takeFromExternrefTable0(ret[1]);\n    }\n    return ChunkDecoder.__wrap(ret[0]);\n  }\n  function decode_to_packedsplats(file_type, path_name, encoding) {\n    var ptr0 = isLikeNone(file_type) ? 0 : passStringToWasm0(file_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n    var len0 = WASM_VECTOR_LEN;\n    var ptr1 = isLikeNone(path_name) ? 0 : passStringToWasm0(path_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n    var len1 = WASM_VECTOR_LEN;\n    const ret = wasm.decode_to_packedsplats(ptr0, len0, ptr1, len1, encoding);\n    if (ret[2]) {\n      throw takeFromExternrefTable0(ret[1]);\n    }\n    return ChunkDecoder.__wrap(ret[0]);\n  }\n  function sort32_splats(num_splats, readback, ordering) {\n    const ret = wasm.sort32_splats(num_splats, readback, ordering);\n    return ret >>> 0;\n  }\n  function __wbg_get_imports() {\n    const import0 = {\n      __proto__: null,\n      __wbg_Error_2e59b1b37a9a34c3: function(arg0, arg1) {\n        const ret = Error(getStringFromWasm0(arg0, arg1));\n        return ret;\n      },\n      __wbg___wbindgen_boolean_get_a86c216575a75c30: function(arg0) {\n        const v = arg0;\n        const ret = typeof v === "boolean" ? v : void 0;\n        return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;\n      },\n      __wbg___wbindgen_debug_string_dd5d2d07ce9e6c57: function(arg0, arg1) {\n        const ret = debugString(arg1);\n        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n        const len1 = WASM_VECTOR_LEN;\n        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);\n        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);\n      },\n      __wbg___wbindgen_in_4bd7a57e54337366: function(arg0, arg1) {\n        const ret = arg0 in arg1;\n        return ret;\n      },\n      __wbg___wbindgen_is_falsy_c6ddfae1bb56d5ef: function(arg0) {\n        const ret = !arg0;\n        return ret;\n      },\n      __wbg___wbindgen_is_object_40c5a80572e8f9d3: function(arg0) {\n        const val = arg0;\n        const ret = typeof val === "object" && val !== null;\n        return ret;\n      },\n      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: function(arg0) {\n        const ret = arg0 === void 0;\n        return ret;\n      },\n      __wbg___wbindgen_jsval_loose_eq_3a72ae764d46d944: function(arg0, arg1) {\n        const ret = arg0 == arg1;\n        return ret;\n      },\n      __wbg___wbindgen_number_get_7579aab02a8a620c: function(arg0, arg1) {\n        const obj = arg1;\n        const ret = typeof obj === "number" ? obj : void 0;\n        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);\n        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);\n      },\n      __wbg___wbindgen_string_get_914df97fcfa788f2: function(arg0, arg1) {\n        const obj = arg1;\n        const ret = typeof obj === "string" ? obj : void 0;\n        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n        var len1 = WASM_VECTOR_LEN;\n        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);\n        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);\n      },\n      __wbg___wbindgen_throw_81fc77679af83bc6: function(arg0, arg1) {\n        throw new Error(getStringFromWasm0(arg0, arg1));\n      },\n      __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {\n        let deferred0_0;\n        let deferred0_1;\n        try {\n          deferred0_0 = arg0;\n          deferred0_1 = arg1;\n          console.error(getStringFromWasm0(arg0, arg1));\n        } finally {\n          wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);\n        }\n      },\n      __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {\n        const ret = arg0[arg1];\n        return ret;\n      },\n      __wbg_instanceof_ArrayBuffer_ff7c1337a5e3b33a: function(arg0) {\n        let result;\n        try {\n          result = arg0 instanceof ArrayBuffer;\n        } catch (_) {\n          result = false;\n        }\n        const ret = result;\n        return ret;\n      },\n      __wbg_instanceof_Uint8Array_4b8da683deb25d72: function(arg0) {\n        let result;\n        try {\n          result = arg0 instanceof Uint8Array;\n        } catch (_) {\n          result = false;\n        }\n        const ret = result;\n        return ret;\n      },\n      __wbg_length_0c32cb8543c8e4c8: function(arg0) {\n        const ret = arg0.length;\n        return ret;\n      },\n      __wbg_length_1e701798fdcaa3b4: function(arg0) {\n        const ret = arg0.length;\n        return ret;\n      },\n      __wbg_new_227d7c05414eb861: function() {\n        const ret = new Error();\n        return ret;\n      },\n      __wbg_new_4f9fafbb3909af72: function() {\n        const ret = new Object();\n        return ret;\n      },\n      __wbg_new_a560378ea1240b14: function(arg0) {\n        const ret = new Uint8Array(arg0);\n        return ret;\n      },\n      __wbg_new_with_length_41a22191b9bdfd66: function(arg0) {\n        const ret = new Uint32Array(arg0 >>> 0);\n        return ret;\n      },\n      __wbg_prototypesetcall_3e05eb9545565046: function(arg0, arg1, arg2) {\n        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);\n      },\n      __wbg_prototypesetcall_e42275e601e14eeb: function(arg0, arg1, arg2) {\n        Uint32Array.prototype.set.call(getArrayU32FromWasm0(arg0, arg1), arg2);\n      },\n      __wbg_set_448126769bf7c181: function(arg0, arg1, arg2) {\n        arg0.set(getArrayU32FromWasm0(arg1, arg2));\n      },\n      __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {\n        arg0[arg1] = arg2;\n      },\n      __wbg_set_8ee2d34facb8466e: function() {\n        return handleError(function(arg0, arg1, arg2) {\n          const ret = Reflect.set(arg0, arg1, arg2);\n          return ret;\n        }, arguments);\n      },\n      __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {\n        const ret = arg1.stack;\n        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);\n        const len1 = WASM_VECTOR_LEN;\n        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);\n        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);\n      },\n      __wbg_subarray_0f98d3fb634508ad: function(arg0, arg1, arg2) {\n        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);\n        return ret;\n      },\n      __wbg_subarray_d51e89458b3fdbf6: function(arg0, arg1, arg2) {\n        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);\n        return ret;\n      },\n      __wbindgen_cast_0000000000000001: function(arg0) {\n        const ret = arg0;\n        return ret;\n      },\n      __wbindgen_cast_0000000000000002: function(arg0, arg1) {\n        const ret = getStringFromWasm0(arg0, arg1);\n        return ret;\n      },\n      __wbindgen_init_externref_table: function() {\n        const table = wasm.__wbindgen_externrefs;\n        const offset = table.grow(4);\n        table.set(0, void 0);\n        table.set(offset + 0, void 0);\n        table.set(offset + 1, null);\n        table.set(offset + 2, true);\n        table.set(offset + 3, false);\n      }\n    };\n    return {\n      __proto__: null,\n      "./spark_worker_rs_bg.js": import0\n    };\n  }\n  const ChunkDecoderFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {\n  }, unregister: () => {\n  } } : new FinalizationRegistry((ptr) => wasm.__wbg_chunkdecoder_free(ptr >>> 0, 1));\n  function addToExternrefTable0(obj) {\n    const idx = wasm.__externref_table_alloc();\n    wasm.__wbindgen_externrefs.set(idx, obj);\n    return idx;\n  }\n  function debugString(val) {\n    const type = typeof val;\n    if (type == "number" || type == "boolean" || val == null) {\n      return `${val}`;\n    }\n    if (type == "string") {\n      return `"${val}"`;\n    }\n    if (type == "symbol") {\n      const description = val.description;\n      if (description == null) {\n        return "Symbol";\n      } else {\n        return `Symbol(${description})`;\n      }\n    }\n    if (type == "function") {\n      const name = val.name;\n      if (typeof name == "string" && name.length > 0) {\n        return `Function(${name})`;\n      } else {\n        return "Function";\n      }\n    }\n    if (Array.isArray(val)) {\n      const length = val.length;\n      let debug = "[";\n      if (length > 0) {\n        debug += debugString(val[0]);\n      }\n      for (let i = 1; i < length; i++) {\n        debug += ", " + debugString(val[i]);\n      }\n      debug += "]";\n      return debug;\n    }\n    const builtInMatches = /\\[object ([^\\]]+)\\]/.exec(toString.call(val));\n    let className;\n    if (builtInMatches && builtInMatches.length > 1) {\n      className = builtInMatches[1];\n    } else {\n      return toString.call(val);\n    }\n    if (className == "Object") {\n      try {\n        return "Object(" + JSON.stringify(val) + ")";\n      } catch (_) {\n        return "Object";\n      }\n    }\n    if (val instanceof Error) {\n      return `${val.name}: ${val.message}\n${val.stack}`;\n    }\n    return className;\n  }\n  function getArrayU32FromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);\n  }\n  function getArrayU8FromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);\n  }\n  let cachedDataViewMemory0 = null;\n  function getDataViewMemory0() {\n    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {\n      cachedDataViewMemory0 = new DataView(wasm.memory.buffer);\n    }\n    return cachedDataViewMemory0;\n  }\n  function getStringFromWasm0(ptr, len) {\n    ptr = ptr >>> 0;\n    return decodeText(ptr, len);\n  }\n  let cachedUint32ArrayMemory0 = null;\n  function getUint32ArrayMemory0() {\n    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {\n      cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);\n    }\n    return cachedUint32ArrayMemory0;\n  }\n  let cachedUint8ArrayMemory0 = null;\n  function getUint8ArrayMemory0() {\n    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {\n      cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);\n    }\n    return cachedUint8ArrayMemory0;\n  }\n  function handleError(f, args) {\n    try {\n      return f.apply(this, args);\n    } catch (e) {\n      const idx = addToExternrefTable0(e);\n      wasm.__wbindgen_exn_store(idx);\n    }\n  }\n  function isLikeNone(x) {\n    return x === void 0 || x === null;\n  }\n  function passStringToWasm0(arg, malloc, realloc) {\n    if (realloc === void 0) {\n      const buf = cachedTextEncoder.encode(arg);\n      const ptr2 = malloc(buf.length, 1) >>> 0;\n      getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);\n      WASM_VECTOR_LEN = buf.length;\n      return ptr2;\n    }\n    let len = arg.length;\n    let ptr = malloc(len, 1) >>> 0;\n    const mem = getUint8ArrayMemory0();\n    let offset = 0;\n    for (; offset < len; offset++) {\n      const code = arg.charCodeAt(offset);\n      if (code > 127) break;\n      mem[ptr + offset] = code;\n    }\n    if (offset !== len) {\n      if (offset !== 0) {\n        arg = arg.slice(offset);\n      }\n      ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;\n      const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);\n      const ret = cachedTextEncoder.encodeInto(arg, view);\n      offset += ret.written;\n      ptr = realloc(ptr, len, offset, 1) >>> 0;\n    }\n    WASM_VECTOR_LEN = offset;\n    return ptr;\n  }\n  function takeFromExternrefTable0(idx) {\n    const value = wasm.__wbindgen_externrefs.get(idx);\n    wasm.__externref_table_dealloc(idx);\n    return value;\n  }\n  let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });\n  cachedTextDecoder.decode();\n  const MAX_SAFARI_DECODE_BYTES = 2146435072;\n  let numBytesDecoded = 0;\n  function decodeText(ptr, len) {\n    numBytesDecoded += len;\n    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {\n      cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });\n      cachedTextDecoder.decode();\n      numBytesDecoded = len;\n    }\n    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));\n  }\n  const cachedTextEncoder = new TextEncoder();\n  if (!("encodeInto" in cachedTextEncoder)) {\n    cachedTextEncoder.encodeInto = function(arg, view) {\n      const buf = cachedTextEncoder.encode(arg);\n      view.set(buf);\n      return {\n        read: arg.length,\n        written: buf.length\n      };\n    };\n  }\n  let WASM_VECTOR_LEN = 0;\n  let wasm;\n  function __wbg_finalize_init(instance, module) {\n    wasm = instance.exports;\n    cachedDataViewMemory0 = null;\n    cachedUint32ArrayMemory0 = null;\n    cachedUint8ArrayMemory0 = null;\n    wasm.__wbindgen_start();\n    return wasm;\n  }\n  async function __wbg_load(module, imports) {\n    if (typeof Response === "function" && module instanceof Response) {\n      if (typeof WebAssembly.instantiateStreaming === "function") {\n        try {\n          return await WebAssembly.instantiateStreaming(module, imports);\n        } catch (e) {\n          const validResponse = module.ok && expectedResponseType(module.type);\n          if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {\n            console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\\n", e);\n          } else {\n            throw e;\n          }\n        }\n      }\n      const bytes = await module.arrayBuffer();\n      return await WebAssembly.instantiate(bytes, imports);\n    } else {\n      const instance = await WebAssembly.instantiate(module, imports);\n      if (instance instanceof WebAssembly.Instance) {\n        return { instance, module };\n      } else {\n        return instance;\n      }\n    }\n    function expectedResponseType(type) {\n      switch (type) {\n        case "basic":\n        case "cors":\n        case "default":\n          return true;\n      }\n      return false;\n    }\n  }\n  async function __wbg_init(module_or_path) {\n    if (wasm !== void 0) return wasm;\n    if (module_or_path !== void 0) {\n      if (Object.getPrototypeOf(module_or_path) === Object.prototype) {\n        ({ module_or_path } = module_or_path);\n      } else {\n        console.warn("using deprecated parameters for the initialization function; pass a single object instead");\n      }\n    }\n    if (module_or_path === void 0) {\n      module_or_path = new URL("data:application/wasm;base64,AGFzbQEAAAABlQM6YAN/f38Bf2ACf38Bf2ACf38AYAF/AGABfwF/YAN/f38AYAV/f39/fwBgBH9/f38AYAFvAX9gBn9/f39/fwBgAABgAX0BfWAEf39/fwF/YAADf39/YAJ/bwBgBX9/f39/AX9gAAF/YAJ/fwFvYAABb2ADb39/AW9gA39/bwBgAm9vAX9gCX9/f39/f39/fwBgB39/f39/f38AYAd/f39/f39/AX9gBn9/f39/fwF/YAV/f35/fwBgBX9/fH9/AGAFf399f38AYAACf39gA29vbwF/YANvb28AYANvf38AYAF/AW9gAm9vAW9gAW8Bb2ABfAFvYAR/f35+AGAEfn5/fwF+YAV/f39/fwF9YAR/f39/AX1gCX9/f39/f35+fgBgAn9+AX9gAX8BfWADf35+AGAGf39/fn9/AGAGf39/fH9/AGAGf39/fX9/AGAFf39/f28Df39/YAR/f39/A39/f2ABfgF/YAF/A39/f2ACf28Cf39gBH9+f38AYAR/fX9/AGAEf3x/fwBgA39vbwF/YAF8AX8CzQ8gFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzHF9fd2JnX0Vycm9yXzJlNTliMWIzN2E5YTM0YzMAERcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcxpfX3diZ19uZXdfNGY5ZmFmYmIzOTA5YWY3MgASFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzGl9fd2JnX3NldF84ZWUyZDM0ZmFjYjg0NjZlAB4XLi9zcGFya193b3JrZXJfcnNfYmcuanMaX193Ymdfc2V0XzZiZTQyNzY4YzY5MGUzODAAHxcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcx9fX3diZ19zdWJhcnJheV9kNTFlODk0NThiM2ZkYmY2ABMXLi9zcGFya193b3JrZXJfcnNfYmcuanMdX193YmdfbGVuZ3RoXzFlNzAxNzk4ZmRjYWEzYjQACBcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcxpfX3diZ19zZXRfNDQ4MTI2NzY5YmY3YzE4MQAgFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzJ19fd2JnX3Byb3RvdHlwZXNldGNhbGxfZTQyMjc1ZTYwMWUxNGVlYgAUFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzJl9fd2JnX25ld193aXRoX2xlbmd0aF80MWEyMjE5MWI5YmRmZDY2ACEXLi9zcGFya193b3JrZXJfcnNfYmcuanMdX193YmdfbGVuZ3RoXzBjMzJjYjg1NDNjOGU0YzgACBcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcx9fX3diZ19zdWJhcnJheV8wZjk4ZDNmYjYzNDUwOGFkABMXLi9zcGFya193b3JrZXJfcnNfYmcuanMnX193YmdfcHJvdG90eXBlc2V0Y2FsbF8zZTA1ZWI5NTQ1NTY1MDQ2ABQXLi9zcGFya193b3JrZXJfcnNfYmcuanMqX193YmdfX193YmluZGdlbl9pc19mYWxzeV9jNmRkZmFlMWJiNTZkNWVmAAgXLi9zcGFya193b3JrZXJfcnNfYmcuanMrX193YmdfX193YmluZGdlbl9pc19vYmplY3RfNDBjNWE4MDU3MmU4ZjlkMwAIFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzJ19fd2JnX2dldF93aXRoX3JlZl9rZXlfNjQxMmNmMzA5NDU5OTY5NAAiFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzLl9fd2JnX19fd2JpbmRnZW5faXNfdW5kZWZpbmVkX2MwY2NhNzJiODJiODZmNGQACBcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcyRfX3diZ19fX3diaW5kZ2VuX2luXzRiZDdhNTdlNTQzMzczNjYAFRcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcyxfX3diZ19fX3diaW5kZ2VuX251bWJlcl9nZXRfNzU3OWFhYjAyYThhNjIwYwAOFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzGl9fd2JnX25ld18yMjdkN2MwNTQxNGViODYxABIXLi9zcGFya193b3JrZXJfcnNfYmcuanMcX193Ymdfc3RhY2tfM2IwZDk3NGJiZjMxZTQ0ZgAOFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzHF9fd2JnX2Vycm9yX2E2ZmEyMDJiNThhYTFjZDMAAhcuL3NwYXJrX3dvcmtlcl9yc19iZy5qczBfX3diZ19fX3diaW5kZ2VuX2pzdmFsX2xvb3NlX2VxXzNhNzJhZTc2NGQ0NmQ5NDQAFRcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcy1fX3diZ19fX3diaW5kZ2VuX2Jvb2xlYW5fZ2V0X2E4NmMyMTY1NzVhNzVjMzAACBcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcyxfX3diZ19fX3diaW5kZ2VuX3N0cmluZ19nZXRfOTE0ZGY5N2ZjZmE3ODhmMgAOFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzLF9fd2JnX2luc3RhbmNlb2ZfVWludDhBcnJheV80YjhkYTY4M2RlYjI1ZDcyAAgXLi9zcGFya193b3JrZXJfcnNfYmcuanMtX193YmdfaW5zdGFuY2VvZl9BcnJheUJ1ZmZlcl9mZjdjMTMzN2E1ZTNiMzNhAAgXLi9zcGFya193b3JrZXJfcnNfYmcuanMaX193YmdfbmV3X2E1NjAzNzhlYTEyNDBiMTQAIxcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcydfX3diZ19fX3diaW5kZ2VuX3Rocm93XzgxZmM3NzY3OWFmODNiYzYAAhcuL3NwYXJrX3dvcmtlcl9yc19iZy5qcy5fX3diZ19fX3diaW5kZ2VuX2RlYnVnX3N0cmluZ19kZDVkMmQwN2NlOWU2YzU3AA4XLi9zcGFya193b3JrZXJfcnNfYmcuanMfX193YmluZGdlbl9pbml0X2V4dGVybnJlZl90YWJsZQAKFy4vc3Bhcmtfd29ya2VyX3JzX2JnLmpzIF9fd2JpbmRnZW5fY2FzdF8wMDAwMDAwMDAwMDAwMDAxACQXLi9zcGFya193b3JrZXJfcnNfYmcuanMgX193YmluZGdlbl9jYXN0XzAwMDAwMDAwMDAwMDAwMDIAEQOMA4oDBBYEFwUEBAEWBAcCAQcDBwcHJQEFAQkGGAICAgQBAwACCwEDAgYGBgYHBAwAAAEEBBgEBAIDAgIDBQUFBQkFAwABAAEBBAwEARkGAgIBAQUBAgALABcAAwMCASYFBgIAAwMEBCcAAAQoAQUDBSkBAgMDAgIFBAQEAgkDAQYEBwsFAQECAxAHAQ8EAQEGDAEBCwUBAQMFAQEACQYGAQALAwIJAQEBBAEDAAECASoDAgEBAgIEAQUGBgIrAQICAgECAQUFBQIEAgMsAwMCAQMDAQMDBgMJBgAFBQMDAgYAAAAAAgYCBwMCLQkuLwAGBwACAAUBAAIBAAsBAQIBAQUFAgEPBAQCDAoBMAEBAwExBAQyBAEBMwE0GQEBAQ8GGhwbAQEHDAA4BQADAQEBAgEBAQUDAQEBAQICAgEBAQECAgIEOQEGARAFAgICAQEBAgIBAgICAgICAgICAwQDCgMAAAAAAAAAAAAFBQUKAwICAgICAgICAgICAgoCAQECAgICAgIBAgQECgQQBQQLAnAB2gHaAW8AgAgFAwEAEQYJAX8BQYCAwAALB+oCEQZtZW1vcnkCABdfX3diZ19jaHVua2RlY29kZXJfZnJlZQB5E2NodW5rZGVjb2Rlcl9maW5pc2gAtAIRY2h1bmtkZWNvZGVyX3B1c2gAtgITZGVjb2RlX3RvX2V4dHNwbGF0cwCtAhZkZWNvZGVfdG9fcGFja2Vkc3BsYXRzAKgCDHNpbWRfZW5hYmxlZACoAw1zb3J0MzJfc3BsYXRzAMUCCndhc21fc3RhcnQApgIRX193YmluZGdlbl9tYWxsb2MAkgISX193YmluZGdlbl9yZWFsbG9jAKUCD19fd2JpbmRnZW5fZnJlZQD3ARRfX3diaW5kZ2VuX2V4bl9zdG9yZQD5AhdfX2V4dGVybnJlZl90YWJsZV9hbGxvYwClARVfX3diaW5kZ2VuX2V4dGVybnJlZnMBARlfX2V4dGVybnJlZl90YWJsZV9kZWFsbG9jAPkBEF9fd2JpbmRnZW5fc3RhcnQApgMJqAMBAEEBC9kBHx7kAuoC6gLiAqsBogHvAewBsgKzAu8CxAG3AboCmgPJAc8BetICcOAB2gGCArsCugG5AbwCvAK8AocCiAKMAr0CiQLCAo0CiAK+AooCvwKIAvUBuwK3AvQBxAKEAsMC8gHsAkK4AsECqgGhAdQBtgHsApsC0wJhuQIs+gHYAukC5AHKAvsBpwPNAdYC5wLRAckCgwLXAugC3AHLAtoC2wLxAe8C6wKjA5UD9AKpA+oClgPeAcsBlwPtAaACogOUApID9AKUAqkDiwOTA5QD6QGMA/0BT/ACgAGOA/8BggHyAuoBjQP+AWXxAoEBjwOAAtMB8wLnAaoCd5ADhQGiAu0CL3iRA4YBowLuAi3RAvEBiwKvAf4C2QLxAY4CsgH/AtkCTcYBgQOOArIBgAOQArMBggO8AcIBYpUCgwPZApsDpwKWAq4BhAPcAnS1AoUDhQLfAvcC5gHOAoYCzQHdAvUC0gHeAvYC3QHxAc0C0AGjA5wD9AKpA+0BiwOdA8ACjgKyAYYDzwKfAvgCoAPwAZwCzgHrAaMDngOaAX/2AZ8DDAEtCq+SD4oD1FMDFX8DfQF+IwBB4ABrIgokAAJAAkACQAJAIAAtAKRTRQRAIApBQGsgAEHYAGoQkgEgCi0AQARAIAooAkQhAQwDCyAKLQBBQQFHDQEgAEEBOgCkUwsgACgCYCIDRQ0AIABBnAFqIRQgCkHUAGqtQoCAgIDwAIQhGSAAQfAAaiEVIABB/ABqIRIDQAJAIAAoAmwiCSAAKAKgUyIBayICQQAgAiAJTRtBgIAETwRAIAEhAgwBCyABIAFBgIACayICQQAgASACTxsiBmshAiABIAZGBEAgACACNgKgUwwBCyABIAlNBEAgAgRAIAAoAmgiASABIAZqIAL8CgAACyAAKAJgIQMgACACNgKgUwwBC0EAIAEgCUHwzsEAEKYBAAsCQAJAIAMgDU8EQCAKQUBrIBQgACgCXCANaiADIA1rIAAoAmggACgCbCACECMgCiAKLQBEIgE6AAMgCigCQCETIAooAkgiEEUNAiAAKAKgUyIDIBBqIgIgA08gAiAAKAJsIglNcQ0BIAMgAiAJQfzBwAAQpgEACyANIAMgA0GMwsAAEKYBAAsgACgCaCEJIAAoAnAgACgCeCICayAQSQRAIBUgAiAQQQFBARDXASAAKAJ4IQILIBAEQCAAKAJ0IAJqIAMgCWogEPwKAAALIAAgAiAQaiIJNgJ4IAAgACgCoFMgEGo2AqBTAkACQAJAAkACQAJAIAAoAnxBf0YEQCAJQQ9NDQcgCiAAKAJ0IgIoAAAiAzYCECADQc6OzYIFRwRAIAogCkEQaq1CgICAgJABhDcDQCAKQRRqIgBBrLvAACAKQUBrEPgBIAAQrgIhAQwLCyAKIAIoAAQiBjYCICAGQQRrQXxNBEAgCiAKQSBqrUKAgICA8ACENwNAIApBJGoiAEGdiMAAIApBQGsQ+AEgABCuAiEBDAsLIAItAA0hCCACLQAMIQMgAigACCEEIAogAiwADiIHOgAzIAdBAEgNASAAQQA2AnggCUEQayIJBEAgCQRAIAIgAkEQaiAJ/AoAAAsgACAJNgJ4CyAKIAM2AlQgA0EDSw0DQYCAwAAQKSICRQ0CIAAgCDoAmQEgAEEAOgCYASAAQQA2ApQBIAAgAzYCkAEgACAENgKMASAAIAY2AogBIABBADYChAEgACACNgKAASAAQYCAEDYCfCAAIAQgAxB8IAAoAnxBf0YNBwsDQAJAAn8CQAJAAkACQAJAAkACQAJAAkACQAJAAkAgAC0AmAFBAWsOBgkIBwYAFAELQQkhEUEGIQEgACgCkAEOBAwEAwIBCyAAKAJ4QQZBCSAAKAKIASIDQQFGGyIMbiICIAAoAowBIAAoApQBayIJSQRAIAIiCUGAgARJDRMLQYCABCAJIAlBgIAETxsiCEEDbCICIAAoAoQBIgFLBH8gAiABayICIAAoAnwgAWtLBEAgEiABIAJBBEEEENcBIAAoAoQBIQELIAAoAoABIgYgAUECdGohAyACQQJPBH8gAkECdEEEayIEBEAgA0EAIAT8CwALIAEgAmoiAkEBayEBIAYgAkECdGpBBGsFIAMLQQA2AgAgACABQQFqNgKEASAAKAKIAQUgAwtBAUcNCCAJRQ0JQQAhAUEAIQJBACEDQQAhBANAIAFBAmoiByAAKAJ4IgZLBEAgASAHIAZBnLzAABCmAQALAn8gACgCdCABaiIGQQFqLQAAQQh0IgUgBi0AAHIiBkH//wFxRQRAIAZBEHQMAQsgBkH/B3EhBiAFQYCAAnEhCyAFQYD4AXEiBUGA+AFGBEAgC0EQdCIFQYCAgPwHciAGRQ0BGiAGQQ10IAVyQYCAgP4HcgwBCyALQRB0IgsgBUENdEGAgID8AHEgBkENdHJBgICAwANqciAFDQAaIAYgBmdBEGsiBkH//wNxQQhqdEH///8DcSALQYCAgNgDciAGQRd0a3ILIQYCfwJAAkAgACgChAEiBSADSwRAIAAoAoABIAJqIAY2AgAgAUEEaiIFIAAoAngiBksNASAAKAJ0IAFqIgZBA2otAABBCHQiByAGQQJqLQAAciIGQf//AXFFBEAgBkEQdAwECyAGQf8HcSEGIAdBgIACcSELIAdBgPgBcSIHQYD4AUYEQCALQRB0IgdBgICA/AdyIAZFDQQaIAZBDXQgB3JBgICA/gdyDAQLIAtBEHQhCyAHRQ0CIAdBDXRBgICA/ABxIAZBDXRyQYCAgMADaiALcgwDCyADIAVBzLvAABCRAgALIAcgBSAGQYy8wAAQpgEACyAGIAZnQRBrIgZB//8DcUEIanRB////A3EgC0GAgIDYA3IgBkEXdGtyCyEGAn8CQAJAIANBAWoiByAAKAKEASILSQRAIAAoAoABIAJqQQRqIAY2AgAgAUEGaiIGIAAoAngiB0sNASAAKAJ0IAFqIgFBBWotAABBCHQiByABQQRqLQAAciIBQf//AXFFBEAgAUEQdAwECyABQf8HcSEBIAdBgIACcSEFIAdBgPgBcSIHQYD4AUYEQCAFQRB0IgdBgICA/AdyIAFFDQQaIAFBDXQgB3JBgICA/gdyDAQLIAVBEHQhBSAHRQ0CIAdBDXRBgICA/ABxIAFBDXRyQYCAgMADaiAFcgwDCyAHIAtB3LvAABCRAgALIAUgBiAHQfy7wAAQpgEACyABIAFnQRBrIgFB//8DcUEIanRB////A3EgBUGAgIDYA3IgAUEXdGtyCyEBIANBAmoiByAAKAKEASIFSQRAIAAoAoABIAJqQQhqIAE2AgAgAkEMaiECIANBA2ohAyAGIQEgBEEBaiIEIAhJDQEMCwsLIAcgBUHsu8AAEJECAAtB3MDAABD9AgALQS0hEQwBC0EYIRELIAAoAnggEW4iAiAAKAKMASAAKAKUAWsiCUkEQCACIglBgIAESQ0PC0GAgAQgCSAJQYCABE8bIg4gEWwiCyAAKAKEASIBSwRAIAsgAWsiAiAAKAJ8IAFrSwRAIBIgASACQQRBBBDXASAAKAKEASEBCyAAKAKAASIGIAFBAnRqIQMgAkECTwR/IAJBAnRBBGsiBARAIANBACAE/AsACyABIAJqIgJBAWshASAGIAJBAnRqQQRrBSADC0EANgIAIAAgAUEBaiIBNgKEAQsgDkEJbCEPAkAgCQRAIA5B4ABsIQcgDkEYbCEGQQAhDEEAIQgCQANAIAggEWwiASAAKAJ4IgJPDQMCQAJAAkACQCAIQQlsIgMgACgChAEiAk8NACAAKAKAASADQQJ0aiAAKAJ0IAFqLQAAs0MAAADDkkMAAAA8lDgCACABQQNqIgQgACgCeCICTwRAIAQhAQwICyADQQNqIgUgACgChAEiAk8EQCAFIQMMAQsgACgCgAEgBUECdGogACgCdCAEai0AALNDAAAAw5JDAAAAPJQ4AgAgAUEGaiIEIAAoAngiAk8EQCAEIQEMCAsgA0EGaiIFIAAoAoQBIgJPBEAgBSEDDAELIAAoAoABIAVBAnRqIAAoAnQgBGotAACzQwAAAMOSQwAAADyUOAIAIAFBAWoiBCAAKAJ4IgJPBEAgBCEBDAgLIANBAWoiBSAAKAKEASICTwRAIAUhAwwBCyAAKAKAASAFQQJ0aiAAKAJ0IARqLQAAs0MAAADDkkMAAAA8lDgCACABQQRqIgQgACgCeCICTwRAIAQhAQwICyADQQRqIgUgACgChAEiAk8EQCAFIQMMAQsgACgCgAEgBUECdGogACgCdCAEai0AALNDAAAAw5JDAAAAPJQ4AgAgAUEHaiIEIAAoAngiAk8EQCAEIQEMCAsgA0EHaiIFIAAoAoQBIgJPBEAgBSEDDAELIAAoAoABIAVBAnRqIAAoAnQgBGotAACzQwAAAMOSQwAAADyUOAIAIAFBAmoiBCAAKAJ4IgJPBEAgBCEBDAgLIANBAmoiBSAAKAKEASICTwRAIAUhAwwBCyAAKAKAASAFQQJ0aiAAKAJ0IARqLQAAs0MAAADDkkMAAAA8lDgCACABQQVqIgQgACgCeCICTwRAIAQhAQwICyADQQVqIgUgACgChAEiAk8EQCAFIQMMAQsgACgCgAEgBUECdGogACgCdCAEai0AALNDAAAAw5JDAAAAPJQ4AgAgAUEIaiIEIAAoAngiAk8EQCAEIQEMCAsgA0EIaiIDIAAoAoQBIgJPDQAgACgCgAEgA0ECdGogACgCdCAEai0AALNDAAAAw5JDAAAAPJQ4AgAgACgCkAFBAUsNAQwCCyADIAJB7MHAABCRAgALAkACQCABQQlqIgMgACgCeCIFTw0AIAhBD2wgD2oiAiAAKAKEASIFTw0DIAAoAoABIAJBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBDGoiAyAAKAJ4IgVPDQAgAkEDaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBD2oiAyAAKAJ4IgVPDQAgAkEGaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBEmoiAyAAKAJ4IgVPDQAgAkEJaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBFWoiAyAAKAJ4IgVPDQAgAkEMaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBCmoiAyAAKAJ4IgVPDQAgAkEBaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBDWoiAyAAKAJ4IgVPDQAgAkEEaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBEGoiAyAAKAJ4IgVPDQAgAkEHaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBE2oiAyAAKAJ4IgVPDQAgAkEKaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBFmoiAyAAKAJ4IgVPDQAgAkENaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBC2oiAyAAKAJ4IgVPDQAgAkECaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBDmoiAyAAKAJ4IgVPDQAgAkEFaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBEWoiAyAAKAJ4IgVPDQAgAkEIaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBFGoiAyAAKAJ4IgVPDQAgAkELaiIEIAAoAoQBIgVPBEAgBCECDAQLIAAoAoABIARBAnRqIAAoAnQgA2otAACzQwAAAMOSQwAAADyUOAIAIAFBF2oiAyAAKAJ4IgVPDQAgAkEOaiICIAAoAoQBIgVPDQMgACgCgAEgAkECdGogACgCdCADai0AALNDAAAAw5JDAAAAPJQ4AgAgACgCkAFBAk0NAkEAIQUgByEDDAELIAMgBUG8wcAAEJECAAsCQAJAAkACQAJAAkACQAJ/AkACQAJAAkACQAJAA0AgACgCeCICIAUgDGoiAUEYaksEQCAFIAZqIgQgACgChAEiAk8NDyAAKAKAASADaiABIAAoAnRqQRhqLQAAs0MAAADDkkMAAAA8lDgCACAAKAJ4IgIgAUEbak0NByAAKAKEASICIARBA2pNDQ4gACgCgAEgA2pBDGogASAAKAJ0akEbai0AALNDAAAAw5JDAAAAPJQ4AgAgACgCeCICIAFBHmpNDQYgACgChAEiAiAEQQZqTQ0NIAAoAoABIANqQRhqIAEgACgCdGpBHmotAACzQwAAAMOSQwAAADyUOAIAIAAoAngiAiABQSFqTQ0FIAAoAoQBIgIgBEEJak0NDCAAKAKAASADakEkaiABIAAoAnRqQSFqLQAAs0MAAADDkkMAAAA8lDgCACAAKAJ4IgIgAUEkak0NBCAAKAKEASICIARBDGpNDQsgACgCgAEgA2pBMGogASAAKAJ0akEkai0AALNDAAAAw5JDAAAAPJQ4AgAgACgCeCICIAFBJ2pNDQMgACgChAEiAiAEQQ9qTQ0KIAAoAoABIANqQTxqIAEgACgCdGpBJ2otAACzQwAAAMOSQwAAADyUOAIAIAAoAngiAiABQSpqTQ0CIAAoAoQBIgIgBEESak0NCSAAKAKAASADakHIAGogACgCdCAMaiAFakEqai0AALNDAAAAw5JDAAAAPJQ4AgAgA0EEaiEDIAVBAWoiAiEFIAJBA0cNAQwQCwsgAUEYagwGCyABQSpqDAULIAFBJ2oMBAsgAUEkagwDCyABQSFqDAILIAFBHmoMAQsgAUEbagsgAkGcwcAAEJECAAsgBEESaiEEDAULIARBD2ohBAwECyAEQQxqIQQMAwsgBEEJaiEEDAILIARBBmohBAwBCyAEQQNqIQQLIAQgAkGswcAAEJECAAsgDCARaiEMIAZBFWohBiAHQdQAaiEHIAhBAWoiCCAORg0CDAELCyACIAVBzMHAABCRAgALIAAoAoQBIQELAkACQAJAAkACQAJAIAEgD08EQCAAKAKAASEEIAAoApQBIQhBBCECQQAhBQJAIAAoApABIgdBAkkEQEEAIQZBBCEMDAELIA5BGGwiAyABSw0CIA5BD2whBiAEIA9BAnRqIQwgB0ECRg0AIAEgC0kgAyALS3INBSALIANrIQUgBCADQQJ0aiECCyAAIAggDiAEIA8gDCAGIAIgBRAhIAAoAngiAiALSQ0CIABBADYCeCACIAtrIQEgCUUNAyACIAtGDQYgAUUNBSAAKAJ0IgIgAiALaiAB/AoAAAwFC0EAIA8gAUGMwcAAEKYBAAsgDyADIAFB/MDAABCmAQALQQAgCyACQfDOwQAQpgEACyACIAtHDQEMAgsgAyALIAFB7MDAABCmAQALIAAgATYCeAsgACAAKAKUASAOaiICNgKUASACIAAoAowBRw0JQQYMBwsgASACQdzBwAAQkQIACyAAKAJ4QQRBAyAAKAKIASIDQQNGGyIObiICIAAoAowBIAAoApQBayIJSQRAIAIiCUGAgARJDQ4LAkACQAJAAkACQAJAAkACQAJAAkACQEGAgAQgCSAJQYCABE8bIgZBAnQiAiAAKAKEASIBSwR/IAIgAWsiAiAAKAJ8IAFrSwRAIBIgASACQQRBBBDXASAAKAKEASEBCyAAKAKAASIEIAFBAnRqIQMgAkECTwR/IAJBAnRBBGsiCARAIANBACAI/AsACyABIAJqIgJBAWshASAEIAJBAnRqQQRrBSADC0EANgIAIAAgAUEBajYChAEgACgCiAEFIAMLQQNHBEAgCUUNC0EAIQFBACECQQAhA0EAIQQDQCABIAAoAngiCE8NAyABQQFqIgcgCE8NBCABQQJqIgcgCE8NBSADIAAoAoQBIghPDQYgACgCdCABaiIIQQFqLQAAIQcgCEECai0AACEFIAAoAoABIAJqIAgtAACzQwAA/0KVQwAAgL+SIhY4AgAgA0EBaiIIIAAoAoQBIgtPDQcgACgCgAEgAmpBBGogB7NDAAD/QpVDAACAv5IiFzgCACADQQJqIgggACgChAEiB08NCCAAKAKAASACakEIaiAFs0MAAP9ClUMAAIC/kiIYOAIAIANBA2oiCCAAKAKEASIHTw0CIAAoAoABIAJqQQxqQwAAAABDAACAPyAWIBaUIBcgF5SSIBggGJSSkyIWIBYgFlwbIhZDAAAAACAWQwAAAABeG5E4AgAgAUEDaiEBIAJBEGohAiADQQRqIQMgBEEBaiIEIAZJDQALDAsLIAlFDQpBACECQQAhA0EAIQwDQAJAAkACQAJAIAAoAngiASADSwRAIANBAWoiCCABTw0BIANBAmoiByABTw0CIANBA2oiBSABTw0DIAAoAnQgA2oiAUECai0AACERIAFBA2otAAAhBCABLQAAIAFBAWotAAAhCyAK/QwAAAAAAAAAAAAAAAAAAAAA/QsDQCALQQh0ciIPIBFBEHQgBEEYdHJyIQFDAAAAACEWAn0gCgJ/AkAgBEEGdiIEQQNHBEAgCiAPQf8DcbNDAID/Q5VD8wQ1P5QiFowgFiALQQJxGyIWOAJMIBYgFpQhFiABQQp2IQEgBEECRg0BCyAKIAFB/wNxs0MAgP9DlUPzBDU/lCIXjCAXIAFBgARxGyIXOAJIIBYgFyAXlJIhFiABQQp2IgEgBEEBRg0BGgsgCiABQf8DcbNDAID/Q5VD8wQ1P5QiF4wgFyABQYAEcRsiFzgCRCAWIBcgF5SSIhYgBEUNARogAUEKdgsiAUH/A3GzQwCA/0OVQ/MENT+UIheMIBcgAUGABHEbIhc4AkAgFiAXIBeUkgshFiAKQUBrIARBAnRqQwAAgD8gFpMiFpFDAAAAACAWQwAAAABeGzgCACADIAAoAoQBIgFJDQQgAyABQay/wAAQkQIACyADIAFB7L7AABCRAgALIAggAUH8vsAAEJECAAsgByABQYy/wAAQkQIACyAFIAFBnL/AABCRAgALIAAoAoABIAJqIAoqAkA4AgAgCCAAKAKEASIBTw0KIAAoAoABIAJqQQRqIAoqAkQ4AgAgByAAKAKEASIBTw0JIAAoAoABIAJqQQhqIAoqAkg4AgAgBSAAKAKEASIBTw0IIAAoAoABIAJqQQxqIAoqAkw4AgAgAkEQaiECIANBBGohAyAGIAxBAWoiDEsNAAsMCgsgCCAHQczAwAAQkQIACyABIAhB7L/AABCRAgALIAcgCEH8v8AAEJECAAsgByAIQYzAwAAQkQIACyADIAhBnMDAABCRAgALIAggC0GswMAAEJECAAsgCCAHQbzAwAAQkQIACyAFIAFB3L/AABCRAgALIAcgAUHMv8AAEJECAAsgCCABQby/wAAQkQIACyAAIAAoApQBIAYgACgCgAEgACgChAEQrAECQAJAAkAgACgCeCIBIAYgDmwiAk8EQCAAQQA2AnggASACayEDIAlFDQEgASACRg0DIANFDQIgACgCdCIBIAEgAmogA/wKAAAMAgsMFQsgASACRg0BCyAAIAM2AngLIAAgACgClAEgBmoiAjYClAEgAiAAKAKMAUcNB0EFDAULIAAoAngiAUEDbiICIAAoAowBIAAoApQBayIGSQRAIAIhBiABQYCADEkNDQtBgIAEIAYgBkGAgARPGyIEQQNsIgkgACgChAEiAUsEQCAJIAFrIgIgACgCfCABa0sEQCASIAEgAkEEQQQQ1wEgACgChAEhAQsgACgCgAEiCCABQQJ0aiEDIAJBAk8EfyACQQJ0QQRrIgcEQCADQQAgB/wLAAsgASACaiICQQFrIQEgCCACQQJ0akEEawUgAwtBADYCACAAIAFBAWoiATYChAELAkACQAJAAkACQAJAAkACQAJAIAYEQEEAIQNBACEBA0AgASAAKAJ4IgJPDQQgASAAKAKEASICTw0FIAAoAoABIANqIAAoAnQgAWotAACzQwAAgD2UQwAAIMGSEHM4AgAgAUEBaiICIAAoAngiCE8NBiACIAAoAoQBIghPDQcgACgCgAEgA2pBBGogACgCdCABakEBai0AALNDAACAPZRDAAAgwZIQczgCACABQQJqIgIgACgCeCIITw0IIAIgACgChAEiCE8NAiAAKAKAASADakEIaiAAKAJ0IAFqQQJqLQAAs0MAAIA9lEMAACDBkhBzOAIAIANBDGohAyAJIAFBA2oiAUcNAAsgACgChAEhAQsgACAAKAKUASAEIAAoAoABIAEQRSAAKAJ4IgIgCUkNGyAAQQA2AnggAiAJayEBIAZFDQEgAiAJRg0IIAFFDQcgACgCdCICIAIgCWogAfwKAAAMBwsgAiAIQdy+wAAQkQIACyACIAlHDQUMBgsgASACQYy+wAAQkQIACyABIAJBnL7AABCRAgALIAIgCEGsvsAAEJECAAsgAiAIQby+wAAQkQIACyACIAhBzL7AABCRAgALIAAgATYCeAsgACAAKAKUASAEaiICNgKUASACIAAoAowBRw0GQQQMBAsgACgCeCIBQQNuIgIgACgCjAEgACgClAFrIgZJBEAgAiEGIAFBgIAMSQ0MC0GAgAQgBiAGQYCABE8bIgRBA2wiCSAAKAKEASIBSwRAIAkgAWsiAiAAKAJ8IAFrSwRAIBIgASACQQRBBBDXASAAKAKEASEBCyAAKAKAASIIIAFBAnRqIQMgAkECTwR/IAJBAnRBBGsiBwRAIANBACAH/AsACyABIAJqIgJBAWshASAIIAJBAnRqQQRrBSADC0EANgIAIAAgAUEBaiIBNgKEAQsCQAJAAkACQAJAAkACQAJAAkAgBgRAQQAhA0EAIQEDQCABIAAoAngiAk8NBCABIAAoAoQBIgJPDQUgACgCgAEgA2ogACgCdCABai0AALNDAAB/Q5VDAAAAv5JDjLjwP5RDAAAAP5I4AgAgAUEBaiICIAAoAngiCE8NBiACIAAoAoQBIghPDQcgACgCgAEgA2pBBGogACgCdCABakEBai0AALNDAAB/Q5VDAAAAv5JDjLjwP5RDAAAAP5I4AgAgAUECaiICIAAoAngiCE8NCCACIAAoAoQBIghPDQIgACgCgAEgA2pBCGogACgCdCABakECai0AALNDAAB/Q5VDAAAAv5JDjLjwP5RDAAAAP5I4AgAgA0EMaiEDIAkgAUEDaiIBRw0ACyAAKAKEASEBCyAAIAAoApQBIAQgACgCgAEgARBHIAAoAngiAiAJSQ0aIABBADYCeCACIAlrIQEgBkUNASACIAlGDQggAUUNByAAKAJ0IgIgAiAJaiAB/AoAAAwHCyACIAhB/L3AABCRAgALIAIgCUcNBQwGCyABIAJBrL3AABCRAgALIAEgAkG8vcAAEJECAAsgAiAIQcy9wAAQkQIACyACIAhB3L3AABCRAgALIAIgCEHsvcAAEJECAAsgACABNgJ4CyAAIAAoApQBIARqIgI2ApQBIAIgACgCjAFHDQVBAwwDCyAAKAJ4IgIgACgCjAEgACgClAFrIglJBEAgAiIJQYCABEkNCwtBgIAEIAkgCUGAgARPGyIGIAAoAoQBIgFLBEAgBiABayICIAAoAnwgAWtLBEAgEiABIAJBBEEEENcBIAAoAoQBIQELIAAoAoABIgQgAUECdGohAyACQQJPBH8gAkECdEEEayIIBEAgA0EAIAj8CwALIAEgAmoiAkEBayEBIAQgAkECdGpBBGsFIAMLQQA2AgAgACABQQFqNgKEAQsCQCAJBEBBACEBQQAhAwJAAkADQCABIAAoAngiAk8NASABIAAoAoQBIgJPDQIgACgCgAEgA2ogACgCdCABai0AALNDAAB/Q5U4AgAgA0EEaiEDIAFBAWoiAiEBIAIgBkcNAAsgACgCgAEhDiAAKAKEASEDIAAgACgClAEgBhCgAUEAIQFBDCEFIAYhCCADIQIDQAJAAkAgACgCKCIEIAFBA2pLBEAgAgRAIAEgDmooAgAiC0H///8DcSEMIAtBgICAgHhxIQQgC0GAgID8B3EiB0GAgID8B0YEQCAEQRB2IAxBDXZyQYAEQQAgDBtyQYD4AXIhBAwECyAEQRB2IQQgB0GAgIC4BEsNAiAHQYCAgMQDTwRAIAtBDHYgC0H/3wBxQQBHcSAHQQ12IAxBDXZqQYCAAWogBHJqIQQMBAsgB0GAgICYA0kNAyAMQYCAgARyIgtB/gAgB0EXdiIMa3YhByALQR0gDGsiDHZBAXEEfyAHQQMgDHRBAWsgC3FBAEdqBSAHCyAEciEEDAMLIAMgA0HAxsAAEJECAAsgASABQQRqIARB0MbAABCmAQALIARBgPgBciEECyAAKAIkIAVqIARB//8DcTYCACAFQRBqIQUgAkEBayECIAFBBGohASAIQQFrIggNAAsMAwsgASACQYy9wAAQkQIACyABIAJBnL3AABCRAgALIAAgACgClAEgBhCgAQsgAEEBOgBUAkACQAJAIAYgACgCeCICTQRAIABBADYCeCACIAZrIQEgCUUNASACIAZGDQMgAUUNAiAAKAJ0IgIgAiAGaiAB/AoAAAwCC0EAIAYgAkHwzsEAEKYBAAsgAiAGRg0BCyAAIAE2AngLIAAgACgClAEgBmoiAjYClAEgAiAAKAKMAUcNBEECDAILIAlFDQBBASAALQCZAXSzIRZBACEBQQAhAkEAIQNBACEEAkACQAJAAkADQCABQQNqIgYgACgCeCIHSwRAIAEgBiAHQfy8wAAQpgEACyADIAAoAoQBIgdPDQEgACgCgAEgAmogACgCdCABaiIHQQJqLQAAIgVBEHQgBy0AAHIgB0EBai0AAEEIdHIiB0GAgIB4ciAHIAXAQQBIG7IgFpU4AgAgAUEGaiIHIAAoAngiBUsNAiADQQFqIgYgACgChAEiBU8NAyAAKAKAASACakEEaiAAKAJ0IAFqIgZBBWotAAAiBUEQdCAGQQNqLQAAciAGQQRqLQAAQQh0ciIGQYCAgHhyIAYgBcBBAEgbsiAWlTgCACABQQlqIgYgACgCeCIFSw0EIANBAmoiByAAKAKEASIFSQRAIAAoAoABIAJqQQhqIAAoAnQgAWoiAUEIai0AACIHQRB0IAFBBmotAAByIAFBB2otAABBCHRyIgFBgICAeHIgASAHwEEASBuyIBaVOAIAIAJBDGohAiADQQNqIQMgBiEBIARBAWoiBCAISQ0BDAYLCyAHIAVBzLzAABCRAgALIAMgB0GsvMAAEJECAAsgBiAHIAVB7LzAABCmAQALIAYgBUG8vMAAEJECAAsgByAGIAVB3LzAABCmAQALIAAoAoQBIQcgACgCgAEhASAAIAAoApQBIAgQoAECQAJAAkACQCAJBEBBACEEQQEhAiAIIQZBACEFA0AgBEEEaiIDIAAoAigiC0sNAiACQQFrIgQgB08EQCAEIQIMDgsgByAEayIEQQAgBCAHTRsiBEEBRg0NIARBAkYNDCABKAIAIQQgACgCJCAFaiILQQRqIAFBBGopAgA3AgAgCyAENgIAIAJBA2ohAiABQQxqIQEgBUEQaiEFIAMhBCAGQQFrIgYNAAsLIABBAToAVCAAKAJ4IgEgCCAMbCICSQ0RIABBADYCeCABIAJrIQMgCUUNASABIAJGDQMgA0UNAiAAKAJ0IgEgASACaiAD/AoAAAwCCyAEIAMgC0GwxsAAEKYBAAsgASACRg0BCyAAIAM2AngLIAAgACgClAEgCGoiAjYClAEgAiAAKAKMAUcNAkEBCyEBIABBADYClAELIAAgAToAmAEMAAsACyAKIApBM2qtQoCAgICgAYQ3A0AgCkE0aiIAQYC7wAAgCkFAaxD4ASAAEK4CIQEMCAtBBEGAgMAAEMwCAAsgCiAZNwNYIApBQGsiAEHHicAAIApB2ABqEPgBIAAQrwIhAQwGCyACQQFqIQILIAIgB0GQr8AAEJECAAsgCi0AAyEBCyANIBNqIQ0CQAJAAkACQAJAIAFB/wFxDgMBAgMACyAKIApBA2qtQoCAgICwAYQ3A0AgCkEEaiIAQd2JwAAgCkFAaxD4ASAAEK4CIQEMBgsgAEEBOgClUyANQQhqIA0gACgCYCICIA1rIgFBACABIAJNG0EHSxshDQwCCyAQIBNyRQ0BCyANIAAoAmAiA0kNAQsLIA1FDQAgDSAAKAJgIgJNBEBBACEBIABBADYCYCACIA1GDQIgAiANayICBEAgACgCXCIDIAMgDWogAvwKAAALIAAgAjYCYAwCC0EAIA0gAkHwzsEAEKYBAAtBACEBCyAKQeAAaiQAIAEPC0EAIAIgAUHwzsEAEKYBAAtBACAJIAJB8M7BABCmAQALrFMDB30YfxN7IwBBEGsiFCQAAkACQAJAAkACQAJAAkACQCAERQ0AIAAQvwEgAEEAOgBUIABCADcCTCACQQJ0IhUhEiAAKAIoIhAgFUkEQCAVIBBrIhIgACgCICAQa0sEQCAAQSBqIBAgEkEEQQQQ1wEgACgCKCEQCyAAKAIkIhYgEEECdGohEyASQQJPBH8gEkECdEEEayIRBEAgE0EAIBH8CwALIBAgEmoiEkEBayEQIBYgEkECdGpBBGsFIBMLQQA2AgAgEEEBaiESCyAAIBI2AiggACgCAEEBRw0AAkACQCASIBVPBEAgACgCJCEWIAJFDQJBACESIAJBCCAEIARBCE0bQQluIhAgAiAQSRsiEyAEIARBAUciEUF/c2pBCW4gEWoiESARIBNLGyITIARBAmsiEUEAIAQgEU8bIARBAksiEWtBCW4gEWoiESARIBNLGyITIARBA2siEUEAIAQgEU8bIARBA0siEWtBCW4gEWoiESARIBNLGyITIARBBGsiEUEAIAQgEU8bIARBBEsiEWtBCW4gEWoiESARIBNLGyITIARBBWsiEUEAIAQgEU8bIARBBUsiEWtBCW4gEWoiESARIBNLGyITIARBBmsiEUEAIAQgEU8bIARBBksiEWtBCW4gEWoiESARIBNLGyITIARBB2siEUEAIAQgEU8bIARBB0siEWtBCW4gEWoiESARIBNLGyITIAJBAWsiESARIBNLGyITIARBAWtBCW4iG0EBaiIRIBEgE0sbIhNBA00NASATQQFqIhJBA3EiEUEEIBEbIhggE0F/c2ohESASIBhrIRL9DAAAAAABAAAAAgAAAAMAAAAhLwNAIAMgL/0MCQAAAAkAAAAJAAAACQAAAP21ASIp/QwBAAAAAQAAAAEAAAABAAAA/a4BIiz9GwNBAnRqIAMgLP0bAkECdGogAyAs/RsBQQJ0aiADICz9GwBBAnRq/VwCAP1WAgAB/VYCAAL9VgIAAyIw/eABIiwgAyAp/QwCAAAAAgAAAAIAAAACAAAA/a4BIiv9GwNBAnRqIAMgK/0bAkECdGogAyAr/RsBQQJ0aiADICv9GwBBAnRq/VwCAP1WAgAB/VYCAAL9VgIAAyIx/eABIij9HwAiCiAs/R8AIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGyIKIAMgKf0bA0ECdGogAyAp/RsCQQJ0aiADICn9GwFBAnRqIAMgKf0bAEECdGr9XAIA/VYCAAH9VgIAAv1WAgADIjL94AEiKv0fACIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsQsAH9EyAo/R8BIgogLP0fASIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAq/R8BIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCwAf0gASAo/R8CIgogLP0fAiIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAq/R8CIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCwAf0gAiAo/R8DIgogLP0fAyIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAq/R8DIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCwAf0gA/1o/QwAAHBBAABwQQAAcEEAAHBBIjP95AEiLCAs/QwAAAAAAAAAAAAAAAAAAAAAIiz9Q/1P/QwAAPhBAAD4QQAA+EEAAPhBIjf96gEiK/0fABCXAv0TICv9HwEQlwL9IAEgK/0fAhCXAv0gAiAr/R8DEJcC/SAD/fgBIjT9DPH////x////8f////H///8iOP2uASIr/RsAENkB/RMgK/0bARDZAf0gASAr/RsCENkB/SACICv9GwMQ2QH9IAP9DAAAf0MAAH9DAAB/QwAAf0MiK/3nASIu/ecBICv96gEiLf0fABCXAiEKIC39HwEQlwIhCSAt/R8CEJcCIQsgLf0fAxCXAiEMIBYgL0EC/asBIi39GwBBAnRqIhMgKiAu/ecBICv96gEiKv0fABCXAv0TICr9HwEQlwL9IAEgKv0fAhCXAv0gAiAq/R8DEJcC/SAD/fkBIDRBG/2rASAyICz9Q/0MAAAAAQAAAAEAAAABAAAAASIy/U79UCAwICz9Q/0MAAAAAgAAAAIAAAACAAAAAiIw/U79UCAxICz9Q/0MAAAABAAAAAQAAAAEAAAABCIx/U79UP1QIAr9EyAJ/SABIAv9IAIgDP0gA/35AUEI/asB/VAgKCAu/ecBICv96gEiKP0fABCXAv0TICj9HwEQlwL9IAEgKP0fAhCXAv0gAiAo/R8DEJcC/SAD/fkBQRD9qwH9UCIo/VoCAAAgFiAt/RsBQQJ0aiIYICj9WgIAASAWIC39GwJBAnRqIhcgKP1aAgACIBYgLf0bA0ECdGoiHCAo/VoCAAMgAyAp/QwEAAAABAAAAAQAAAAEAAAAIjT9rgEiKP0bA0ECdGogAyAo/RsCQQJ0aiADICj9GwFBAnRqIAMgKP0bAEECdGr9XAIA/VYCAAH9VgIAAv1WAgADIjX94AEiKCADICn9DAUAAAAFAAAABQAAAAUAAAD9rgEiKv0bA0ECdGogAyAq/RsCQQJ0aiADICr9GwFBAnRqIAMgKv0bAEECdGr9XAIA/VYCAAH9VgIAAv1WAgADIjb94AEiKv0fACIKICj9HwAiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bIgogAyAp/QwDAAAAAwAAAAMAAAADAAAA/a4BIi39GwNBAnRqIAMgLf0bAkECdGogAyAt/RsBQQJ0aiADIC39GwBBAnRq/VwCAP1WAgAB/VYCAAL9VgIAAyI5/eABIi39HwAiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bELAB/RMgKv0fASIKICj9HwEiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bIgogLf0fASIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsQsAH9IAEgKv0fAiIKICj9HwIiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bIgogLf0fAiIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsQsAH9IAIgKv0fAyIKICj9HwMiCSAJIAlcGyIJIAkgCiAKIApcGyIKIAkgCl4bIgogLf0fAyIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsQsAH9IAP9aCAz/eQBIiggKCAs/UP9TyA3/eoBIij9HwAQlwL9EyAo/R8BEJcC/SABICj9HwIQlwL9IAIgKP0fAxCXAv0gA/34ASI6IDj9rgEiKP0bABDZAf0TICj9GwEQ2QH9IAEgKP0bAhDZAf0gAiAo/RsDENkB/SADICv95wEiLv3nASAr/eoBIij9HwAQlwIhCiAo/R8BEJcCIQkgKP0fAhCXAiELICj9HwMQlwIhDCATIC0gLv3nASAr/eoBIij9HwAQlwL9EyAo/R8BEJcC/SABICj9HwIQlwL9IAIgKP0fAxCXAv0gA/35ASA6QRv9qwEgOSAs/UMgMv1O/VAgNSAs/UMgMP1O/VAgNiAs/UMgMf1O/VD9UCAK/RMgCf0gASAL/SACIAz9IAP9+QFBCP2rAf1QICogLv3nASAr/eoBIij9HwAQlwL9EyAo/R8BEJcC/SABICj9HwIQlwL9IAIgKP0fAxCXAv0gA/35AUEQ/asB/VAiKP1aAgQAIBggKP1aAgQBIBcgKP1aAgQCIBwgKP1aAgQDIAMgKf0MBwAAAAcAAAAHAAAABwAAAP2uASIo/RsDQQJ0aiADICj9GwJBAnRqIAMgKP0bAUECdGogAyAo/RsAQQJ0av1cAgD9VgIAAf1WAgAC/VYCAAMiLv3gASIoIAMgKf0MCAAAAAgAAAAIAAAACAAAAP2uASIq/RsDQQJ0aiADICr9GwJBAnRqIAMgKv0bAUECdGogAyAq/RsAQQJ0av1cAgD9VgIAAf1WAgAC/VYCAAMiNf3gASIq/R8AIgogKP0fACIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiADICn9DAYAAAAGAAAABgAAAAYAAAD9rgEiKf0bA0ECdGogAyAp/RsCQQJ0aiADICn9GwFBAnRqIAMgKf0bAEECdGr9XAIA/VYCAAH9VgIAAv1WAgADIjb94AEiKf0fACIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsQsAH9EyAq/R8BIgogKP0fASIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAp/R8BIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCwAf0gASAq/R8CIgogKP0fAiIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAp/R8CIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCwAf0gAiAq/R8DIgogKP0fAyIJIAkgCVwbIgkgCSAKIAogClwbIgogCSAKXhsiCiAp/R8DIgkgCSAJXBsiCSAJIAogCiAKXBsiCiAJIApeGxCwAf0gA/1oIDP95AEiKCAoICz9Q/1PIDf96gEiKP0fABCXAv0TICj9HwEQlwL9IAEgKP0fAhCXAv0gAiAo/R8DEJcC/SAD/fgBIjMgOP2uASIo/RsAENkB/RMgKP0bARDZAf0gASAo/RsCENkB/SACICj9GwMQ2QH9IAMgK/3nASIt/ecBICv96gEiKP0fABCXAiEKICj9HwEQlwIhCSAo/R8CEJcCIQsgKP0fAxCXAiEMIBMgKSAt/ecBICv96gEiKf0fABCXAv0TICn9HwEQlwL9IAEgKf0fAhCXAv0gAiAp/R8DEJcC/SAD/fkBIDNBG/2rASA2ICz9QyAy/U79UCAuICz9QyAw/U79UCA1ICz9QyAx/U79UP1QIAr9EyAJ/SABIAv9IAIgDP0gA/35AUEI/asB/VAgKiAt/ecBICv96gEiKf0fABCXAv0TICn9HwEQlwL9IAEgKf0fAhCXAv0gAiAp/R8DEJcC/SAD/fkBQRD9qwH9UCIp/VoCCAAgGCAp/VoCCAEgFyAp/VoCCAIgHCAp/VoCCAMgLyA0/a4BIS8gEUEEaiIRDQALDAELQQAgFSASQaDHwAAQpgEACyACIBJrIREgECASayEYIBJBCWxBCGohECADIBJBJGxqIQMgGyASa0EBaiETIBYgEkEEdGohEgJ/AkACQAJ/AkACQAJAA0ACQAJAIBMEQCAQQQdrIARPDQEgEEEGayIXIARJDQIgFyEQDAQLIBBBCGsMCQsgEEEHawwFC0MAAH9DIANBBGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EIaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIAMqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIXQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCASQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgF0EbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACAQQQVrIARPDQYgEEEEayAETw0DIAQgEEEDa0sEQEMAAH9DIANBEGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EUaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBDGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIXQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCASQQRqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgF0EbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACAQQQJrIARPDQYgEEEBayAETw0DIBhFDQJDAAB/QyADQRxqKgIAIg2LIglDAAD4QUMAAAAAIANBIGoqAgAiDosiCiAJIAkgCVwbIgkgCSAKIAogClwbIgsgCSALXhsiCSADQRhqKgIAIg+LIgsgCyALXBsiDCAMIAkgCSAJXBsiCSAJIAxdGxCwAY5DAABwQZIiCSAJQwAAAABdGyIJIAlDAAD4QV4bEJcC/AAiF0EPaxDZAUMAAH9DlSIJlSIMIAxDAAB/Q14bEJcCIQwgEkEIakMAAH9DIAsgCZUiCyALQwAAf0NeGxCXAvwBIBdBG3RBgICACEEAIA9DAAAAAF0bckGAgIAQQQAgDUMAAAAAXRtyQYCAgCBBACAOQwAAAABdG3JyIAz8AUEIdHJDAAB/QyAKIAmVIgogCkMAAH9DXhsQlwL8AUEQdHI2AgAgEEEJaiEQIANBJGohAyATQQFrIRMgGEEBayEYIBJBEGohEiARQQFrIhENAQwJCwsgEEEDayEQCyAQIARBkMfAABCRAgALIBBBAWsMAQsgEEEEawsgBEGAx8AAEJECAAsgEEECawwBCyAQQQVrCyAEQfDGwAAQkQIACyAUIAAoAgQgAUECdCABIAJqQQJ0EMcCIgMQpAMiBDYCCCAUIBU2AgwgBCAVRw0HIAMgFiAVEIcDIANBhAhJDQAgAxD5AQsgBkUNBSAAEL8BIABBADoAVCAAQgA3AkwgACACEJgBIAAoAgBBAUcNBSAAKAIIQQFHDQUgAkECdCIWIAAoAigiEUsNACAWIAAoAjQiGEsNASAAKAIkIRwgACgCMCEeIBQgACgCBCIiIAFBAnQiHSABIAJqQQJ0Ih8QxwIiAxCkAyIENgIIIBQgFjYCDCAEIBZHDQYgHCAWIAMQiAMgA0GECE8EQCADEPkBCwJAAkACQAJAAn8CQAJAAkACQAJ/AkACQAJAAkACfwJAAkACQAJAIAIEQCAcQQxqISMgBkEDayEEIAJBPGwiF0EPayEkIBdBHmshJSAXQS1rISYgBkEBa0EPbkECdEEEaiEnQQAhE0EAIRJBACEVQQAhEANAIARBAWoiG0EDbiAEQQJqIhpBA24gFSAnRg0XIBJBAWoiAyAGTw0YIBJBAmoiAyAGTw0ZQwAAf0MgBSAQaiIDQQRqKgIAIg2LIglDAAD4QUMAAAAAIANBCGoqAgAiDosiCiAJIAkgCVwbIgkgCSAKIAogClwbIgsgCSALXhsiCSADKgIAIg+LIgsgCyALXBsiDCAMIAkgCSAJXBsiCSAJIAxdGxCwAY5DAABwQZIiCSAJQwAAAABdGyIJIAlDAAD4QV4bEJcC/AAiIUEPaxDZAUMAAH9DlSIJlSIMIAxDAAB/Q14bEJcCIQwgEyAjakMAAH9DIAsgCZUiCyALQwAAf0NeGxCXAvwBICFBG3RBgICACEEAIA9DAAAAAF0bckGAgIAQQQAgDUMAAAAAXRtyQYCAgCBBACAOQwAAAABdG3JyIAz8AUEIdHJDAAB/QyAKIAmVIgogCkMAAH9DXhsQlwL8AUEQdHI2AgAgGkEDSQ0CIBtBA0kNByAEQQNJDQwgECAXRg0UQwAAf0MgA0EQaioCACINiyIJQwAA+EFDAAAAACADQRRqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0EMaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQsAGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCXAvwAIhpBD2sQ2QFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCXAiEMIBMgHmoiG0MAAH9DIAsgCZUiCyALQwAAf0NeGxCXAvwBIBpBG3RBgICACEEAIA9DAAAAAF0bckGAgIAQQQAgDUMAAAAAXRtyQYCAgCBBACAOQwAAAABdG3JyIAz8AUEIdHJDAAB/QyAKIAmVIgogCkMAAH9DXhsQlwL8AUEQdHI2AgBBAWoiGkECRg0DQQFqIiBBAkYNCCAEQQNuQQFqIhlBAkYNDSAQICRGDRJDAAB/QyADQRxqKgIAIg2LIglDAAD4QUMAAAAAIANBIGoqAgAiDosiCiAJIAkgCVwbIgkgCSAKIAogClwbIgsgCSALXhsiCSADQRhqKgIAIg+LIgsgCyALXBsiDCAMIAkgCSAJXBsiCSAJIAxdGxCwAY5DAABwQZIiCSAJQwAAAABdGyIJIAlDAAD4QV4bEJcC/AAiIUEPaxDZAUMAAH9DlSIJlSIMIAxDAAB/Q14bEJcCIQwgG0EEakMAAH9DIAsgCZUiCyALQwAAf0NeGxCXAvwBICFBG3RBgICACEEAIA9DAAAAAF0bckGAgIAQQQAgDUMAAAAAXRtyQYCAgCBBACAOQwAAAABdG3JyIAz8AUEIdHJDAAB/QyAKIAmVIgogCkMAAH9DXhsQlwL8AUEQdHI2AgAgGkEDRg0EICBBA0YNCSAZQQNGDQ4gECAlRg0TQwAAf0MgA0EoaioCACINiyIJQwAA+EFDAAAAACADQSxqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0EkaioCACIPiyILIAsgC1wbIgwgDCAJIAkgCVwbIgkgCSAMXRsQsAGOQwAAcEGSIgkgCUMAAAAAXRsiCSAJQwAA+EFeGxCXAvwAIiFBD2sQ2QFDAAB/Q5UiCZUiDCAMQwAAf0NeGxCXAiEMIBtBCGpDAAB/QyALIAmVIgsgC0MAAH9DXhsQlwL8ASAhQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJcC/AFBEHRyNgIAIBpBBEYNBSAgQQRGDQogGUEERg0PIBAgJkYNEUMAAH9DIANBNGoqAgAiDYsiCUMAAPhBQwAAAAAgA0E4aioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBMGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIDQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCAbQQxqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgA0EbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACATQRBqIRMgEkEPaiESIBVBBGohFSAEQQ9rIQQgFyAQQTxqIhBHDQALCyAUICIgHSAfEMcCIgMQpAMiBDYCCCAUIBE2AgwgBCARRw0ZIAMgHCAREIcDIANBhAhPBEAgAxD5AQsgFCAAKAIMIB0gHxDHAiIDEKQDIgQ2AgggFCAYNgIMIAQgGEcNGSADIB4gGBCHAyADQYQISQ0YIAMQ+QEMGAsgEkEDagwDCyASQQZqDAILIBJBCWoMAQsgEkEMagsgBkHwx8AAEJECAAsgEkEEagwDCyASQQdqDAILIBJBCmoMAQsgEkENagsgBkGAyMAAEJECAAsgEkEFagwDCyASQQhqDAILIBJBC2oMAQsgEkEOagsgBkGQyMAAEJECAAsgFUEDaiEVDAILIBVBAWohFQwBCyAVQQJqIRULIBUgFkGgyMAAEJECAAtBACAWIBFBsMjAABCmAQALQQAgFiAYQbDHwAAQpgEACyASIAZBwMfAABCRAgALIAMgBkHQx8AAEJECAAsgAyAGQeDHwAAQkQIACwJAIAhFDQAgABC/ASAAQQA6AFQgAEIANwJMIAAgAhCYASAAKAIQQQFHDQAgACgCGEEBRw0AAkACQAJ/AkACQAJAAn8CQAJAAkACQAJAAkAgAkECdCIFIAAoAigiBk0EQCAFIAAoAjQiFksNDSAAKAIkIRggACgCMCEXIAJFDQwgAkHUAGwhHCAIQQxrIQQgCEEBa0EVbkECdEEEaiEbQQAhE0EUIRBBACEVQQAhEgNAIARBA24gBEEBaiIdQQNuIARBAmoiGkEDbgJAAn8CQAJAAkACfwJAAkACQAJ/AkACQCAVIBtHBEAgEEETayAITw0BIBBBEmsiAyAISQ0CIAMMAwsgEEEUawwKCyAQQRNrDAULQwAAf0MgByASaiIDQQRqKgIAIg2LIglDAAD4QUMAAAAAIANBCGoqAgAiDosiCiAJIAkgCVwbIgkgCSAKIAogClwbIgsgCSALXhsiCSADKgIAIg+LIgsgCyALXBsiDCAMIAkgCSAJXBsiCSAJIAxdGxCwAY5DAABwQZIiCSAJQwAAAABdGyIJIAlDAAD4QV4bEJcC/AAiGUEPaxDZAUMAAH9DlSIJlSIMIAxDAAB/Q14bEJcCIQwgEyAYaiIRQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgGUEbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACAQQRFrIAhPDQcgEEEQayAITw0DIAggEEEPa0sEQEMAAH9DIANBEGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EUaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBDGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIZQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCARQQRqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgGUEbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACAQQQ5rIAhPDQcgEEENayAITw0DIAggEEEMa0sEQEMAAH9DIANBHGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EgaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBGGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIZQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCARQQhqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgGUEbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACAQQQtrIAhPDQcgEEEKayAITw0DIAggEEEJa0sEQEMAAH9DIANBKGoqAgAiDYsiCUMAAPhBQwAAAAAgA0EsaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBJGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIZQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCARQQxqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgGUEbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACAaQQNJDRggHUEDSQ0UIARBA0kNECASIBxHDQwgFSAFQYDJwAAQkQIACyAQQQlrDAILIBBBDGsMAQsgEEEPawsgCEGwycAAEJECAAsgEEEKawwCCyAQQQ1rDAELIBBBEGsLIAhBoMnAABCRAgALIBBBC2sMAgsgEEEOawwBCyAQQRFrCyAIQZDJwAAQkQIAC0MAAH9DIANBNGoqAgAiDYsiCUMAAPhBQwAAAAAgA0E4aioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBMGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIdQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCATIBdqIhFDAAB/QyALIAmVIgsgC0MAAH9DXhsQlwL8ASAdQRt0QYCAgAhBACAPQwAAAABdG3JBgICAEEEAIA1DAAAAAF0bckGAgIAgQQAgDkMAAAAAXRtyciAM/AFBCHRyQwAAf0MgCiAJlSIKIApDAAB/Q14bEJcC/AFBEHRyNgIAQQRqIh1BBUYNCkEEaiIfQQVGDQZBBGoiHkEFRg0CQwAAf0MgA0FAayoCACINiyIJQwAA+EFDAAAAACADQcQAaioCACIOiyIKIAkgCSAJXBsiCSAJIAogCiAKXBsiCyAJIAteGyIJIANBPGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIaQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCARQQRqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgGkEbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACAdQQZGDQkgH0EGRg0FIB5BBkYNBEMAAH9DIANBzABqKgIAIg2LIglDAAD4QUMAAAAAIANB0ABqKgIAIg6LIgogCSAJIAlcGyIJIAkgCiAKIApcGyILIAkgC14bIgkgA0HIAGoqAgAiD4siCyALIAtcGyIMIAwgCSAJIAlcGyIJIAkgDF0bELABjkMAAHBBkiIJIAlDAAAAAF0bIgkgCUMAAPhBXhsQlwL8ACIDQQ9rENkBQwAAf0OVIgmVIgwgDEMAAH9DXhsQlwIhDCARQQhqQwAAf0MgCyAJlSILIAtDAAB/Q14bEJcC/AEgA0EbdEGAgIAIQQAgD0MAAAAAXRtyQYCAgBBBACANQwAAAABdG3JBgICAIEEAIA5DAAAAAF0bcnIgDPwBQQh0ckMAAH9DIAogCZUiCiAKQwAAf0NeGxCXAvwBQRB0cjYCACATQRBqIRMgEEEVaiEQIBVBBGohFSAEQRVrIQQgHCASQdQAaiISRw0ACwwMC0EAIAUgBkHAycAAEKYBAAsgEEEDayEQDAELIBBBBmshEAsgECAIQfDIwAAQkQIACyAQQQFrDAILIBBBBGsMAQsgEEEHawsgCEHgyMAAEJECAAsgEEECawwCCyAQQQVrDAELIBBBCGsLIAhB0MjAABCRAgALIBQgACgCFCABQQJ0IgMgASACakECdCICEMcCIgEQpAMiBDYCCCAUIAY2AgwCQCAEIAZGBEAgASAYIAYQhwMgAUGECE8EQCABEPkBCyAUIAAoAhwgAyACEMcCIgAQpAMiATYCCCAUIBY2AgwgASAWRw0BIAAgFyAWEIcDIABBhAhJDQMgABD5AQwDCwwDCwwCC0EAIAUgFkHAyMAAEKYBAAsgFEEQaiQADwsgFEEIaiAUQQxqEKQCAAvQUAMVfwN9AX4jAEHgAGsiCiQAAkACQAJAAkAgAC0AqFNFBEAgCkFAayAAQdwAahCSASAKLQBABEAgCigCRCEBDAMLIAotAEFBAUcNASAAQQE6AKhTCyAAKAJkIgNFDQAgAEGgAWohFCAKQdQAaq1CgICAgPAAhCEZIABB9ABqIRUgAEGAAWohEgNAAkAgACgCcCIGIAAoAqRTIgFrIgJBACACIAZNG0GAgARPBEAgASECDAELIAEgAUGAgAJrIgJBACABIAJPGyIJayECIAEgCUYEQCAAIAI2AqRTDAELIAEgBk0EQCACBEAgACgCbCIBIAEgCWogAvwKAAALIAAoAmQhAyAAIAI2AqRTDAELQQAgASAGQfDOwQAQpgEACwJAAkAgAyAMTwRAIApBQGsgFCAAKAJgIAxqIAMgDGsgACgCbCAAKAJwIAIQIyAKIAotAEQiAToAAyAKKAJAIRMgCigCSCIQRQ0CIAAoAqRTIgMgEGoiAiADTyACIAAoAnAiBk1xDQEgAyACIAZB/MHAABCmAQALIAwgAyADQYzCwAAQpgEACyAAKAJsIQYgACgCdCAAKAJ8IgJrIBBJBEAgFSACIBBBAUEBENcBIAAoAnwhAgsgEARAIAAoAnggAmogAyAGaiAQ/AoAAAsgACACIBBqIgY2AnwgACAAKAKkUyAQajYCpFMCQAJAAkACQCAAKAKAAUF/RgRAIAZBD00NBSAKIAAoAngiAigAACIDNgIQIANBzo7NggVHBEAgCiAKQRBqrUKAgICAkAGENwNAIApBFGoiAEGsu8AAIApBQGsQ+AEgABCuAiEBDAkLIAogAigABCIJNgIgIAlBBGtBfE0EQCAKIApBIGqtQoCAgIDwAIQ3A0AgCkEkaiIAQZ2IwAAgCkFAaxD4ASAAEK4CIQEMCQsgAi0ADSEIIAItAAwhAyACKAAIIQQgCiACLAAOIgc6ADMgB0EASA0BIABBADYCfCAGQRBrIgYEQCAGBEAgAiACQRBqIAb8CgAACyAAIAY2AnwLIAogAzYCVCADQQNLDQNBgIDAABApIgJFDQIgACAIOgCdASAAQQA6AJwBIABBADYCmAEgACADNgKUASAAIAQ2ApABIAAgCTYCjAEgAEEANgKIASAAIAI2AoQBIABBgIAQNgKAASAAIAQgAxCUASAAKAKAAUF/Rg0FCwNAAkACfwJAAkACQAJAAkACQAJAAkACQAJAAkACQCAALQCcAUEBaw4GCQgHBgASAQtBCSERQQYhASAAKAKUAQ4EDAQDAgELIAAoAnxBBkEJIAAoAowBIgNBAUYbIg1uIgIgACgCkAEgACgCmAFrIgZJBEAgAiIGQYCABEkNEQtBgIAEIAYgBkGAgARPGyIIQQNsIgIgACgCiAEiAUsEfyACIAFrIgIgACgCgAEgAWtLBEAgEiABIAJBBEEEENcBIAAoAogBIQELIAAoAoQBIgkgAUECdGohAyACQQJPBH8gAkECdEEEayIEBEAgA0EAIAT8CwALIAEgAmoiAkEBayEBIAkgAkECdGpBBGsFIAMLQQA2AgAgACABQQFqNgKIASAAKAKMAQUgAwtBAUcNCCAGRQ0JQQAhAUEAIQJBACEDQQAhCQNAIAFBAmoiByAAKAJ8IgRLBEAgASAHIARBnLzAABCmAQALAn8gACgCeCABaiIEQQFqLQAAQQh0IgUgBC0AAHIiBEH//wFxRQRAIARBEHQMAQsgBEH/B3EhBCAFQYCAAnEhCyAFQYD4AXEiBUGA+AFGBEAgC0EQdCIFQYCAgPwHciAERQ0BGiAEQQ10IAVyQYCAgP4HcgwBCyALQRB0IgsgBUENdEGAgID8AHEgBEENdHJBgICAwANqciAFDQAaIAQgBGdBEGsiBEH//wNxQQhqdEH///8DcSALQYCAgNgDciAEQRd0a3ILIQQCfwJAAkAgACgCiAEiBSADSwRAIAAoAoQBIAJqIAQ2AgAgAUEEaiIFIAAoAnwiBEsNASAAKAJ4IAFqIgRBA2otAABBCHQiByAEQQJqLQAAciIEQf//AXFFBEAgBEEQdAwECyAEQf8HcSEEIAdBgIACcSELIAdBgPgBcSIHQYD4AUYEQCALQRB0IgdBgICA/AdyIARFDQQaIARBDXQgB3JBgICA/gdyDAQLIAtBEHQhCyAHRQ0CIAdBDXRBgICA/ABxIARBDXRyQYCAgMADaiALcgwDCyADIAVBzLvAABCRAgALIAcgBSAEQYy8wAAQpgEACyAEIARnQRBrIgRB//8DcUEIanRB////A3EgC0GAgIDYA3IgBEEXdGtyCyEEAn8CQAJAIANBAWoiByAAKAKIASILSQRAIAAoAoQBIAJqQQRqIAQ2AgAgAUEGaiIEIAAoAnwiB0sNASAAKAJ4IAFqIgFBBWotAABBCHQiByABQQRqLQAAciIBQf//AXFFBEAgAUEQdAwECyABQf8HcSEBIAdBgIACcSEFIAdBgPgBcSIHQYD4AUYEQCAFQRB0IgdBgICA/AdyIAFFDQQaIAFBDXQgB3JBgICA/gdyDAQLIAVBEHQhBSAHRQ0CIAdBDXRBgICA/ABxIAFBDXRyQYCAgMADaiAFcgwDCyAHIAtB3LvAABCRAgALIAUgBCAHQfy7wAAQpgEACyABIAFnQRBrIgFB//8DcUEIanRB////A3EgBUGAgIDYA3IgAUEXdGtyCyEBIANBAmoiByAAKAKIASIFSQRAIAAoAoQBIAJqQQhqIAE2AgAgAkEMaiECIANBA2ohAyAEIQEgCUEBaiIJIAhJDQEMCwsLIAcgBUHsu8AAEJECAAtB3MDAABD9AgALQS0hEQwBC0EYIRELIAAoAnwgEW4iAiAAKAKQASAAKAKYAWsiBkkEQCACIgZBgIAESQ0NC0GAgAQgBiAGQYCABE8bIg4gEWwiCyAAKAKIASIBSwRAIAsgAWsiAiAAKAKAASABa0sEQCASIAEgAkEEQQQQ1wEgACgCiAEhAQsgACgChAEiCSABQQJ0aiEDIAJBAk8EfyACQQJ0QQRrIgQEQCADQQAgBPwLAAsgASACaiICQQFrIQEgCSACQQJ0akEEawUgAwtBADYCACAAIAFBAWoiATYCiAELIA5BCWwhDwJAIAYEQCAOQeAAbCEHIA5BGGwhCUEAIQ1BACEIAkADQCAIIBFsIgEgACgCfCICTw0DAkACQAJAAkAgCEEJbCIDIAAoAogBIgJPDQAgACgChAEgA0ECdGogACgCeCABai0AALNDAAAAw5JDAAAAPJQ4AgAgAUEDaiIEIAAoAnwiAk8EQCAEIQEMCAsgA0EDaiIFIAAoAogBIgJPBEAgBSEDDAELIAAoAoQBIAVBAnRqIAAoAnggBGotAACzQwAAAMOSQwAAADyUOAIAIAFBBmoiBCAAKAJ8IgJPBEAgBCEBDAgLIANBBmoiBSAAKAKIASICTwRAIAUhAwwBCyAAKAKEASAFQQJ0aiAAKAJ4IARqLQAAs0MAAADDkkMAAAA8lDgCACABQQFqIgQgACgCfCICTwRAIAQhAQwICyADQQFqIgUgACgCiAEiAk8EQCAFIQMMAQsgACgChAEgBUECdGogACgCeCAEai0AALNDAAAAw5JDAAAAPJQ4AgAgAUEEaiIEIAAoAnwiAk8EQCAEIQEMCAsgA0EEaiIFIAAoAogBIgJPBEAgBSEDDAELIAAoAoQBIAVBAnRqIAAoAnggBGotAACzQwAAAMOSQwAAADyUOAIAIAFBB2oiBCAAKAJ8IgJPBEAgBCEBDAgLIANBB2oiBSAAKAKIASICTwRAIAUhAwwBCyAAKAKEASAFQQJ0aiAAKAJ4IARqLQAAs0MAAADDkkMAAAA8lDgCACABQQJqIgQgACgCfCICTwRAIAQhAQwICyADQQJqIgUgACgCiAEiAk8EQCAFIQMMAQsgACgChAEgBUECdGogACgCeCAEai0AALNDAAAAw5JDAAAAPJQ4AgAgAUEFaiIEIAAoAnwiAk8EQCAEIQEMCAsgA0EFaiIFIAAoAogBIgJPBEAgBSEDDAELIAAoAoQBIAVBAnRqIAAoAnggBGotAACzQwAAAMOSQwAAADyUOAIAIAFBCGoiBCAAKAJ8IgJPBEAgBCEBDAgLIANBCGoiAyAAKAKIASICTw0AIAAoAoQBIANBAnRqIAAoAnggBGotAACzQwAAAMOSQwAAADyUOAIAIAAoApQBQQFLDQEMAgsgAyACQezBwAAQkQIACwJAAkAgAUEJaiIDIAAoAnwiBE8NACAIQQ9sIA9qIgIgACgCiAEiBE8NAyAAKAKEASACQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQQxqIgMgACgCfCIETw0AIAJBA2oiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQQ9qIgMgACgCfCIETw0AIAJBBmoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQRJqIgMgACgCfCIETw0AIAJBCWoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQRVqIgMgACgCfCIETw0AIAJBDGoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQQpqIgMgACgCfCIETw0AIAJBAWoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQQ1qIgMgACgCfCIETw0AIAJBBGoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQRBqIgMgACgCfCIETw0AIAJBB2oiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQRNqIgMgACgCfCIETw0AIAJBCmoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQRZqIgMgACgCfCIETw0AIAJBDWoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQQtqIgMgACgCfCIETw0AIAJBAmoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQQ5qIgMgACgCfCIETw0AIAJBBWoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQRFqIgMgACgCfCIETw0AIAJBCGoiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQRRqIgMgACgCfCIETw0AIAJBC2oiBSAAKAKIASIETwRAIAUhAgwECyAAKAKEASAFQQJ0aiAAKAJ4IANqLQAAs0MAAADDkkMAAAA8lDgCACABQRdqIgMgACgCfCIETw0AIAJBDmoiAiAAKAKIASIETw0DIAAoAoQBIAJBAnRqIAAoAnggA2otAACzQwAAAMOSQwAAADyUOAIAIAAoApQBQQJNDQJBACEEIAchAwwBCyADIARBvMHAABCRAgALAkACQAJAAkACQAJAAkACfwJAAkACQAJAAkACQANAIAAoAnwiAiAEIA1qIgFBGGpLBEAgBCAJaiIFIAAoAogBIgJPDQ8gACgChAEgA2ogASAAKAJ4akEYai0AALNDAAAAw5JDAAAAPJQ4AgAgACgCfCICIAFBG2pNDQcgACgCiAEiAiAFQQNqTQ0OIAAoAoQBIANqQQxqIAEgACgCeGpBG2otAACzQwAAAMOSQwAAADyUOAIAIAAoAnwiAiABQR5qTQ0GIAAoAogBIgIgBUEGak0NDSAAKAKEASADakEYaiABIAAoAnhqQR5qLQAAs0MAAADDkkMAAAA8lDgCACAAKAJ8IgIgAUEhak0NBSAAKAKIASICIAVBCWpNDQwgACgChAEgA2pBJGogASAAKAJ4akEhai0AALNDAAAAw5JDAAAAPJQ4AgAgACgCfCICIAFBJGpNDQQgACgCiAEiAiAFQQxqTQ0LIAAoAoQBIANqQTBqIAEgACgCeGpBJGotAACzQwAAAMOSQwAAADyUOAIAIAAoAnwiAiABQSdqTQ0DIAAoAogBIgIgBUEPak0NCiAAKAKEASADakE8aiABIAAoAnhqQSdqLQAAs0MAAADDkkMAAAA8lDgCACAAKAJ8IgIgAUEqak0NAiAAKAKIASICIAVBEmpNDQkgACgChAEgA2pByABqIAAoAnggDWogBGpBKmotAACzQwAAAMOSQwAAADyUOAIAIANBBGohAyAEQQFqIgIhBCACQQNHDQEMEAsLIAFBGGoMBgsgAUEqagwFCyABQSdqDAQLIAFBJGoMAwsgAUEhagwCCyABQR5qDAELIAFBG2oLIAJBnMHAABCRAgALIAVBEmohBQwFCyAFQQ9qIQUMBAsgBUEMaiEFDAMLIAVBCWohBQwCCyAFQQZqIQUMAQsgBUEDaiEFCyAFIAJBrMHAABCRAgALIA0gEWohDSAJQRVqIQkgB0HUAGohByAIQQFqIgggDkYNAgwBCwsgAiAEQczBwAAQkQIACyAAKAKIASEBCwJAAkACQAJAAkACQCABIA9PBEAgACgChAEhCCAAKAKYASEHQQQhAkEAIQQCQCAAKAKUASIFQQJJBEBBACEJQQQhDQwBCyAOQRhsIgMgAUsNAiAOQQ9sIQkgCCAPQQJ0aiENIAVBAkYNACABIAtJIAMgC0tyDQUgCyADayEEIAggA0ECdGohAgsgACAHIA4gCCAPIA0gCSACIAQQKCAAKAJ8IgIgC0kNAiAAQQA2AnwgAiALayEBIAZFDQMgAiALRg0GIAFFDQUgACgCeCICIAIgC2ogAfwKAAAMBQtBACAPIAFBjMHAABCmAQALIA8gAyABQfzAwAAQpgEAC0EAIAsgAkHwzsEAEKYBAAsgAiALRw0BDAILIAMgCyABQezAwAAQpgEACyAAIAE2AnwLIAAgACgCmAEgDmoiAjYCmAEgAiAAKAKQAUcNCUEGDAcLIAEgAkHcwcAAEJECAAsgACgCfEEEQQMgACgCjAEiA0EDRhsiDm4iAiAAKAKQASAAKAKYAWsiBkkEQCACIgZBgIAESQ0MCwJAAkACQAJAAkACQAJAAkACQAJAAkBBgIAEIAYgBkGAgARPGyIJQQJ0IgIgACgCiAEiAUsEfyACIAFrIgIgACgCgAEgAWtLBEAgEiABIAJBBEEEENcBIAAoAogBIQELIAAoAoQBIgQgAUECdGohAyACQQJPBH8gAkECdEEEayIIBEAgA0EAIAj8CwALIAEgAmoiAkEBayEBIAQgAkECdGpBBGsFIAMLQQA2AgAgACABQQFqNgKIASAAKAKMAQUgAwtBA0cEQCAGRQ0LQQAhAUEAIQJBACEDQQAhBQNAIAEgACgCfCIETw0DIAFBAWoiCCAETw0EIAFBAmoiCCAETw0FIAMgACgCiAEiBE8NBiAAKAJ4IAFqIgRBAWotAAAhCCAEQQJqLQAAIQcgACgChAEgAmogBC0AALNDAAD/QpVDAACAv5IiFjgCACADQQFqIgQgACgCiAEiC08NByAAKAKEASACakEEaiAIs0MAAP9ClUMAAIC/kiIXOAIAIANBAmoiBCAAKAKIASIITw0IIAAoAoQBIAJqQQhqIAezQwAA/0KVQwAAgL+SIhg4AgAgA0EDaiIEIAAoAogBIghPDQIgACgChAEgAmpBDGpDAAAAAEMAAIA/IBYgFpQgFyAXlJIgGCAYlJKTIhYgFiAWXBsiFkMAAAAAIBZDAAAAAF4bkTgCACABQQNqIQEgAkEQaiECIANBBGohAyAFQQFqIgUgCUkNAAsMCwsgBkUNCkEAIQJBACEDQQAhDQNAAkACQAJAAkAgACgCfCIBIANLBEAgA0EBaiIIIAFPDQEgA0ECaiIHIAFPDQIgA0EDaiIFIAFPDQMgACgCeCADaiIBQQJqLQAAIREgAUEDai0AACEEIAEtAAAgAUEBai0AACELIAr9DAAAAAAAAAAAAAAAAAAAAAD9CwNAIAtBCHRyIg8gEUEQdCAEQRh0cnIhAUMAAAAAIRYCfSAKAn8CQCAEQQZ2IgRBA0cEQCAKIA9B/wNxs0MAgP9DlUPzBDU/lCIWjCAWIAtBAnEbIhY4AkwgFiAWlCEWIAFBCnYhASAEQQJGDQELIAogAUH/A3GzQwCA/0OVQ/MENT+UIheMIBcgAUGABHEbIhc4AkggFiAXIBeUkiEWIAFBCnYiASAEQQFGDQEaCyAKIAFB/wNxs0MAgP9DlUPzBDU/lCIXjCAXIAFBgARxGyIXOAJEIBYgFyAXlJIiFiAERQ0BGiABQQp2CyIBQf8DcbNDAID/Q5VD8wQ1P5QiF4wgFyABQYAEcRsiFzgCQCAWIBcgF5SSCyEWIApBQGsgBEECdGpDAACAPyAWkyIWkUMAAAAAIBZDAAAAAF4bOAIAIAMgACgCiAEiAUkNBCADIAFBrL/AABCRAgALIAMgAUHsvsAAEJECAAsgCCABQfy+wAAQkQIACyAHIAFBjL/AABCRAgALIAUgAUGcv8AAEJECAAsgACgChAEgAmogCioCQDgCACAIIAAoAogBIgFPDQogACgChAEgAmpBBGogCioCRDgCACAHIAAoAogBIgFPDQkgACgChAEgAmpBCGogCioCSDgCACAFIAAoAogBIgFPDQggACgChAEgAmpBDGogCioCTDgCACACQRBqIQIgA0EEaiEDIAkgDUEBaiINSw0ACwwKCyAEIAhBzMDAABCRAgALIAEgBEHsv8AAEJECAAsgCCAEQfy/wAAQkQIACyAIIARBjMDAABCRAgALIAMgBEGcwMAAEJECAAsgBCALQazAwAAQkQIACyAEIAhBvMDAABCRAgALIAUgAUHcv8AAEJECAAsgByABQcy/wAAQkQIACyAIIAFBvL/AABCRAgALIAAgACgCmAEgCSAAKAKEASAAKAKIARCcAQJAAkACQCAAKAJ8IgEgCSAObCICTwRAIABBADYCfCABIAJrIQMgBkUNASABIAJGDQMgA0UNAiAAKAJ4IgEgASACaiAD/AoAAAwCCwwTCyABIAJGDQELIAAgAzYCfAsgACAAKAKYASAJaiICNgKYASACIAAoApABRw0HQQUMBQsgACgCfCIBQQNuIgIgACgCkAEgACgCmAFrIglJBEAgAiEJIAFBgIAMSQ0LC0GAgAQgCSAJQYCABE8bIgRBA2wiBiAAKAKIASIBSwRAIAYgAWsiAiAAKAKAASABa0sEQCASIAEgAkEEQQQQ1wEgACgCiAEhAQsgACgChAEiCCABQQJ0aiEDIAJBAk8EfyACQQJ0QQRrIgcEQCADQQAgB/wLAAsgASACaiICQQFrIQEgCCACQQJ0akEEawUgAwtBADYCACAAIAFBAWoiATYCiAELAkACQAJAAkACQAJAAkACQAJAIAkEQEEAIQNBACEBA0AgASAAKAJ8IgJPDQQgASAAKAKIASICTw0FIAAoAoQBIANqIAAoAnggAWotAACzQwAAgD2UQwAAIMGSEHM4AgAgAUEBaiICIAAoAnwiCE8NBiACIAAoAogBIghPDQcgACgChAEgA2pBBGogACgCeCABakEBai0AALNDAACAPZRDAAAgwZIQczgCACABQQJqIgIgACgCfCIITw0IIAIgACgCiAEiCE8NAiAAKAKEASADakEIaiAAKAJ4IAFqQQJqLQAAs0MAAIA9lEMAACDBkhBzOAIAIANBDGohAyAGIAFBA2oiAUcNAAsgACgCiAEhAQsgACAAKAKYASAEIAAoAoQBIAEQaiAAKAJ8IgIgBkkNGSAAQQA2AnwgAiAGayEBIAlFDQEgAiAGRg0IIAFFDQcgACgCeCICIAIgBmogAfwKAAAMBwsgAiAIQdy+wAAQkQIACyACIAZHDQUMBgsgASACQYy+wAAQkQIACyABIAJBnL7AABCRAgALIAIgCEGsvsAAEJECAAsgAiAIQby+wAAQkQIACyACIAhBzL7AABCRAgALIAAgATYCfAsgACAAKAKYASAEaiICNgKYASACIAAoApABRw0GQQQMBAsgACgCfCIBQQNuIgIgACgCkAEgACgCmAFrIglJBEAgAiEJIAFBgIAMSQ0KC0GAgAQgCSAJQYCABE8bIgRBA2wiBiAAKAKIASIBSwRAIAYgAWsiAiAAKAKAASABa0sEQCASIAEgAkEEQQQQ1wEgACgCiAEhAQsgACgChAEiCCABQQJ0aiEDIAJBAk8EfyACQQJ0QQRrIgcEQCADQQAgB/wLAAsgASACaiICQQFrIQEgCCACQQJ0akEEawUgAwtBADYCACAAIAFBAWoiATYCiAELAkACQAJAAkACQAJAAkACQAJAIAkEQEEAIQNBACEBA0AgASAAKAJ8IgJPDQQgASAAKAKIASICTw0FIAAoAoQBIANqIAAoAnggAWotAACzQwAAf0OVQwAAAL+SQ4y48D+UQwAAAD+SOAIAIAFBAWoiAiAAKAJ8IghPDQYgAiAAKAKIASIITw0HIAAoAoQBIANqQQRqIAAoAnggAWpBAWotAACzQwAAf0OVQwAAAL+SQ4y48D+UQwAAAD+SOAIAIAFBAmoiAiAAKAJ8IghPDQggAiAAKAKIASIITw0CIAAoAoQBIANqQQhqIAAoAnggAWpBAmotAACzQwAAf0OVQwAAAL+SQ4y48D+UQwAAAD+SOAIAIANBDGohAyAGIAFBA2oiAUcNAAsgACgCiAEhAQsgACAAKAKYASAEIAAoAoQBIAEQfSAAKAJ8IgIgBkkNGCAAQQA2AnwgAiAGayEBIAlFDQEgAiAGRg0IIAFFDQcgACgCeCICIAIgBmogAfwKAAAMBwsgAiAIQfy9wAAQkQIACyACIAZHDQUMBgsgASACQay9wAAQkQIACyABIAJBvL3AABCRAgALIAIgCEHMvcAAEJECAAsgAiAIQdy9wAAQkQIACyACIAhB7L3AABCRAgALIAAgATYCfAsgACAAKAKYASAEaiICNgKYASACIAAoApABRw0FQQMMAwsgACgCfCICIAAoApABIAAoApgBayIISQRAIAIiCEGAgARJDQkLQYCABCAIIAhBgIAETxsiBiAAKAKIASIBSwRAIAYgAWsiAiAAKAKAASABa0sEQCASIAEgAkEEQQQQ1wEgACgCiAEhAQsgACgChAEiCSABQQJ0aiEDIAJBAk8EfyACQQJ0QQRrIgQEQCADQQAgBPwLAAsgASACaiICQQFrIQEgCSACQQJ0akEEawUgAwtBADYCACAAIAFBAWo2AogBCwJAAkACQAJAAkACQAJAIAgEQEEAIQFBACEDA0AgASAAKAJ8IgJPDQYgASAAKAKIASICTw0DIAAoAoQBIANqIAAoAnggAWotAACzQwAAf0OVOAIAIANBBGohAyABQQFqIgIhASACIAZHDQALIAAoAoQBIQcgACgCiAEhCSAAIAAoApgBIAYQb0EAIQIgBiEEIAkhA0EAIQEDQCAAKAIgIgUgAUEDak0NBCADBEAgACgCHCACakEDakH/AUMAAH9DQwAAAAAgASAHaioCAEMAAH9DlCIWIBZDAAAAAF0bIhYgFkMAAH9DXhsQlwIiFvwBQQAgFkMAAAAAYBsgFkMAAH9DXhs6AAAgAkEQaiECIANBAWshAyABQQRqIQEgBEEBayIEDQEMAwsLIAkgCUGwysAAEJECAAsgACAAKAKYASAGEG8LIABBAToAWCAAKAJ8IgIgBkkNFCAAQQA2AnwgAiAGayEBIAhFDQIgAiAGRg0FIAFFDQQgACgCeCICIAIgBmogAfwKAAAMBAsgASACQZy9wAAQkQIACyABIAFBBGogBUHAysAAEKYBAAsgAiAGRw0BDAILIAEgAkGMvcAAEJECAAsgACABNgJ8CyAAIAAoApgBIAZqIgI2ApgBIAIgACgCkAFHDQRBAgwCCyAGRQ0AQQEgAC0AnQF0syEWQQAhAUEAIQJBACEDQQAhCQJAAkACQAJAA0AgAUEDaiIEIAAoAnwiB0sEQCABIAQgB0H8vMAAEKYBAAsgAyAAKAKIASIHTw0BIAAoAoQBIAJqIAAoAnggAWoiB0ECai0AACIFQRB0IActAAByIAdBAWotAABBCHRyIgdBgICAeHIgByAFwEEASBuyIBaVOAIAIAFBBmoiByAAKAJ8IgVLDQIgA0EBaiIEIAAoAogBIgVPDQMgACgChAEgAmpBBGogACgCeCABaiIEQQVqLQAAIgVBEHQgBEEDai0AAHIgBEEEai0AAEEIdHIiBEGAgIB4ciAEIAXAQQBIG7IgFpU4AgAgAUEJaiIEIAAoAnwiBUsNBCADQQJqIgcgACgCiAEiBUkEQCAAKAKEASACakEIaiAAKAJ4IAFqIgFBCGotAAAiB0EQdCABQQZqLQAAciABQQdqLQAAQQh0ciIBQYCAgHhyIAEgB8BBAEgbsiAWlTgCACACQQxqIQIgA0EDaiEDIAQhASAJQQFqIgkgCEkNAQwGCwsgByAFQcy8wAAQkQIACyADIAdBrLzAABCRAgALIAQgByAFQey8wAAQpgEACyAEIAVBvLzAABCRAgALIAcgBCAFQdy8wAAQpgEACyAAIAAoApgBIAggACgChAEgACgCiAEQRgJAAkACQCAAKAJ8IgEgCCANbCICTwRAIABBADYCfCABIAJrIQMgBkUNASABIAJGDQMgA0UNAiAAKAJ4IgEgASACaiAD/AoAAAwCCwwOCyABIAJGDQELIAAgAzYCfAsgACAAKAKYASAIaiICNgKYASACIAAoApABRw0CQQELIQEgAEEANgKYAQsgACABOgCcAQwACwALIAogCkEzaq1CgICAgKABhDcDQCAKQTRqIgBBgLvAACAKQUBrEPgBIAAQrgIhAQwGC0EEQYCAwAAQzAIACyAKIBk3A1ggCkFAayIAQceJwAAgCkHYAGoQ+AEgABCvAiEBDAQLIAotAAMhAQsgDCATaiEMAkACQAJAAkACQCABQf8BcQ4DAQIDAAsgCiAKQQNqrUKAgICAsAGENwNAIApBBGoiAEHdicAAIApBQGsQ+AEgABCuAiEBDAYLIABBAToAqVMgDEEIaiAMIAAoAmQiAiAMayIBQQAgASACTRtBB0sbIQwMAgsgECATckUNAQsgDCAAKAJkIgNJDQELCyAMRQ0AIAwgACgCZCICTQRAQQAhASAAQQA2AmQgAiAMRg0CIAIgDGsiAgRAIAAoAmAiAyADIAxqIAL8CgAACyAAIAI2AmQMAgtBACAMIAJB8M7BABCmAQALQQAhAQsgCkHgAGokACABDwtBACACIAFB8M7BABCmAQALQQAgBiACQfDOwQAQpgEAC8BVAiR/BHsjAEHQAGsiCCQAAkAgBSAGTwRAIAggAzYCICAIIAI2AhwgAS0AgFIhByAIIAY2AiwgCCAFNgIoIAggBDYCJCAIIAEtAOxROgBAIAggASgC2FE2AjwgCCABKALUUTYCOCAIIAEoAsBRNgI0IAggASgC3FE2AjAgAUGA0QBqIRsgAUGQ0ABqIScgAUHg0QBqISIgAUHt0QBqIRwgAUGAxgBqIR0gAUGANmohHiABQaDRAGohFiABQYDPAGohIyABQeTRAGohHyABQYAUaiEXIAFBgARqIRggAUGALWohICABQYAdaiEhA0BBGCEEQQAhBQJ/AkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCAHQf8BcQ4ZKicmIhUhFCAfHh0cAQIbGhkYFxYDBAUAJQcLIAgoAiAhBSAIKAIcIQcgCCgCPCIPQQNNDQUMDQsgCCgCLCEKAkACQAJAAkAgCCgCICIMQQRJDQAgCCgCJCENIAgoAighCwNAIAsgCmsiBEECSQ0BIARBggJLIAxBDk9xDQsgCCgCMCEEIAgCfyAIKAI0IgVBDksEQCAFDAELIAggDEECayIMNgIgIAggCCgCHCIHQQJqNgIcIAQgBy8AACAFdHIhBCAFQRByCwJ/IBggBEH/B3FBAXRqLgEAIgVBAEgEQEEKIQcDQAJAIAQgB3ZBAXEgBUF/c2oiBUHABE8EQCAHQQFqIQdB//8BIQUMAQsgB0EBaiEHIBcgBUEBdGouAQAiBUEASA0BCwsgB0H/AXEMAQsgBUEJdgsiCWsiBzYCNCAIIAQgCXYiCTYCMCAIIAU2AjwgBUGAAnENAyAIIAdBDksEfyAHBSAIIAxBAms2AiAgCCAIKAIcIgRBAmo2AhwgBC8AACAHdCAJciEJIAdBEHILAn8gGCAJQf8HcUEBdGouAQAiBEEASARAQQohBwNAAkAgCSAHdkEBcSAEQX9zaiIEQcAETwRAIAdBAWohB0H//wEhBAwBCyAHQQFqIQcgFyAEQQF0ai4BACIEQQBIDQELCyAHQf8BcQwBCyAEQQl2CyIHazYCNCAIIAkgB3Y2AjAgCiALTw0MIAogDWogBToAACAKQQFqIQUgBEGAAnENAiAFIAtPDQ0gBSANaiAEOgAAIApBAmohCiAIKAIgIgxBBE8NAAsLIAggCjYCLCAIKAI0IgdBD0kNAiAIKAIwIQQgByEJDBQLIAggBDYCPCAIIAU2AixBFSEHDC0LIAggCjYCLEEVIQcMLAsgDEEBTQRAIAgoAhwhCgJAIBggCCgCMCIEQf8HcUEBdGouAQAiBUEASARAQQshCSAHQQtJDREDQCAEIAlBAWt2QQFxIAVBf3NqIgVBvwRLDRMgFyAFQQF0ai4BACIFQQBODQIgByAJQQFqIglPDQALDBELIAVBCXZBAWsgB08NEAsgByEJIAohCwwRCyAIIAxBAms2AiAgCCAIKAIcIgRBAmo2AhwgB0EQciEJIAgoAjAgBC8AACAHdHIhBAwRC0EVIQcgCCgCPCILQf8BSw0qIAgoAigiBSAIKAIsIgRGBEBBDSEEQQIhBQwjCyAEIAVPDQggCCgCJCAEaiALOgAAIAggBEEBajYCLEEMIQcMKgtBAyEHIAEtAOpRRQ0pIAggCCgCNCIFQXhxIAMgCCgCIGsiBCAFQQN2IgcgBCAHSRsiB0EDdGsiCzYCNCAEIAdrIgQgA00EQCAIKAIwIQkgCCADIARrNgIgIAggAiAEajYCHEEYIQcgCEF/IAtBGHF0QX9zIAkgBUEHcXZxNgIwDCoLIAQgAyADQciewQAQpgEACyAIIAgoAjwiBUH/A3EiBDYCPEEUIQcgBEGAAkYNKEEhIQcgBEGdAksNKCAIIAVBAWtBH3EiBC0A2J5BOgBAIAggBEEBdC8B+J5BNgI8QQ9BDiAEQRxrQWxJGyEHDCgLQR4hByAIKAIsIgQgCCgCOCIKSQ0nIAogCCgCKCIJSw0nAkAgCSAIKAI8IgsgBGoiDE8EQCAIKAIkIQUgBCAKayAESSALQQAgCmtNcg0BC0ETQQwgCxshBwwoCyAJIQcgBCAKayEJAkAgC0EDRgRAIARBA2ogB0sgBEF8S3INASAHIAlNIAlBAmoiCyAHT3INASAHIAlBAWoiB00NASAEIAVqIgQgBSAJai0AADoAACAEIAUgB2otAAA6AAEgBCAFIAtqLQAAOgACDAELIAUgByAJIAQgCxBICyAIIAw2AixBDCEHDCcLIAEoAsxRIQsCfwJAAkACQAJAIAgoAjQiBEUEQCAFDQEMDgsgCCgCMCEKAn8gBEEHSwRAIAQhDSAHDAELIAVFDQ4gBEEIciENIAVBAWshBSAHLQAAIAR0IApyIQogB0EBagshByABIApB/wFxIAtBCHRyIgk2AsxRIAggDUEIayIENgI0IAggCkEIdiIKNgIwIAggD0EBaiILNgI8IAtBBEYNDCAERQ0BAn8gBEEHSwRAIAQhDSAHDAELIAVFDQ4gBEEIciENIAVBAWshBSAHLQAAIAR0IApyIQogB0EBagshByABIApB/wFxIAlBCHRyIgk2AsxRIAggDUEIayIENgI0IAggCkEIdiILNgIwIAggD0ECaiIKNgI8IApBBEYNDCAERQ0CIARBB00NAyAEIQ4gBwwECyABIActAAAgC0EIdHIiCTYCzFEgB0EBaiEHIAVBAWshBSAIIA9BAWoiBDYCPCAEQQRGDQsLIAVFDQsgASAHLQAAIAlBCHRyIgk2AsxRIAdBAWohByAFQQFrIQUgCCAPQQJqIgQ2AjwgBEEERg0KCyAFRQ0KIAEgBy0AACAJQQh0ciIKNgLMUSAHQQFqIQcgBUEBayEFIAggD0EDaiIENgI8IARBBEYNCQwHCyAFRQ0JIARBCHIhDiAFQQFrIQUgBy0AACAEdCALciELIAdBAWoLIQcgASALQf8BcSAJQQh0ciIKNgLMUSAIIA5BCGsiBDYCNCAIIAtBCHYiDDYCMCAIIA9BA2oiCzYCPCALQQRGDQcgBEUNBQJ/IARBB0sEQCAEIQsgBwwBCyAFRQ0JIARBCHIhCyAFQQFrIQUgBy0AACAEdCAMciEMIAdBAWoLIQcgCCALQQhrNgI0IAggDEEIdjYCMCAMQf8BcSAKQQh0ciEJDAYLQf8BIQUMHAsgCCAKNgIsIAhBGGohJCAIQRxqIQ9BACENIAhBMGoiEi0AECETIBIoAgwhBCASKAIIIRQgEigCBCEJIBIoAgAhCkEMIRkCQCAIQSRqIhooAgQiECAaKAIIIgxrQYMCSQ0AIA8oAgQiEUEOSQ0AIAFBgC1qISggAUGAHWohKSABQYAUaiElIAFBgARqISYgGigCACEVIA8oAgAhBQNAIAUhBAJAAkADQCAJQQ5LBH8gCQUgDyARQQJrIhE2AgQgDyAEQQJqIgU2AgAgBC8AACAJdCAKciEKIAUhBCAJQRByCwJ/ICYgCkH/B3FBAXRqLgEAIgdBAEgEQEEKIQkDQCAKIAl2QQFxIAdBf3NqIgdBwARPBEBB//8BIQcgCUEBakH/AXEMAwsgCUEBaiEJICUgB0EBdGouAQAiB0EASA0ACyAJQf8BcQwBCyAHQQl2CyILayEJIAogC3YhCgJAAkAgB0GAAnFFBEAgCUEOSwR/IAkFIA8gEUECayIRNgIEIA8gBEECaiIFNgIAIAQvAAAgCXQgCnIhCiAFIQQgCUEQcgsCfyAmIApB/wdxQQF0ai4BACINQQBIBEBBCiEJA0AgCiAJdkEBcSANQX9zaiINQcAETwRAQf//ASENIAlBAWpB/wFxDAMLIAlBAWohCSAlIA1BAXRqLgEAIg1BAEgNAAsgCUH/AXEMAQsgDUEJdgshDiAMIBBPDQEgDmshCSAKIA52IQogGiAMQQFqIgs2AgggDCAVaiAHOgAAIA1BgAJxRQ0CIAshDCANIQcLQYACIQRBACENIAdB/wNxIgtBgAJHDQRBFCEZDAYLIAwgEEH4ncEAEJECAAsgCyAQTw0BIBogDEECaiIMNgIIIAsgFWogDToAAEEAIQ0gECAMa0GDAkkEQCAHIQQMBQsgEUEOTw0ACyAHIQQMAwsgCyAQQfidwQAQkQIACyALQZ0CSwRAQSEhGUH/ASENIAshBAwCCyAHQQFrQR9xIgtBAXRB+J7BAGoCfyAJQQ5LBEAgBSEHIAkMAQsgDyARQQJrIhE2AgQgDyAFQQJqIgc2AgAgBS8AACAJdCAKciEKIAlBEHILIQUgCy0A2J5BIRMvAQAhBAJAIAtBHGtBbEkEQCAHIQsMAQsgCiATdiEOIApBfyATdEF/c3EgBGohBCAFIBNrIglBDksEQCAHIQsgCSEFIA4hCgwBCyAPIBFBAmsiETYCBCAPIAdBAmoiCzYCACAJQRByIQUgBy8AACAJdCAOciEKCyAFAn8gKSAKQf8HcUEBdGouAQAiB0EASARAQQohCQNAIAogCXZBAXEgB0F/c2oiBUHABE8EQEH//wEhByAJQQFqQf8BcQwDCyAJQQFqIQkgKCAFQQF0ai4BACIHQQBIDQALIAlB/wFxDAELIAdBCXYLIgVrIQkgCiAFdiEKIAdB/wNxIgVBHUsEQEEiIRlB/wEhDQwCCyAHQf8BcSIHQQF2Ig4gDkEAR2shEyAFQQF0LwG8nUEhFAJAIAdBBEkEQCALIQUMAQsCfyAJQQ9PBEAgCyEFIAkhByAKDAELIA8gEUECayIRNgIEIA8gC0ECaiIFNgIAIAlBEHIhByALLwAAIAl0IApyCyELIAcgE0H/AXEiB2shCSALIAd2IQogC0F/IAd0QX9zcSAUaiEUCyAMIBRJIBAgFElyRQRAIAwgFGshBwJAIARBA0YEQCAMQQNqIBBLIAxBfEtyDQEgB0ECaiIOIBBPIAcgEE9yDQEgB0EBaiIqIBBPDQEgDCAVaiILIAcgFWotAAA6AAAgCyAVICpqLQAAOgABIAsgDiAVai0AADoAAgwBCyAVIBAgByAMIAQQSAsgGiAEIAxqIgw2AgggECAMa0GDAkkNAiARQQ1LDQEMAgsLQf8BIQ1BHiEZCyASIBM6ABAgEiAENgIMIBIgFDYCCCASIAk2AgQgEiAKNgIAICQgGToAASAkIA06AAAgCC0AGSEHIAgtABgiBUUNJAwaCyAKIAtB+J3BABCRAgALIAUgC0H4ncEAEJECAAsgBCAFQfidwQAQkQIACyAFRQ0CIAVBAWshBSAHLQAAIApBCHRyIQkgB0EBaiEHCyABIAk2AsxRIAggD0EEcjYCPAsgCCAFNgIgIAggBzYCHEEYIQcMHgsgCEEANgIgQRchBAwYCwJAIAxFBEAgByEJDAELIAdBCGohCSAKQQFqIQsgCi0AACAHdCAEciEEQQAhDCAHQQZLDQIgGCAEQf8HcUEBdGouAQAiBUEASARAIAdBA0kNAUELIQcDQCAEIAdBAWt2QQFxIAVBf3NqIgVBvwRLDQMgFyAFQQF0ai4BACIFQQBODQQgCSAHQQFqIgdPDQALDAELIAVBCXZBAWsgCUkNAgsgCCAJNgI0IAggBDYCMCAIQQA2AiBBDCEEDBcLIAVBwARB8JzBABCRAgALIAggDDYCICAIIAs2AhwLAkAgGCAEQf8HcUEBdGouAQAiBUEASARAQQohBwNAAkAgBCAHdkEBcSAFQX9zaiIFQcAETwRAIAdBAWohB0H//wEhBQwBCyAHQQFqIQcgFyAFQQF0ai4BACIFQQBIDQELCyAHQf8BcSEHDAELIAVBCXYhByAFQf8DcSEFCyAIIAU2AjwgCCAJIAdrNgI0IAggBCAHdjYCMEENIQcMGQtBFCEHIAgoAjxFDRhBByEHIAgoAiggCCgCLEcNGEEGIQRBAiEFDBALIAhBADYCPCAIIAgoAjQiBEF4cTYCNCAIIAgoAjAgBEEHcXY2AjBBBSEHDBcLIAgoAiQhCiAIKAI4IQwgCCgCPCEFIAgoAiwhByAIKAIoIQQCQANAIAQgB0YNASAKIAQgByAMayAHIAUgBCAHayILIAUgC0kbIgkQSCAHIAlqIQcgBSALSyAFIAlrIQUNAAsgCCAFNgI8IAggBzYCLEEMIQcMFwsgCCAFNgI8IAggBDYCLEETIQRBAiEFDA4LIAgoAigiBSAIKAIsIgRGBEBBEiEEQQIhBQwOCyAEIAVJBEAgCCgCJCAEaiAIKAI4OgAAIAggBEEBajYCLCAIKAI0IQQgCCAIKAI8QQFrIgU2AjxBEUEGIAQbQQYgBRshBwwWCyAEIAVB+J3BABCRAgALIAgoAjAhBwJ/IAgoAjQiBEEHSwRAIAQMAQsgCCgCICILRQRAQREhBAwRCyAIKAIcIQUgCCALQQFrNgIgIAggBUEBajYCHCAFLQAAIAR0IAdyIQcgBEEIcgshBCAIIAdB/wFxNgI4IAggBEEIazYCNCAIIAdBCHY2AjBBEiEHDBQLIAgoAjAhCQJAIAgoAjQiCyAILQBAIgxJBEAgCCgCICIERQRAIAshBwwCCyAIKAIcIQUCfyALQX9zIAtBCGoiByAMIAcgDEsbakEDdiIHIARBAWsiCiAHIApJGyIHQQRJBEAgBSEEIAshByAKDAELIAdBAWoiDUEDcSIKQQQgChsiDiAHQX9zaiEKIAQgDSAOayIHayAFIAdqIQQgCyAHQQN0aiEH/QwAAAAAAAAAAAAAAAAAAAAAIAn9HAAhKyAL/RH9DAAAAAAIAAAAEAAAABgAAAD9rgEhLQNAIAX9XAAA/YkB/akBIiz9GwAgLf0MHwAAAB8AAAAfAAAAHwAAAP1OIi79GwB0/REgLP0bASAu/RsBdP0cASAs/RsCIC79GwJ0/RwCICz9GwMgLv0bA3T9HAMgK/1QISsgBUEEaiEFIC39DCAAAAAgAAAAIAAAACAAAAD9rgEhLSAKQQRqIgoNAAsgKyArICz9DQgJCgsMDQ4PAAECAwABAgP9UCIrICsgK/0NBAUGBwABAgMAAQIDAAECA/1Q/RsAIQlBAWsLIQUDQAJAIARBAWohCiAELQAAIAd0IAlyIQkgB0EIaiIHIgsgDE8NACAKIQQgBUEBayIFQX9HDQEMAwsLIAggBTYCICAIIAo2AhwLIAggCyAMazYCNCAIIAkgDHY2AjAgCCAIKAI4IAlBfyAMdEF/c3FqNgI4QRYhBwwUCyAIIAc2AjQgCCAJNgIwIAhBADYCIEEQIQQMDgsCQCAIKAI0IgdBD08EQCAIKAIwIQQgByEJDAELAkACQAJAIAgoAiAiCkEBTQRAIAgoAhwhDAJAICEgCCgCMCIEQf8HcUEBdGouAQAiBUEASARAQQshCSAHQQtJDQMDQCAEIAlBAWt2QQFxIAVBf3NqIgVBvwRLDQUgICAFQQF0ai4BACIFQQBODQIgByAJQQFqIglPDQALDAMLIAVBCXZBAWsgB08NAgsgByEJIAwhCwwDCyAIIApBAms2AiAgCCAIKAIcIgRBAmo2AhwgB0EQciEJIAgoAjAgBC8AACAHdHIhBAwDCwJAIApFBEAgByEJDAELIAdBCGohCSAMQQFqIQsgDC0AACAHdCAEciEEQQAhCiAHQQZLDQIgISAEQf8HcUEBdGouAQAiBUEASARAIAdBA0kNAUELIQcDQCAEIAdBAWt2QQFxIAVBf3NqIgVBvwRLDQMgICAFQQF0ai4BACIFQQBODQQgCSAHQQFqIgdPDQALDAELIAVBCXZBAWsgCUkNAgsgCCAJNgI0IAggBDYCMCAIQQA2AiBBDyEEDBALIAVBwARB8JzBABCRAgALIAggCjYCICAIIAs2AhwLAkAgISAEQf8HcUEBdGouAQAiBUEASARAQQohBwNAAkAgBCAHdkEBcSAFQX9zaiIFQcAETwRAIAdBAWohB0H//wEhBQwBCyAHQQFqIQcgICAFQQF0ai4BACIFQQBIDQELCyAHQf8BcSEHDAELIAVBCXYhByAFQf8DcSEFCyAIIAkgB2s2AjQgCCAEIAd2NgIwQSIhByAFQR1LDRIgCCAFQQF0LwG8nUE2AjggCCAFQf4BcUEBdiIEIARBAEdrOgBAQRZBECAFQQRJGyEHDBILIAgoAjAhCQJAIAgoAjQiCyAILQBAIgxJBEAgCCgCICIERQRAIAshBwwCCyAIKAIcIQUCfyALQX9zIAtBCGoiByAMIAcgDEsbakEDdiIHIARBAWsiCiAHIApJGyIHQQRJBEAgBSEEIAshByAKDAELIAdBAWoiDUEDcSIKQQQgChsiDiAHQX9zaiEKIAQgDSAOayIHayAFIAdqIQQgCyAHQQN0aiEH/QwAAAAAAAAAAAAAAAAAAAAAIAn9HAAhKyAL/RH9DAAAAAAIAAAAEAAAABgAAAD9rgEhLQNAIAX9XAAA/YkB/akBIiz9GwAgLf0MHwAAAB8AAAAfAAAAHwAAAP1OIi79GwB0/REgLP0bASAu/RsBdP0cASAs/RsCIC79GwJ0/RwCICz9GwMgLv0bA3T9HAMgK/1QISsgBUEEaiEFIC39DCAAAAAgAAAAIAAAACAAAAD9rgEhLSAKQQRqIgoNAAsgKyArICz9DQgJCgsMDQ4PAAECAwABAgP9UCIrICsgK/0NBAUGBwABAgMAAQIDAAECA/1Q/RsAIQlBAWsLIQUDQAJAIARBAWohCiAELQAAIAd0IAlyIQkgB0EIaiIHIgsgDE8NACAKIQQgBUEBayIFQX9HDQEMAwsLIAggBTYCICAIIAo2AhwLIAggCyAMazYCNCAIIAkgDHY2AjAgCCAIKAI8IAlBfyAMdEF/c3FqNgI8QQ8hBwwSCyAIIAc2AjQgCCAJNgIwIAhBADYCIEEOIQQMDAsgCCgCMCEJAkAgCCgCNCILIAgtAEAiDEkEQCAIKAIgIgRFBEAgCyEHDAILIAgoAhwhBQJ/IAtBf3MgC0EIaiIHIAwgByAMSxtqQQN2IgcgBEEBayIKIAcgCkkbIgdBBEkEQCAFIQQgCyEHIAoMAQsgB0EBaiINQQNxIgpBBCAKGyIOIAdBf3NqIQogBCANIA5rIgdrIAUgB2ohBCALIAdBA3RqIQf9DAAAAAAAAAAAAAAAAAAAAAAgCf0cACErIAv9Ef0MAAAAAAgAAAAQAAAAGAAAAP2uASEtA0AgBf1cAAD9iQH9qQEiLP0bACAt/QwfAAAAHwAAAB8AAAAfAAAA/U4iLv0bAHT9ESAs/RsBIC79GwF0/RwBICz9GwIgLv0bAnT9HAIgLP0bAyAu/RsDdP0cAyAr/VAhKyAFQQRqIQUgLf0MIAAAACAAAAAgAAAAIAAAAP2uASEtIApBBGoiCg0ACyArICsgLP0NCAkKCwwNDg8AAQIDAAECA/1QIisgKyAr/Q0EBQYHAAECAwABAgMAAQID/VD9GwAhCUEBawshBQNAAkAgBEEBaiEKIAQtAAAgB3QgCXIhCSAHQQhqIgciCyAMTw0AIAohBCAFQQFrIgVBf0cNAQwDCwsgCCAFNgIgIAggCjYCHAsgCCALIAxrNgI0IAggCSAMdjYCMCAIQQs2AkwgCEKDgICAMDcCRCAIQcQAaiAIKAI4IgVBAnFBAnRqKAIAIAlBfyAMdEF/c3FqIQdBACEJIAgoAjwhBCAFQRBGBEAgASAEQQFrQf8DcWotAAAhCQsgBCAHaiIHQf8DcSIFIARB/wNxIgRJBEAgBCAFQYAEQaydwQAQpgEACyAFIARrIgUEQCABIARqIAkgBfwLAAsgCCAHNgI8QQohBwwRCyAIIAc2AjQgCCAJNgIwIAhBADYCIEELIQQMCwsgCCgCHCEKIAgoAiAhDgNAAkACQAJAAkACQAJAAkACQAJAIAgoAjwiCSABLwHkUSIEIAEvAeZRaiIFTwRAQRohByAFIAlHDRogBEGhAk8NAiAEBEAgIyABIAT8CgAACyABLwHmUSIHIAEvAeRRIgRqQf8DcSIFIARB/wNxIgRJDQMgBSAEayILIAdBH3EiBUcNBCAFBEAgFiABIARqIAX8CgAACyABIAEtAOtRQQFrOgDrUSAIQRBqIAEgCEEwahA0Qf8BIQUgCC0AECIEQf8BRw0BQQohBAwSCyAIKAI0IgdBD08EQCAIKAIwIQQgCiEMIAchCwwICyAOQQFNBEACQCAeIAgoAjAiBEH/B3FBAXRqLgEAIgxBAEgEQEELIQUgB0ELSQ0HA0AgBCAFQQFrdkEBcSAMQX9zaiINQb8ESw0JIB0gDUEBdGouAQAiDEEATg0CIAcgBUEBaiIFTw0ACwwHCyAMQQl2QQFrIAdPDQYLIAchCyAKIQwMBwsgCCAOQQJrIg42AiAgCCAKQQJqIgw2AhwgB0EQciELIAgoAjAgCi8AACAHdHIhBAwHCyAILQARIQcMBwtBACAEQaACQbiewQAQpgEACyAEIAVBgARBqJ7BABCmAQALIwBBIGsiACQAIAAgCzYCCCAAIAU2AgwgACAAQQxqrUKAgICA8ACENwMYIAAgAEEIaq1CgICAgPAAhDcDEEHDqMAAIABBEGpBmJ7BABCdAgALAkAgDkUEQCAHIQsgCiEMDAELIAdBCGohCyAKQQFqIQwgCi0AACAHdCAEciEEQQAhDiAHQQZLDQIgHiAEQf8HcUEBdGouAQAiBUEASARAIAdBA0kNAUELIQcDQCAEIAdBAWt2QQFxIAVBf3NqIg1BvwRLDQMgHSANQQF0ai4BACIFQQBODQQgCyAHQQFqIgdPDQALDAELIAVBCXZBAWsgC0kNAgtBACEOIAhBADYCICAIIAw2AhwgCCALNgI0IAggBDYCMEECIQRBASEHIAwhCgwDCyANQcAEQfCcwQAQkQIACyAIIA42AiAgCCAMNgIcCwJAIB4gBEH/B3FBAXRqLgEAIgVBAEgEQEEKIQcDQAJAIAQgB3ZBAXEgBUF/c2oiBUHABE8EQCAHQQFqIQdB//8BIQUMAQsgB0EBaiEHIB0gBUEBdGouAQAiBUEASA0BCwsgB0H/AXEhBwwBCyAFQQl2IQcgBUH/A3EhBQsgCCALIAdrNgI0IAggBCAHdjYCMCAIIAU2AjgCQCAFQRBPBEBBASEEIAlFBEBBICEHIAVBEEYNAgsgCEGChhw2AEQgCCAIQcQAaiAFQQNxai0AADoAQEELIQcgDCEKDAILIAEgCUH/A3FqIAU6AAAgCCAJQQFqNgI8QQAhBAsgDCEKCyAEQf8BcSIERQ0ACyAEQQJrDQ8gByEFQQohBwwFCyAIKAIgIQkgCCgCHCEKAkACQANAAn8gCCgCPCIHIAEvAehRTwRAIAFBEzsB6FEgCEEIaiABIAhBMGoQNEH/ASEFIAgtAAgiBEH/AUYNAyAILQAJDAELAn8CQCAIKAI0IgVBA08EQCAIKAIwIQQMAQsgCUUEQEEAIQlBAgwCCyAJQQFrIQkgCCgCMCAKLQAAIAV0ciEEIApBAWohCiAFQQhyIQULIAggBUEDazYCNCAIIARBA3Y2AjAgB0ETTw0EIBwgBy0Ahp1BaiAEQQdxOgAAIAggB0EBajYCPEEACyEEQQELIQcgBEUNAAsgBEECRwRAIAggCTYCICAIIAo2AhwMEQsgCCAJNgIgIAchBUEJIQcMBgsgCCAJNgIgQQkhBAwHCyAHQRNBnJ3BABCRAgALIAgoAjwiDkECTQRAIAgoAjAhByAIKAIcIQkgCCgCICELIAgoAjQhDSAIQQQ2AkwgCEKFgICA0AA3AkQCQAJAAkACQAJAIAhBxABqIA5BAnRqKAIAIgwgDU0EQCALIQogCSEEIA0hBQwBCyALRQRAIA4hDAwDCyALQQFrIQogDSEFAkADQCAJQQFqIQQgCS0AACAFdCAHciEHIAVBCGoiBSAMTw0BIAQhCSAKQQFrIgpBf0cNAAsgDiEMDAILIAggCjYCICAIIAQ2AhwLIB8gDkEBdCILaiALLwGAnUEgB0F/IAx0QX9zcWo7AQAgBSAMayENIAcgDHYhByAOQQFqIgxBA0YNAyAIQQQ2AkwgCEKFgICA0AA3AkQCQCAIQcQAaiAMQQJ0aigCACIPIA1NBEAgCiELIAQhCSANIQUMAQsgCkUNAiAKQQFrIQsgDSEFA0AgBEEBaiEJIAQtAAAgBXQgB3IhByAPIAVBCGoiBU0EQCAIIAs2AiAgCCAJNgIcDAILIAkhBCALQQFrIgtBf0cNAAsgCiELDAELIB8gDEEBdCIEaiAELwGAnUEgB0F/IA90QX9zcWo7AQAgBSAPayENIAcgD3YhByAOQQJqIgxBA0YNAyAIQQQ2AkwgCEHEAGogDEECdGooAgAiDiANTQRAIA0hBQwDCyALRQ0BIAtBAWshBCANIQUDQCAJQQFqIQogCS0AACAFdCAHciEHIA4gBUEIaiIFTQRAIAggBDYCICAIIAo2AhwMBAsgCiEJIARBAWsiBEF/Rw0ACwsgDSALQQN0aiENCyAIQQA2AiAgCCAMNgI8IAggDTYCNCAIIAc2AjBBCCEEDAsLIB8gDEEBdCIEaiAELwGAnUEgB0F/IA50QX9zcWo7AQAgBSAOayENIAcgDnYhBwsgCCANNgI0IAggBzYCMAsgHEEANgAPIBz9DAAAAAAAAAAAAAAAAAAAAAD9CwAAIAhBADYCPEEbQQlBGyABLwHmUUEfSRsgAS8B5FFBnwJPGyEHDA0LIAgoAiAiBUUEQEEHIQQMCAsgCCgCPCIJIAUgCCgCKCIKIAgoAiwiB2siBCAEIAVLGyIEIAQgCUsbIgQgB2oiCyAESSAKIAtJckUEQCAIKAIcIQogBARAIAgoAiQgB2ogCiAE/AoAAAsgCCAFIARrNgIgIAggBCAKajYCHCAIIAs2AiwgCCAJIARrNgI8QQYhBwwNCyAHIAsgCkGInsEAEKYBAAtBBCAIKAI8IgcgB0EETRshDCAIKAIgIQkgCCgCHCEKIAgoAjAhBCAIKAI0IQUDQCAHIAxGBEAgCCABQeDRAGovAQAiBDYCPEEfIQcgAS8B4lEgBHNB//8DRw0NQRQhByAERQ0NQRFBBiAFGyEHDA0LAkAgBQRAIAVBB00EQCAJRQRAQQUhBAwLCyAIIAlBAWsiCTYCICAIIApBAWoiCzYCHCAKLQAAIAV0IARyIQQgCyEKIAVBCHIhBQsgByAiaiAEOgAAIAggBUEIayIFNgI0IAggBEEIdiIENgIwDAELIAlFBEBBBSEEDAkLIAcgImogCi0AADoAACAIIAlBAWsiCTYCICAIIApBAWoiCjYCHEEAIQULIAggB0EBaiIHNgI8DAALAAsgCCgCICEEIAgoAhwhCQJAAkACQANAAkAgCCgCNCIFQQNPBEAgCCgCMCEHDAELIARFBEBBACEEQQEhBQwFCyAEQQFrIQQgCCgCMCAJLQAAIAV0ciEHIAlBAWohCSAFQQhyIQULIAEgB0EBcToA6lEgASAHQQF2QQNxIgs6AOtRIAggBUEDazYCNCAIIAdBA3Y2AjACQCALQQFrDgMAAgMNCyABQaCCgAE2AuRRICNBCEGQAfwLACAnQQlB8AD8CwAgG0KHjpy48ODBgwc3AhAgG0KHjpy48ODBgwc3AgggG0KHjpy48ODBgwc3AgAgAUKIkKDAgIGChAg3AphRIBZChYqUqNCgwYIFNwIAIBZChYqUqNCgwYIFNwIIIBZChYqUqNCgwYIFNwIQIBZChYqUqNCgwYIFNwIYIAggASAIQTBqEDQgCC0AACIFRQ0ACyAFQQFGBEAgCC0AAQwNC0H/ASEFDAILIAhBADYCPEEIDAsLQRkMCgsgCCAENgIgQQMhBwsgBUH/AXEiAkEBRgRAIAchBAwFCyACQfwBRw0AQfwBIQVBACEJIAchBAwFCyAHIQQLIAggCCgCNCICIAMgCCgCIGsiByACQQN2IgIgAiAHSxsiCUEDdGs2AjQMAwsgCCgCICIFRQRAQQIhBAwCCyABIAgoAhwiBy0AACIENgLIUSAIIAVBAWs2AiAgCCAHQQFqNgIcQR1BHUEDIAEoAsRRIgVBBHZBCGpBEHEgBCAFQQh0ckEfcCAEQSBxcnIbIAVBD3FBCEcbIQcMBgsgCCgCICIERQRAQQEhBAwBCyABIAgoAhwiBS0AADYCxFEgCCAEQQFrNgIgIAggBUEBajYCHEECIQcMBQtBAUEBQQIgBEH/AXFBF0YbIAgoAiggCCgCLEcbIQVBACEJCyABIAQ6AIBSIAEgCCgCNCICNgLAUSABIAgpAzg3AtRRIAEgCC0AQDoA7FEgACAFOgAEIAAgCCgCLCAGazYCCCAAIAMgCSAIKAIgams2AgAgASAIKAIwQX8gAnRBf3NxNgLcUQwFCyAB/QwAAAAAAAAAAAEAAAABAAAA/QsCxFEgCEEAOgBAIAj9DAAAAAAAAAAAAAAAAAAAAAD9CwMwQQMhBwwCC0EECyEHIAggBDYCICAIIAk2AhwMAAsACyAAQQA2AgggAEEANgIAIABB/QE6AAQLIAhB0ABqJAALqUQCGX8IfiMAQYACayIDJAAgA0EANgIMIANCgICAgMAANwIEIANBfzYCECADQQA2AlggA0EAOwFUIAMgAjYCUCADQQA2AkwgA0EBOgBIIANBCjYCRCADIAI2AkAgA0EANgI8IAMgAjYCOCADIAE2AjQgA0EKNgIwIANBFGohGCADQcQAaiEWIANBHGohFQJAAkACQAJAAkACQAJAAn8CQAJAAkADQCAWIAMtAEgiEWpBAWshGSADKAI4IRcgAygCUCEPIAMtAFQhGiADKAJAIQYgAygCNCESA0ACQAJAAkAgBiAXSyAEIAZLckUEQCAZLQAAIg1BgYKECGwhCQJAIBFBBUkEQANAIAQgEmohCgJAAkACQAJAIAYgBGsiC0EITwRAIApBA2pBfHEiASAKRg0BIAEgCmshAkEAIQEDQCABIApqLQAAIA1GDQUgAiABQQFqIgFHDQALIAIgC0EIayIMSw0DDAILIAQgBkYEQCAGIQQMBwsgDSAKLQAARgRAQQAhAQwECyALQQFGBEAgBiEEDAcLIA0gCi0AAUYEQEEBIQEMBAsgC0ECRgRAIAYhBAwHCyANIAotAAJGBEBBAiEBDAQLIAtBA0YEQCAGIQQMBwsgDSAKLQADRgRAQQMhAQwECyALQQRGBEAgBiEEDAcLIA0gCi0ABEYEQEEEIQEMBAsgC0EFRgRAIAYhBAwHCyANIAotAAVGBEBBBSEBDAQLIAtBBkYEQCAGIQQMBwsgDSAKLQAGRwRAIAYhBAwHC0EGIQEMAwsgC0EIayEMQQAhAgsDQEGAgoQIIAIgCmoiBSgCACAJcyIBayABckGAgoQIIAVBBGooAgAgCXMiAWsgAXJxQYCBgoR4cUGAgYKEeEcNASACQQhqIgIgDE0NAAsLIAIgC0YEQCAGIQQMBAsgAiAKaiEFIAYgAmsgBGshDEEAIQECQANAIAEgBWotAAAgDUYNASAMIAFBAWoiAUcNAAsgBiEEDAQLIAEgAmohAQsCQCABIARqQQFqIgQgEUkgBCAXS3JFBEAgEiAEIBFraiAWIBEQkwJFDQELIAQgBk0NAQwDCwsgAyAENgJMIAMgBDYCPEEAIRMgBCEMIAQhAgwFCwNAIAQgEmohCgJAAkACQAJAAkAgBiAEayILQQdNBEAgBCAGRw0BIAYhBAwHCyAKQQNqQXxxIgEgCkYNASABIAprIQJBACEBA0AgASAKai0AACANRg0FIAIgAUEBaiIBRw0ACyACIAtBCGsiDEsNAwwCCyANIAotAABGBEBBACEBDAQLIAtBAUYEQCAGIQQMBgsgDSAKLQABRgRAQQEhAQwECyALQQJGBEAgBiEEDAYLIA0gCi0AAkYEQEECIQEMBAsgC0EDRgRAIAYhBAwGCyANIAotAANGBEBBAyEBDAQLIAtBBEYEQCAGIQQMBgsgDSAKLQAERgRAQQQhAQwECyALQQVGBEAgBiEEDAYLIA0gCi0ABUYEQEEFIQEMBAsgC0EGRgRAIAYhBAwGCyANIAotAAZHBEAgBiEEDAYLQQYhAQwDCyALQQhrIQxBACECCwNAQYCChAggAiAKaiIFKAIAIAlzIgFrIAFyQYCChAggBUEEaigCACAJcyIBayABcnFBgIGChHhxQYCBgoR4Rw0BIAJBCGoiAiAMTQ0ACwsgAiALRgRAIAYhBAwDCyACIApqIQUgBiACayAEayEMQQAhAQJAA0AgASAFai0AACANRg0BIAwgAUEBaiIBRw0ACyAGIQQMAwsgASACaiEBCyARIAEgBGpBAWoiBE0gBCAXTXENAyAEIAZNDQALCyADIAQ2AjwLQQEhEyADQQE6AFUgGkEBcUUNASAHIQwgDyECDAILQQAgEUEEQbTSwQAQpgEACyAHIQwgDyICIAdGDQMLIAIgB2shBSAHIBJqIQgCQCACIAdGDQAgAiASakEBay0AAEEKRw0AAn8gBUEBayIBRQRAQX8hB0EADAELIAVBAmshByAIQQAgASAIakEBay0AAEENRhsLIQIgByABIAIbIQUgAiAIIAIbIQgLIAMgEEEBaiIbNgJYIAUgCGohB0EAIQEgCCECAkACQCAFRQRAQQAhCQwBCwNAIAEiCQJ/IAIiASwAACILQQBOBEAgC0H/AXEhBSACQQFqDAELIAEtAAFBP3EhAiALQR9xIQUgC0FfTQRAIAVBBnQgAnIhBSABQQJqDAELIAEtAAJBP3EgAkEGdHIhAiALQXBJBEAgAiAFQQx0ciEFIAFBA2oMAQsgBUESdEGAgPAAcSABLQADQT9xIAJBBnRyciEFIAFBBGoLIgIgAWtqIQECQCAFQSBGIAVBCWtBBUlyDQAgBUGFAUkNAgJAAkACQAJAIAVBCHYiC0EWaw4bAQYGBgYGBgYGBgMGBgYGBgYGBgYGBgYGBgYCAAsgCw0FIAVB/wFxLQCAz0FBAXFFDQUMAwsgBUGALUcNBAwCCyAFQYDgAEcNAwwBCyAFQf8BcS0AgM9BQQJxRQ0CCyACIAdHDQALQQAhCUEAIQEMAQsgAiAHRg0AA0ACQCAHIgtBAWsiBywAACIFQQBIBEAgBUE/cQJ/IAtBAmsiBy0AACIKwCIFQUBOBEAgCkEfcQwBCyAFQT9xAn8gC0EDayIHLQAAIgXAIg5BQE4EQCAFQQ9xDAELIA5BP3EgC0EEayIHLQAAQQdxQQZ0cgtBBnRyC0EGdHIhBQsCQCAFQSBGIAVBCWtBBUlyDQAgBUGFAUkNAQJAAkACQAJAIAVBCHYiCkEWaw4bAAUFBQUFBQUFBQIFBQUFBQUFBQUFBQUFBQUBAwsgBUGALUYNAwwECyAFQYDgAEYNAgwDCyAFQf8BcS0AgM9BQQJxDQEMAgsgCg0BIAVB/wFxLQCAz0FBAXFFDQELIAIgB0cNAQwCCwsgASACayALaiEBCyADIAEgCWsiCzYCZCADIAggCWoiDTYCYAJAAkAgEEUEQCALQQNGBEAgDS8AAEHw2AFzIA1BAmotAABB+QBzckUNAgtBlM3BAEESEKwCIQEgAEF/NgKsASAAIAE2AgAMCwsgCw0BCyAMIQcgGyEQIBNFDQEMAwsLIAEgCGohD0EAIQlBACEBQQAhDCANIgchAkEAIQZBACEEA0AgBiEKIARBAXENB0EBIQQCfwJAIAIgD0ZFBEADQCABIgUCfyACIgEsAAAiB0EATgRAIAdB/wFxIQcgAkEBagwBCyABLQABQT9xIQIgB0EfcSEGIAdBX00EQCAGQQZ0IAJyIQcgAUECagwBCyABLQACQT9xIAJBBnRyIQIgB0FwSQRAIAIgBkEMdHIhByABQQNqDAELIAZBEnRBgIDwAHEgAS0AA0E/cSACQQZ0cnIhByABQQRqCyICIAFraiEBIAdBCWsiBkEXTUEAQQEgBnRBn4CABHEbDQICQCAHQYUBSQ0AAkACQAJAAkAgB0EIdiIGQRZrDhsABAQEBAQEBAQEAgQEBAQEBAQEBAQEBAQEBAEDCyAHQYAtRg0GDAMLIAdBgOAARg0FDAILIAdB/wFxLQCAz0FBAnENBAwBCyAGDQAgB0H/AXEtAIDPQUEBcQ0DCyACIA9HDQALIA8hBwtBASEJIA8hAiALIQUgCgwBCyACIQcgASEMQQAhBCABCyEGIAUgCkYNAAsgCEUNBkEgECkiCARAIAggBSAKazYCBCAIIAogDWo2AgBBASEQQQQhDgNAIAwhAiAJIQQDQCACIQoCfwJAIARBAXFFBEBBASEEIAcgD0cEQANAIAEiBgJ/IAciASwAACIFQQBOBEAgBUH/AXEhBSABQQFqDAELIAEtAAFBP3EhAiAFQR9xIQcgBUFfTQRAIAdBBnQgAnIhBSABQQJqDAELIAEtAAJBP3EgAkEGdHIhAiAFQXBJBEAgAiAHQQx0ciEFIAFBA2oMAQsgB0ESdEGAgPAAcSABLQADQT9xIAJBBnRyciEFIAFBBGoLIgcgAWtqIQEgBUEJayICQRdNQQBBASACdEGfgIAEcRsNAwJAIAVBhQFJDQACQAJAAkACQCAFQQh2IgJBFmsOGwAEBAQEBAQEBAQCBAQEBAQEBAQEBAQEBAQEAQMLIAVBgC1GDQcMAwsgBUGA4ABGDQYMAgsgBUH/AXEtAIDPQUECcQ0FDAELIAINACAFQf8BcS0AgM9BQQFxDQQLIAcgD0cNAAsLQQEhCSALIQYgCgwCCwJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgCCgCBEEGaw4FAAECBQQFCyAIKAIAIgEoAABB5t7J6wZzIAFBBGovAABB4egBc3IgEEEDR3INBCAIKAIMQRRHDQwgCCgCCCIBKQAAQuLSuYumrt6v7ACFIAFBEGo1AABC5NKF8waFhCABKQAIQuno0ePW7Ney7gCFhEIAUg0MIAgoAhRBA0YEQEEBIRQgCCgCECIBLwAAQbHcAHMgAUECai0AAEEwc3JFDRYLIAMgCEEQaq1CgICAgNAAhDcD8AEgA0H0AGoiAUG5iMAAIANB8AFqEPgBIAEQrwIhAgwUCyAIKAIAIgIoAABB49616wZzIAJBA2oiASgAAEHtyrmjB3NyDQEMFAsgCCgCACIBKQAAQu/EqfuVzZuz7wBRDRMgASkAAELw5L2D18ycuvkAUg0CIBBBAU0NBSAIKAIMIgFBBEYEQCAIKAIIKAAAQezSzaMHRg0FCyAQQQNHDQUgAygCEEF/Rw0GQb3OwQBBGxCsAiECDBILIAIoAABB5diV6wZzIAEoAABB7cq5owdzciAQQQNHcg0BIAMoAhAhAiADQX82AhAgAkF/RwRAIAMoAgwiASADKAIERgRAIANBBGoQ8wELIAMoAgggAUEFdGoiBCACNgIAIAQgGCkCADcCBCAEIBj9AAII/QsCDCAEIBgoAhg2AhwgAyABQQFqNgIMCyAIKAIQIQwgCCgCDCEJIAgoAgghBkEAIQcgCCgCFCIEDgINBgcLIAgoAgAiASkAAELl3JH7ha3ZsOQAhSABQQhqMwAAQuXkAYWEUA0BCyADIANB4ABqrUKAgICA0ACENwPwASADQYwBaiIBQaeJwAAgA0HwAWoQjAEgARCvAiECDA8LIA5FDRYgCCAOQQN0EIECDBYLQZjOwQBBJRCsAiECDA0LIAMgA0HgAGqtQoCAgIDQAIQ3A/ABIANBgAFqIgFBjYnAACADQfABahD4ASABEK8CIQIMDAsgAyAIKAIIIgI2AugBIAMgATYC7AECfwJAAkACQAJAAkACQAJAAkACQCABQQNrDgQDAAECBwsgAigAAEHj0IWTB0cNA0EAIQdBAQwICyACKAAAQfXGoYsGcyACQQRqIgEtAABB8gBzckUEQEEBIQdBAQwICyACKAAAQfPQvZMHcyABLQAAQfQAc3INA0ECIQdBAgwHCyACKAAAQfXmofsGcyACQQRqIgEvAABB8ugBc3INA0EDIQdBAgwGCyACLwAAQencAXMgAkECai0AAEH0AHNyDQNBBCEHQQQMBQsgAigAAEH10rmjB0cNAkEFIQdBBAwECyACKAAAQebYvYsGcyABLQAAQfQAc3INAUEGIQdBBAwDCyACKAAAQeTe1ZMGcyABLwAAQezKAXNyRQ0BCyADIANB6AFqrUKAgICA0ACENwOYASADQfABaiIBQdWIwAAgA0GYAWoQjAEgARCvAiECDA0LQQchB0EICyECIAgoAhAhASAIKAIUIQkgAyACIAMoAiwiBGo2AiwgCUEASA0UAkAgCUUEQEEBIQYMAQsgCRApIgZFDQUgCUUNACAGIAEgCfwKAAALIAMoAiQiDCADKAIcRgRAIwBBEGsiBSQAIAVBBGogFSgCACIBIBUoAgRBBCABQQF0IgEgAUEETRsiAkEUENYBIAUoAgRBAUYEQCAFKAIIIAUoAgwQzAIACyAFKAIIIQEgFSACNgIAIBUgATYCBCAFQRBqJAALIAMoAiAgDEEUbGoiASAHOgAQIAEgBDYCDCABIAk2AgggASAGNgIEIAEgCTYCACADIAxBAWo2AiQMDAtBASEHIAwtAAAiAUEraw4DBgEGAQsgDC0AACEBCyAMIAFB/wFxQStGIgJqIQEgBCACayICQQlJDQJBACEFAkADQCACRQ0FIAEtAAAhBCAFrUIKfiIcQiCIpw0BIARBMGsiBEEKTwRAQQEQsQIhAgwLCyABQQFqIQEgAkEBayECIAQgHKdqIgUgBE8NAAtBAhCxAiECDAkLQQJBASAEQTBrQf8BcUEKSRshBwwECyADIAhBCGqtQoCAgIDQAIQ3A/ABIANB6ABqIgFB2ofAACADQfABahD4ASABEK8CIQIMBwtBASAJEMwCAAsgAkUEQEEAIQUMAQtBASEHIAEtAABBMGsiBUEJSw0BIAJBAUYNACABLQABQTBrIgRBCUsNASAEIAVBCmxqIQUgAkECRg0AIAEtAAJBMGsiBEEJSw0BIAQgBUEKbGohBSACQQNGDQAgAS0AA0EwayIEQQlLDQEgBCAFQQpsaiEFIAJBBEYNACABLQAEQTBrIgRBCUsNASAEIAVBCmxqIQUgAkEFRg0AIAEtAAVBMGsiBEEJSw0BIAQgBUEKbGohBSACQQZGDQAgAS0ABkEwayIEQQlLDQEgBCAFQQpsaiEFIAJBB0YNACABLQAHQTBrIgFBCUsNASABIAVBCmxqIQULIAlBAEgNDSAJDQFBASECDAILIAcQsQIhAgwDCyAJECkiAkUNASAJRQ0AIAIgBiAJ/AoAAAsgA0EANgIsIAMgBTYCKCADQQA2AiQgA0KAgICAwAA3AhwgAyAJNgIYIAMgAjYCFCADIAk2AhAMAgtBASAJEMwCAAsgAEF/NgKsASAAIAI2AgAgDkUNDQJAIAhBBGsoAgAiAEF4cSICIA5BA3QiAUEEQQggAEEDcSIAG2pPBEAgAEEAIAIgAUEnaksbDQEgCBBDDA8LDBELDBELAkAgDgRAIAhBBGsoAgAiAUF4cSIEIA5BA3QiAkEEQQggAUEDcSIBG2pJDREgAUEAIAQgAkEnaksbDQEgCBBDCyADKAJYIRAgAygCTCEHIAMoAjwhBCADLQBVQQFxRQ0GDAcLDBALIAEhDEEAIQQgAQshAiAGIApGDQALIA4gEEYEQAJAAn8gDkEBdEEBIA4bIgJB/////wBLBEBBACECIANB8AFqDAELQQQgAiACQQRNGyIEQQN0IQICfyAOBEAgCCAOQQN0QQQgAhBLDAELIAIQKQsiCA0BIANBBDYC8AEgA0GYAWoLIAI2AgAgAygC8AEgAygCmAEQzAIACyAEIQ4LIAggEEEDdGoiAiAGIAprNgIEIAIgCiANajYCACAQQQFqIRAMAAsACwtBBEEgEMwCAAsgAygCECECIANBfzYCECACQX9HBEAgAygCDCIBIAMoAgRGBEAgA0EEahDzAQsgAygCCCABQQV0aiIEIAI2AgAgBCAYKQIANwIEIAQgGP0AAgj9CwIMIAQgGCgCGDYCHCADIAFBAWo2AgwLIBRFBEBBuM3BAEEXEKwCIQEgAEF/NgKsASAAIAE2AgAMBwsgAygCDCIWQZPJpBJPDQAgAygCCCEEIAMoAgQhEAJAAkAgFkUEQEEAIRZBCCEMQQAhBwwBCyAWQThsIgEQKSIMRQ0BIAQgFkEFdGohCkEAIQcgBCECA0AgAyACKAIINgL4ASADIAIpAgA3A/ABIAIoAhQhCCACKAIQIQEgAigCDCENIAIoAhghFSACKAIcIQtByOTBAC0AAEUEQAJAIwBBEGsiDyQAIA9BADoADwJAAkBBARApIgkEQCAJQQRrKAIAIgZBeHEiBUEFQQkgBkEDcSIGG0kNASAGQQAgBUEpTxsNAiAJEENBuOTBACAPQQ9qrTcDAEHI5MEAQQE6AABBwOTBACAJrTcDACAPQRBqJAAMAwsQigMAC0Gg1sEAQS5B0NbBABDQAgALQeDWwQBBLkGQ18EAENACAAsLQbjkwQBBuOTBACkDACIdQgF8NwMAIANBiLrBAP0AAwD9CwMwIANBwOTBACkDACIcNwNIIAMgHTcDQAJAIAhFDQAgASAIQRRsaiEPIANBMGogCCAdIBwQMiABIQkDQCAJLQAQIRsgCSgCDCEXIAkoAgAhDiADKQNAIh0gAykDSCIcIAkoAgQiGSAJKAIIIhQQeyEeIAMoAjhFBEAgA0EwakEBIB0gHBAyCyAJQRRqIQkgAygCNCIaIB6ncSEIIB5CGYgiHkL/AINCgYKEiJCgwIABfiEdQQAhEiADKAIwIRFBACEGA0ACfwJAAkACQCAIIBFqKQAAIh8gHYUiHEJ/hSAcQoGChIiQoMCAAX2DQoCBgoSIkKDAgH+DIhxQRQRAA0AgESAceqdBA3YgCGogGnFBbGxqIgVBDGsoAgAgFEYEQCAZIAVBEGsoAgAgFBCTAkUNAwsgHEIBfSAcgyIcUEUNAAsLIB9CgIGChIiQoMCAf4MhHCASQQFHBEAgHFANAyAceqdBA3YgCGogGnEhEwtBASAcIB9CAYaDUA0DGiARIBNqLAAAIghBAE4EQCARIBEpAwBCgIGChIiQoMCAf4N6p0EDdiITai0AACEICyARIBNqIB6nQf8AcSIGOgAAIBEgE0EIayAacWpBCGogBjoAACARIBNBbGxqIgZBFGsgDjYCACAGQRBrIBk2AgAgBkEMayAUNgIAIAZBCGsgFzYCACAGQQRrIBs6AAAgAyADKAI8QQFqNgI8IAMgAygCOCAIQQFxazYCOAwBCyAFQQRrIBs6AAAgBUEIayAXNgIAIA5FDQAgGUEEaygCACIGQXhxIgVBBEEIIAZBA3EiBhsgDmpJDREgBkEAIAUgDkEnaksbDRIgGRBDCyAJIA9HDQMMBAtBAAshEiAGQQhqIgYgCGogGnEhCAwACwALAAsgDQRAIAFBBGsoAgAiBkF4cSIJIA1BFGwiBUEEQQggBkEDcSIGG2pJDQwgBkEAIAkgBUEnaksbDQ0gARBDCyAMIAdBOGxqIgEgA/0AA0D9CwMQIAEgA/0AAzD9CwMAIAEgCzYCJCABIBU2AiAgASADKQPwATcCKCABIAMoAvgBNgIwIAdBAWohByACQSBqIgIgCkcNAAsLAkAgEARAIARBBGsoAgAiAUF4cSIGIBBBBXQiAkEEQQggAUEDcSIBG3JJDQEgAUEAIAYgAkEnaksbDQwgBBBDCyADIAc2AqABIAMgDDYCnAEgAyAWNgKYAQJAIAcEQCAHQThsIgUhASAMIQIDQCACQTBqKAIAQQZGBEAgAkEsaigCACIEKAAAQfbKyaMHcyAEQQRqLwAAQeXwAXNyRQ0DCyACQThqIQIgAUE4ayIBDQALC0HPzcEAQRYQrAIhAgwGCyADQfABaiACQShqEI8CIAIoAiQhCyACKAIgIRAgA0EwaiACEGwgAygC8AEhDSADKQNIISAgAykDQCEhIAMoAjwhCiADKAI4IQ8gAygCNCEUIAMoAjAhCCADKQL0ASEeQc/NwQBBFhCsAiECIA1Bf0YNBSACIAIoAgAoAgARAwAgBSEBIAwhAgJ/AkADQCACQTBqKAIAQQVGBEAgAkEsaigCACIEKAAAQePQ1fMGcyAEQQRqLQAAQesAc3JFDQILIAJBOGohAiABQThrIgENAAtBfwwBCyADQTBqIAJBKGoQjwIgAigCJCETIAIoAiAhDiADQagBaiACEGwgAykCNCEiIAMoAjALIQkgBSEBIAwhAgJ/AkADQCACQTBqKAIAQQJGBEAgAkEsaigCAC8AAEHz0AFGDQILIAJBOGohAiABQThrIgENAAtBfwwBCyADQTBqIAJBKGoQjwIgAigCJCEXIAIoAiAhGyADQcgBaiACEGwgAykCNCEjIAMoAjALIQcgCkUNA0EAIQIDQCACIgFBCGohAiAUICEgICABKALozUEiBiABQezNwQBqKAIAIhUQeyIcp3EhASAcQhmIQv8Ag0KBgoSIkKDAgAF+IR1BACESA0AgASAIaikAACIfIB2FIhxCf4UgHEKBgoSIkKDAgAF9g0KAgYKEiJCgwIB/gyIcUEUEQANAAkAgFSAIIBx6p0EDdiABaiAUcUFsbGoiBEEMaygCAEcNACAGIARBEGsoAgAgFRCTAg0AIAJBMEcNBEEBDAkLIBxCAX0gHIMiHFBFDQALCyAfIB9CAYaDQoCBgoSIkKDAgH+DUEUNBSABIBJBCGoiEmogFHEhAQwACwALAAsMCQtBCCABEMwCAAsQ/AIAC0EACyEEIAxBLGohAgJ/A0ACQCACQQRqKAIAQQVHDQAgAigCACIBKAAAQePQ1fMGcyABQQRqLQAAQesAc3INAEEBDAILIAJBOGohAiAFQThrIgUNAAtBAAshASAAIAMoAqABNgK0ASAAIAMpApgBNwKsASAAIAP9AAOoAf0LAwAgACAD/QADuAH9CwMQIAAgIjcCLCAAIAk2AiggACATNgIkIAAgDjYCICAAIAP9AAPIAf0LAzggACAD/QAD2AH9CwNIIAAgAToAuQEgACAEOgC4ASAAIBA2AqgBIAAgHjcCnAEgACANNgKYASAAIAs2ApQBIAAgEDYCkAEgACAgNwOIASAAICE3A4ABIAAgCjYCfCAAIA82AnggACAUNgJ0IAAgCDYCcCAAICM3AmQgACAHNgJgIAAgFzYCXCAAIBs2AlgMBAsgAEF/NgKsASAAIAI2AgAgA0GYAWoQtAEMAwtBAEEAQajNwQAQkQIACyADKAIQIgRBf0YNACAEBEAgAygCFCICQQRrKAIAIgBBeHEiAUEEQQggAEEDcSIAGyAEakkNAyAAQQAgASAEQSdqSxsNBCACEEMLIAMoAiAhACADKAIkIgEEQCAAIQIDQCACKAIAIgwEQCACQQRqKAIAIgdBBGsoAgAiBEF4cSIGQQRBCCAEQQNxIgQbIAxqSQ0FIARBACAGIAxBJ2pLGw0GIAcQQwsgAkEUaiECIAFBAWsiAQ0ACwsgAygCHCICRQ0AIABBBGsoAgAiAUF4cSIEIAJBFGwiAkEEQQggAUEDcSIBG2pJDQIgAUEAIAQgAkEnaksbDQMgABBDCyADKAIIIQ8gAygCDCIFBEBBACEMA0AgDyAMQQV0aiILKAIAIgQEQCALKAIEIgJBBGsoAgAiAEF4cSIBQQRBCCAAQQNxIgAbIARqSQ0EIABBACABIARBJ2pLGw0FIAIQQwsgCygCECEAIAsoAhQiAQRAIAAhAgNAIAIoAgAiCQRAIAJBBGooAgAiB0EEaygCACIEQXhxIgZBBEEIIARBA3EiBBsgCWpJDQYgBEEAIAYgCUEnaksbDQcgBxBDCyACQRRqIQIgAUEBayIBDQALCyALKAIMIgIEQCAAQQRrKAIAIgFBeHEiBCACQRRsIgJBBEEIIAFBA3EiARtqSQ0EIAFBACAEIAJBJ2pLGw0FIAAQQwsgDEEBaiIMIAVHDQALCyADKAIEIgFFDQAgD0EEaygCACIAQXhxIgIgAUEFdCIBQQRBCCAAQQNxIgAbckkNASAAQQAgAiABQSdqSxsNAiAPEEMLIANBgAJqJAAPC0Gg1sEAQS5B0NbBABDQAgALQeDWwQBBLkGQ18EAENACAAvZOwMnfwR9An4jAEGwDGsiAyQAAkACQAJAAkACQAJAAkAgACgC3AQiBEF/Rw0AIAAoAvAEIgFBBEkNAQJAIAAoAuwEIgQvAAAgBC0AAkEQdHJB8NjlA0YEQCABQQtJDQMgAUEKayEHA0AgAiAEaiIFKQAAQuXckfuFrdmw5ACFIAVBA2opAABC39CVi8asmbkKhYRQDQIgByACQQFqIgJHDQALIAFBgIAESQ0DQdy1wABBFBCpAiEBDAcLQYC2wABBEBCpAiEBDAYLAkAgASACTwRAIANByAdqIAQgAhBcIAMoAsgHQQFGBEAgAykCzAcQsAIhAQwICyADQcgHaiIEIAMoAswHIAMoAtAHECQgAygCyAchASADKAL0CCIHQX9GDQcgA0EEciAEQQRyQagB/AoAACADIAP9AAP4CP0LA7ABIAMgBzYCrAEgAyABNgIAAkACQCADLQC5ASIKRQRAIANB8ABqIQEgAy0AuAFFBEAgAygCqAEhByADKAKUASEFIANBiAZqIgggARBsIAQgByAFIAgQMSADKALIByEBIAMoAqQMIgRBf0YNAyADKALMByEFIANB+ARqIANB0AdqQYwB/AoAACADKQPgCCEsIAMoAtwIIQYgA0GoA2ogA0HoCGpBzAH8CgAAIAMoArgKIQsgAygCtAohCCADQZgCaiADQbwKakGQAfwKAAAgAygCzAshCSADQcABaiADQdALakHUAPwKAAAgAykDqAwhLSAAQfQEaiAHIAkQlAEMAgsgAygCqAEhBCADKAKUASEHIANBiAZqIgUgARBsIANByAdqIAQgByAFEEkgAygCyAchASADKALcCCIGQX9GDQIgAygCzAchBSADQfgEaiADQdAHakGMAfwKAAAgAykD4AghLCAAQfQEaiAEQQAQlAFBgICAgHghBAwBCyADQYgGaiIBIANBwAH8CgAAIANByAdqIAEQKyADKALMByEFIAMoAsgHIgFBf0cEQCADQfgEaiADQdAHakGMAfwKAAAgAykC4AghLCADKALcCCEGIANBqANqIANB6AhqQcwB/AoAACAAQfQEaiADKAK0CiIIIAMoArgKIgsQlAFBgoCAgHghBAwBCyAFIQEMCQsgACgC8AQiByACQQtqIgJPBEAgAEEANgLwBCACIAdHBEAgByACayIHBEAgACgC7AQiDCACIAxqIAf8CgAACyAAIAc2AvAECyAAEC4gACAFNgIEIAAgATYCACAAQQhqIANB+ARqQYwB/AoAACAAICw3A5gBIAAgBjYClAEgAEGgAWogA0GoA2pBzAH8CgAAIAAgCzYC8AIgACAINgLsAiAAQfQCaiADQZgCakGQAfwKAAAgACAJNgKEBCAAQYgEaiADQcABakHUAPwKAAAgACAtNwPgBCAAIAQ2AtwEIApFDQMMBAtBACACIAdB8M7BABCmAQALIAMQXwwHC0EAIAIgAUHwtcAAEKYBAAsgAxBfIAAoAtwEIgRBf0YNAQsCQAJAIARBgICAgHhzQQEgBEEASCICG0EBaw4CBAEACyAEQYCAgIB4RgRAAkACQAJAAkAgACgCXCICBEAgACgC8AQhBCAAQfQEaiENIABBlAFqIQ4gAEGIAWohESAAKAJgIQFBACEKA0BBgIAEIQcgBCAKayIFIAJuIgIgACgCWCIIIAFrIgFBACABIAhNGyIBIAEgAksbIgJBgIAETQRAIAIiB0UNDAsgACAHEFRBfCEGQQAhC0EDIQRBfSEJQQAhAkEAIQgCQAJAA0AgACgCKCAALQAsIAAoAuwEIAAoAvAEIAAoAlwgCGwgCmoiARCEASEoAn0CQAJ/IARBA2siDCAAKAJsIgVPBEAgDAwBCyAAKAJoIAJqICg4AgAgACgCMCAALQA0IAAoAuwEIAAoAvAEIAEQhAEhKCAEQQJrIhIgACgCbCIFSQRAIAAoAmggAmpBBGogKDgCACAAKAI4IAAtADwgACgC7AQgACgC8AQgARCEASEoIARBAWsiDyAAKAJsIgVJBEAgACgCaCACakEIaiAoOAIAIAAtACQiBUH/AUcNA0MAAIA/DAQLIARBAWsMAQsgBEECawsgBUGwucAAEJECAAsgACgCICAFIAAoAuwEIAAoAvAEIAEQhAELISgCQAJ/AkAgACgCeCIFIAhLBEAgACgCdCALaiAoOAIAIAAoAkAgAC0ARCAAKALsBCAAKALwBCABEIQBISggDCAAKAKEASIFSQ0BIARBA2sMAgsgCCAFQZC5wAAQkQIACyAAKAKAASACaiAoOAIAIAAoAkggAC0ATCAAKALsBCAAKALwBCABEIQBISggACgChAEiBSASSwRAIAAoAoABIAJqQQRqICg4AgAgACgCUCAALQBUIAAoAuwEIAAoAvAEIAEQhAEhKCAAKAKEASIFIA9LBEAgACgCgAEgAmpBCGogKDgCACAEIAAoApABIgFNDQNBACAEIAFB8M7BABCmAQALIARBAWsMAQsgBEECawsgBUGgucAAEJECAAsgACAMNgKQASADQe+kjNQDNgLsByADQu+kjNTzzcTBOjcC5AcgA0KAgICAMDcC3AcgAyAENgLUByADIBE2AtAHIAMgASAJajYC2AcgA0HIB2oiDBA+IAtBBGoiASAAKAKcASIFSw0BIAAgCzYCnAEgA/0MAAAAAAAAAAAAAAAAAACAP/0LAuQHIANCgICAgMAANwLcByADIAE2AtQHIAMgDjYC0AcgAyAFIAZqNgLYByAJQQNrIQkgBEEDaiEEIAJBDGohAiAGQQRrIQYgDBA+IAEhCyAIQQFqIgggB0kNAAsgB0EDbCICIAAoAmwiAU0NAUEAIAIgAUGAucAAEKYBAAtBACABIAVB8M7BABCmAQALIAcgACgCeCIBSw0CIAIgACgChAEiAUsNAyACIAAoApABIgFLDQQgB0ECdCIBIAAoApwBIgRLDQUgACgCYCEEIAAoAmghBSAAKAJ0IQggACgCgAEhCyAAKAKMASEGIANCBDcCgAggA0IENwL4ByADQgQ3AvAHIAMgATYC7AcgAyACNgLkByADIAY2AuAHIAMgAjYC3AcgAyALNgLYByADIAc2AtQHIAMgCDYC0AcgAyACNgLMByADIAU2AsgHIAMgACgCmAE2AugHIA0gBCAHIANByAdqEDAgACAAKAJgIAdqIgE2AmAgACgCXCICIAdsIApqIQogACgC8AQhBCACDQALC0GwuMAAEP0CAAtBACAHIAFB8LjAABCmAQALQQAgAiABQeC4wAAQpgEAC0EAIAIgAUHQuMAAEKYBAAtBACABIARBwLjAABCmAQALQYSvwQBBKEHAucAAENACAAsCQAJAIARBgoCAgHhGBEAgACgC6AIiASAAKAIISQ0BIAAoAvAEIQJBACEB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IAAoAuwEIAAoAvAEIAYQhAEhKCAAKAK0BCIJIAEiAk0NACAAKAKwBCANaiAoEHM4AgAgACgC0AMgAC0A1AMgACgC7AQgACgC8AQgBhCEASEoIAAoArQEIgkgBCICTQ0AIAAoArAEIA5qICgQczgCACAAKAIgIAAtACQgACgC7AQgACgC8AQgBhCEASEoIAAoAiggAC0ALCAAKALsBCAAKALwBCAGEIQBISkgACgCMCAALQA0IAAoAuwEIAAoAvAEIAYQhAEhKiAAKAI4IAAtADwgACgC7AQgACgC8AQgBhCEASErIAVBAnQiAiAAKALABCIESQ0BDAILIAIgCUHwt8AAEJECAAsgACgCvAQgAkECdGogKCAoICiUICkgKZSSICogKpSSICsgK5SSkSIolTgCACACQQFyIgEgACgCwAQiBE8EQCABIQIMAQsgACgCvAQgAUECdGogKSAolTgCACACQQJyIgEgACgCwAQiBE8EQCABIQIMAQsgACgCvAQgAUECdGogKiAolTgCACACQQNyIgIgACgCwAQiBE8NACAAKAK8BCACQQJ0aiArICiVOAIAIAAtAOQCIgJB/wFHDQEMAgsgAiAEQeC3wAAQkQIACyAALQCkAyEJIAAoAqADIAAtAJwDIQ0gACgCmAMgAC0AlAMhDyAAKAKQAyAALQCMAyETIAAoAogDIAAtAIQDIRUgACgCgAMgAC0A/AIhFyAAKAL4AiAALQD0AiEZIAAoAvACIAAtAOwCIQEgACgC6AIgACgC4AIgAiAAKALsBCAAKALwBCAGEIQBISggBUEJbCICIAAoAswEIgRPDQQgACgCyAQgAkECdGogKDgCACABIAAoAuwEIAAoAvAEIAYQhAEhKCACQQFqIgEgACgCzAQiBE8EQCABIQIMBQsgACgCyAQgAUECdGogKDgCACAZIAAoAuwEIAAoAvAEIAYQhAEhKCACQQJqIgEgACgCzAQiBE8EQCABIQIMBQsgACgCyAQgAUECdGogKDgCACAXIAAoAuwEIAAoAvAEIAYQhAEhKCACQQNqIgEgACgCzAQiBE8EQCABIQIMBQsgACgCyAQgAUECdGogKDgCACAVIAAoAuwEIAAoAvAEIAYQhAEhKCACQQRqIgEgACgCzAQiBE8EQCABIQIMBQsgACgCyAQgAUECdGogKDgCACATIAAoAuwE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/QsDsAEgAyAHNgKsASADIAE2AgACQAJAIAMtALkBIgtFBEAgA0HwAGohASADLQC4AUUEQCADKAKoASEHIAMoApQBIQUgA0GIBmoiCCABEGwgBCAHIAUgCBAxIAMoAsgHIQEgAygCpAwiBEF/Rg0DIAMoAswHIQUgA0H4BGogA0HQB2pBjAH8CgAAIAMpA+AIISwgAygC3AghBiADQagDaiADQegIakHMAfwKAAAgAygCuAohCiADKAK0CiEIIANBmAJqIANBvApqQZAB/AoAACADKALMCyEJIANBwAFqIANB0AtqQdQA/AoAACADKQOoDCEtIAAgByAJEHwMAgsgAygCqAEhBCADKAKUASEHIANBiAZqIgUgARBsIANByAdqIAQgByAFEEkgAygCyAchASADKALcCCIGQX9GDQIgAygCzAchBSADQfgEaiADQdAHakGMAfwKAAAgAykD4AghLCAAIARBABB8QYCAgIB4IQQMAQsgA0GIBmoiASADQcAB/AoAACADQcgHaiABECsgAygCzAchBSADKALIByIBQX9HBEAgA0H4BGogA0HQB2pBjAH8CgAAIAMpAuAIISwgAygC3AghBiADQagDaiADQegIakHMAfwKAAAgACADKAK0CiIIIAMoArgKIgoQfEGCgICAeCEEDAELIAUhAQwJCyAAKALIBSIHIAJBC2oiAk8EQCAAQQA2AsgFIAIgB0cEQCAHIAJrIgcEQCAAKALEBSIPIAIgD2ogB/wKAAALIAAgBzYCyAULIABB2ABqEC4gACAFNgJcIAAgATYCWCAAQeAAaiADQfgEakGMAfwKAAAgACAsNwPwASAAIAY2AuwBIABB+AFqIANBqANqQcwB/AoAACAAIAo2AsgDIAAgCDYCxAMgAEHMA2ogA0GYAmpBkAH8CgAAIAAgCTYC3AQgAEHgBGogA0HAAWpB1AD8CgAAIAAgLTcDuAUgACAENgK0BSALRQ0DDAQLQQAgAiAHQfDOwQAQpgEACyADEF8MBwtBACACIAFB8LXAABCmAQALIAMQXyAAKAK0BSIEQX9GDQELIABB2ABqIQ8CQAJAIARBgICAgHhzQQEgBEEASCICG0EBaw4CBAEACyAEQYCAgIB4RgRAAkACQAJAAkAgACgCtAEiAgRAIAAoAsgFIQQgAEHsAWohDSAAQeABaiEOIAAoArgBIQFBACELA0BBgIAEIQcgBCALayIFIAJuIgIgACgCsAEiCCABayIBQQAgASAITRsiASABIAJLGyICQYCABE0EQCACIgdFDQwLIA8gBxBUQXwhBkEAIQpBAyEEQX0hCUEAIQJBACEIAkACQANAIAAoAoABIAAtAIQBIAAoAsQFIAAoAsgFIAAoArQBIAhsIAtqIgEQhAEhKAJ9AkACfyAEQQNrIgwgACgCxAEiBU8EQCAMDAELIAAoAsABIAJqICg4AgAgACgCiAEgAC0AjAEgACgCxAUgACgCyAUgARCEASEoIARBAmsiEiAAKALEASIFSQRAIAAoAsABIAJqQQRqICg4AgAgACgCkAEgAC0AlAEgACgCxAUgACgCyAUgARCEASEoIARBAWsiECAAKALEASIFSQRAIAAoAsABIAJqQQhqICg4AgAgAC0AfCIFQf8BRw0DQwAAgD8MBAsgBEEBawwBCyAEQQJrCyAFQbC5wAAQkQIACyAAKAJ4IAUgACgCxAUgACgCyAUgARCEAQshKAJAAn8CQCAAKALQASIFIAhLBEAgACgCzAEgCmogKDgCACAAKAKYASAALQCcASAAKALEBSAAKALIBSABEIQBISggDCAAKALcASIFSQ0BIARBA2sMAgsgCCAFQZC5wAAQkQIACyAAKALYASACaiAoOAIAIAAoAqABIAAtAKQBIAAoAsQFIAAoAsgFIAEQhAEhKCAAKALcASIFIBJLBEAgACgC2AEgAmpBBGogKDgCACAAKAKoASAALQCsASAAKALEBSAAKALIBSABEIQBISggACgC3AEiBSAQSwRAIAAoAtgBIAJqQQhqICg4AgAgBCAAKALoASIBTQ0DQQAgBCABQfDOwQAQpgEACyAEQQFrDAELIARBAmsLIAVBoLnAABCRAgALIAAgDDYC6AEgA0HvpIzUAzYC7AcgA0LvpIzU883EwTo3AuQHIANCgICAgDA3AtwHIAMgBDYC1AcgAyAONgLQByADIAEgCWo2AtgHIANByAdqIgwQPiAKQQRqIgEgACgC9AEiBUsNASAAIAo2AvQBIAP9DAAAAAAAAAAAAAAAAAAAgD/9CwLkByADQoCAgIDAADcC3AcgAyABNgLUByADIA02AtAHIAMgBSAGajYC2AcgCUEDayEJIARBA2ohBCACQQxqIQIgBkEEayEGIAwQPiABIQogCEEBaiIIIAdJDQALIAdBA2wiAiAAKALEASIBTQ0BQQAgAiABQYC5wAAQpgEAC0EAIAEgBUHwzsEAEKYBAAsgByAAKALQASIBSw0CIAIgACgC3AEiAUsNAyACIAAoAugBIgFLDQQgB0ECdCIBIAAoAvQBIgRLDQUgACgCuAEhBCAAKALAASEFIAAoAswBIQggACgC2AEhCiAAKALkASEGIANCBDcCgAggA0IENwL4ByADQgQ3AvAHIAMgATYC7AcgAyACNgLkByADIAY2AuAHIAMgAjYC3AcgAyAKNgLYByADIAc2AtQHIAMgCDYC0AcgAyACNgLMByADIAU2AsgHIAMgACgC8AE2AugHIAAgBCAHIANByAdqECogACAAKAK4ASAHaiIBNgK4ASAAKAK0ASICIAdsIAtqIQsgACgCyAUhBCACDQALC0GwuMAAEP0CAAtBACAHIAFB8LjAABCmAQALQQAgAiABQeC4wAAQpgEAC0EAIAIgAUHQuMAAEKYBAAtBACABIARBwLjAABCmAQALQYSvwQBBKEHAucAAENACAAsCQAJAIARBgoCAgHhGBEAgACgCwAMiASAAKAJgSQ0BIAAoAsgFIQJBACEBIABBADYCyAUgAg0CDAcLQYSvwQBBKEHwusAAENACAAtBACEIAkACQANAAkAgACgCXCABQQZ0aiIBKAIkIgQEQCAEIAAoAsgFIgUgCGsiB00NAQwEC0HQucAAEP0CAAsgAS0APCEKQYCABCECIAcgBG4iBiABKAIgIgkgASgCOCIHayIBQQAgASAJTRsiASABIAZLGyIBQYCABE0EQCABIgJFDQMLAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgCkEBaw4DAgEMAAsgDyACIAggBCAAKALEBSAFEF0MCwsgACgC3AFBf0cNAQwKCyAPIAIgByAIIAQgACgCxAUgBRA4IgENEiACQQNsIgEgACgCeCIFSw0BIAIgACgChAEiBUsNAiABIAAoApABIgVLDQMgASAAKAKcASIFSw0EIAJBAnQiBSAAKAKoASIKSw0FIAAoAnQhCiAAKAKAASEGIAAoAowBIQkgACgCmAEhCyADQgQ3AoAIIANCBDcC+AcgA0IENwLwByADIAU2AuwHIAMgATYC5AcgAyALNgLgByADIAE2AtwHIAMgCTYC2AcgAyAC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KALQAiAALQDMAiEBIAAoAsgCIAAoAsACIAIgACgCxAUgACgCyAUgBhCEASEoIAVBD2wiAiAAKAKwBSIETw0DIAAoAqwFIAJBAnRqICg4AgAgASAAKALEBSAAKALIBSAGEIQBISggAkEBaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgJSAAKALEBSAAKALIBSAGEIQBISggAkECaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgIyAAKALEBSAAKALIBSAGEIQBISggAkEDaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgISAAKALEBSAAKALIBSAGEIQBISggAkEEaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgHyAAKALEBSAAKALIBSAGEIQBISggAkEFaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgHSAAKALEBSAAKALIBSAGEIQBISggAkEGaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgGyAAKALEBSAAKALIBSAGEIQBISggAkEHaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgGSAAKALEBSAAKALIBSAGEIQBISggAkEIaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgFyAAKALEBSAAKALIBSAGEIQBISggAkEJaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgFSAAKALEBSAAKALIBSAGEIQBISggAkEKaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgEyAAKALEBSAAKALIBSAGEIQBISggAkELaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgECAAKALEBSAAKALIBSAGEIQBISggAkEMaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAgDSAAKALEBSAAKALIBSAGEIQBISggAkENaiIBIAAoArAFIgRPBEAgASECDAQLIAAoAqwFIAFBAnRqICg4AgAg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ASEIQe6vwQBB4ODAACACG0Hur8EAQQEgAhsgARshESAjQj+IpyABciEOIARBAjsB6AkgAEECRg0BIARBAzYC8AkgBEHk4MAANgLsCSAEQegJagwCCyAEQQM2AvAJIARB4eDAADYC7AkgBEECOwHoCUEBIRFBASEIIARB6AlqDAELIARBATYC8AkgBEHnsMEANgLsCSAEQegJagshACAEIAg2AswIIAQgADYCyAggBCAONgLECCAEIBE2AsAIIA0gBEHACGoQZCAEQZALaiQADAQLIwBBEGsiACQAIAAgBEHoCWo2AgwgACAEQcAIajYCCCAAQQhqQcDgwAAgAEEMakHA4MAAQQBBsOHAABDBAQALQShBKEH44cAAEJECAAtB2+HAAEEaQfjhwAAQ0AIACwwFCw8LAn8gASETIAJBAEchGSABLwEOIRIjAEHwDmsiBSQAIDi9IiZC/////////weDIiVCgICAgICAgAiEICZCAYZC/v///////w+DICZCNIinQf8PcSIBGyIjQgGDISRBAiEAAkACQAJ/AkACQAJAAn8CfwJAAkACQAJAAkAgJVAiAkECQQMgAhtBBCAmQoCAgICAgID4/wCDIiVQGyAlQoCAgICAgID4/wBRG0EBaw4EAgAEAQMLQQQhAAwCC0KAgICAgICAICAjQgGGICNCgICAgICAgAhRIgAbISNBy3dBzHcgABsgAWohCyAkUAwDC0EDIQALICZCP4inIQYgAEECawwCCyABQbMIayELICRQCyEAICZCP4ghJyAAQf8BcUEBTQ0DICenIQYgAEECawtB/wFxIgIEQEEBIQBB7q/BAEHg4MAAIAYbQe6vwQBBASAGGyAZGyEGICZCP4inIBlyIQEgAkECRw0BIAVBAjsBzA0gEg0CIAVBATYC1A0gBUHnsMEANgLQDSAFQcwNagwECyAFQQM2AtQNIAVB4eDAADYC0A0gBUECOwHMDUEBIQZBACEBQQEhACAFQcwNagwDCyAFQQM2AtQNIAVB5ODAADYC0A0gBUECOwHMDSAFQcwNagwCCyAFIBI2AtwNIAVBADsB2A1BAiEAIAVBAjYC1A0gBUHn4MAANgLQDSAFQcwNagwBCwJAAkACQAJAAkACQAJAAn8CQAJAAkBBdEEFIAtBAEgbIAtsIgFBwP0ASQRAICNQDQEgCyAjeSIkp2si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AEG/f0oNAiADIQACQANAIAAgBmosAABBv39KDQEgAEEBayIADQALQQAhAAsCQANAIAMgBmosAABBv39KDQEgASADQQFqIgNHDQALIAEhAwsgBSAANgIMIAUgAzYCECAAIANLDQECQCAARQ0AIAAgAU8EQCAAIAFGDQEMAwsgACAGaiwAAEFASA0CCwJAIAEgA00EQCABIANHDQMMAQsgAyAGaiwAAEG/f0wNAgsgACADRg0AIAUCfyAAIAZqIgEsAAAiAEEATgRAIABB/wFxDAELIAEtAAFBP3EiAyAAQR9xIgJBBnRyIABBX00NABogAS0AAkE/cSADQQZ0ciIDIAJBDHRyIABBcEkNABogAkESdEGAgPAAcSABLQADQT9xIANBBnRycgs2AhQgBSAFQQxqrUKAgICA4AKENwMoIAUgBUEUaq1CgICAgPAChDcDICAFIAVBBGqtQoCAgIDwAIQ3AxhBsqfAACAFQRhqIAQQnQIACyAEEPsCAAsgBiABIAAgAyAEEOMCAAsgBSAFQQhqrUKAgICA8ACENwMgIAUgBUEEaq1CgICAgPAAhDcDGEHjhMAAIAVBGGogBBCdAgALFAAgACgCACABIAAoAgQoAgwRAQALFQIBbwF/EAEhABClASIBIAAmASABCxEAIAAlASABJQEgAiUBEAIaCxMAIABBgKvAADYCBCAAIAE2AgALEwAgAEG8q8AANgIEIAAgATYCAAsTACAAQfirwAA2AgQgACABNgIACxAAIAEgACgCACAAKAIEEGALEAAgACgCBCAAKAIIIAEQTAsQACAAKAIAIAAoAgQgARBMCxMAIABBhMXAADYCBCAAIAE2AgALEwAgAEGUxcAANgIEIAAgATYCAAsQACABIAAoAgQgACgCCBBgCxMAIABBsMvAADYCBCAAIAE2AgALEwAgAEHAy8AANgIEIAAgATYCAAsTACAAQfjLwAA2AgQgACABNgIACxMAIABBiMzAADYCBCAAIAE2AgALEwAgAEEoNgIEIABBjtPBADYCAAsTACAAQdy7wQA2AgQgACABNgIACxMAIABBmLzBADYCBCAAIAE2AgALEwAgAEHUvMEANgIEIAAgATYCAAsTACAAQeTZwQA2AgQgACABNgIACxYAQaTowQAgADYCAEGg6MEAQQE6AAALEQEBfxClASIBIAAlASYBIAELDwBB0OPAAEErIAAQ0AIACxIAQcjMwABBI0HczMAAEJ0CAAsPAEGc88AAQTMgABCdAgALDwAgAEGAxsAAIAEgAhBmCw8AIABB7MzAACABIAIQZgsPACAAQdjPwAAgASACEGYLDwAgAEG0zsAAIAEgAhBmCw8AIABBnNDAACABIAIQZgsPACAAQajiwAAgASACEGYLDwAgAEH8tcEAIAEgAhBmCw8AIABBsLjBACABIAIQZgsPACAAQbDVwQAgASACEGYLDAAgACUBIAEgAhAGCwwAIAAgASACJQEQBwsMACAAIAEgAiUBEAsLDQBBnejBAEEBOgAAAAsJACAAQQRqEFgLEQAgAEGswsAA/QACAP0LAgALEQAgAEGAw8AA/QACAP0LAgALEQAgAEG8wsAA/QACAP0LAgALEQAgAEGQw8AA/QACAP0LAgALEQAgAEGYrsAA/QACAP0LAgALEQAgAEHgrsAA/QACAP0LAgALEQAgAEG408EA/QACAP0LAgALEQAgAEHI08EA/QACAP0LAgALEQAgAEGYzMAA/QACAP0LAgALEQAgAEHo08EA/QACAP0LAgALEQAgAEH408EA/QACAP0LAgALEQAgAEGkrMAA/QACAP0LAgALDQBBmNvBAEEbEJkDAAsJACAAIAEQGwALDQAgAUHQm8EAQRgQYAsNACABQaOywQBBAhBgCxEAIABBgL3BAP0AAgD9CwIACxEAIABB2NPBAP0AAgD9CwIACxEAIABBgNbBAP0AAgD9CwIACxEAIABBkNbBAP0AAgD9CwIACwwAIAAgASkCADcDAAsKACAAIAElARARC4UqAh1/AX4CfyMAQeABayICJAAgAkEgaiAAIAAoAgAoAgQRAgAgAiACKAIkIgQ2AiwgAiACKAIgIgY2AigCQAJAAkACQAJAAkACQAJAAkACfwJAAkACQCABIgstAApBgAFxRQRAIAIgAkEoaq1CgICAgOAAhDcDkAFBASEHIAEoAgAgASgCBEH6icAAIAJBkAFqEGYNByACQRhqIAYgBCgCGBECAAJAAkAgAigCGCIFBEAgAigCHCEJIAEoAgBBp87AAEEMIAEoAgQoAgwRAAANCiACQRBqIAUgCSgCGBECACACQdgAaq1CgICAgOAAhCEfIAIoAhBBAEchBkEAIQcDQCACQQhqIAUgCSgCGBECACACKAIM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ZGV4IMAAH05vdCBlbm91Z2ggY2h1bmsgcmVjb3JkczogaGF2ZSDAECwgbmVlZCBhdCBsZWFzdCDAAAlFeHBlY3RlZCDAFyBhY3RpdmUgc3BsYXRzIGJ1dCBnb3QgwAAJRXhwZWN0ZWQgwA0gc3BsYXRzLCBnb3QgwAAJRXhwZWN0ZWQgwBEgU0ggcmVjb3JkcywgZ290IMAAHE1pc3NpbmcgUExZIGNodW5rIGZvciBzcGxhdCDAABZzbGljZSBpbmRleCBzdGFydHMgYXQgwA0gYnV0IGVuZHMgYXQgwAAVYnl0ZSByYW5nZSBzdGFydHMgYXQgwA0gYnV0IGVuZHMgYXQgwAAgaW5kZXggb3V0IG9mIGJvdW5kczogdGhlIGxlbiBpcyDAEiBidXQgdGhlIGluZGV4IGlzIMAAEXN0YXJ0IGJ5dGUgaW5kZXggwCcgaXMgb3V0IG9mIGJvdW5kcyBmb3Igc3RyaW5nIG9mIGxlbmd0aCDAAA9lbmQgYnl0ZSBpbmRleCDAJyBpcyBvdXQgb2YgYm91bmRzIGZvciBzdHJpbmcgb2YgbGVuZ3RoIMAAEnJhbmdlIHN0YXJ0IGluZGV4IMAiIG91dCBvZiByYW5nZSBmb3Igc2xpY2Ugb2YgbGVuZ3RoIMAAEHJhbmdlIGVuZCBpbmRleCDAIiBvdXQgb2YgcmFuZ2UgZm9yIHNsaWNlIG9mIGxlbmd0aCDAAAdzdHJpbmcgwAAOaW52YWxpZCB0eXBlOiDACywgZXhwZWN0ZWQgwAAfSW5jb21wbGV0ZSBTUFogc3RyZWFtOiBzdGFnZSA9IMAOLCBzaF9kZWdyZWUgPSDAABBhc3NlcnRpb24gYGxlZnQgwBcgcmlnaHRgIGZhaWxlZAogIGxlZnQ6IMAJCiByaWdodDogwAAQYXNzZXJ0aW9uIGBsZWZ0IMAQIHJpZ2h0YCBmYWlsZWQ6IMAJCiAgbGVmdDogwAkKIHJpZ2h0OiDAABhVbnN1cHBvcnRlZCBQTFkgZm9ybWF0OiDAACVJbnZhbGlkIG51bWJlciBvZiBmX3Jlc3QgcHJvcGVydGllczogwAAZVW5zdXBwb3J0ZWQgU1BaIHZlcnNpb246IMAAGVVuc3VwcG9ydGVkIFBMWSB2ZXJzaW9uOiDAAB9VbnN1cHBvcnRlZCBQTFkgcHJvcGVydHkgdHlwZTogwAATSW52YWxpZCBmaWxlIHR5cGU6IMAAF0ludmFsaWQgcHJvcGVydHkgbGluZTogwAAdVW5zdXBwb3J0ZWQgUExZIGhlYWRlciBsaW5lOiDAABNJbnZhbGlkIFNIIGRlZ3JlZTogwAAWRGVjb21wcmVzc2lvbiBmYWlsZWQ6IMAAwAI6IMAAc3BhcmstbGliL3NyYy9zcHoucnMAc3BhcmstbGliL3NyYy9wbHkucnMAL3J1c3QvZGVwcy9ydXN0Yy1kZW1hbmdsZS0wLjEuMjcvc3JjL2xlZ2FjeS5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2NvcmUvc3JjL3NsaWNlL2luZGV4LnJzAC9ydXN0L2RlcHMvaGFzaGJyb3duLTAuMTcuMS9zcmMvcmF3LnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvY29yZS9zcmMvbnVtL2ltcC9mbHQyZGVjL3N0cmF0ZWd5L2dyaXN1LnJzAHNwYXJrLXdvcmtlci1ycy9zcmMvc29ydC5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2FsbG9jL3NyYy9mbXQucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9hbnlob3ctMS4wLjk4L3NyYy9mbXQucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9jb3JlL3NyYy9udW0vaW1wL2RpeV9mbG9hdC5ycwBzcGFyay13b3JrZXItcnMvc3JjL2V4dF9zcGxhdHMucnMAc3Bhcmstd29ya2VyLXJzL3NyYy9wYWNrZWRfc3BsYXRzLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9zeXMvc3luYy9tdXRleC9ub190aHJlYWRzLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9zeXMvdGhyZWFkX2xvY2FsL25vX3RocmVhZHMucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjL3N5cy9zeW5jL3J3bG9jay9ub190aHJlYWRzLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9zeXMvc3luYy9vbmNlL25vX3RocmVhZHMucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9hbGxvYy9zcmMvc3RyLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvYW55aG93LTEuMC45OC9zcmMvZXJyb3IucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9taW5pel9veGlkZS0wLjguOS9zcmMvaW5mbGF0ZS9vdXRwdXRfYnVmZmVyLnJzAHNwYXJrLWxpYi9zcmMvZGVjb2Rlci5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2NvcmUvc3JjL3N0ci9wYXR0ZXJuLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvY29yZS9zcmMvb3BzL2Z1bmN0aW9uLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvY29yZS9zcmMvbnVtL2ltcC9mbHQyZGVjL3N0cmF0ZWd5L2RyYWdvbi5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2NvcmUvc3JjL251bS9pbXAvYmlnbnVtLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy90aHJlYWQvbG9jYWwucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjL3N5bmMvbGF6eV9sb2NrLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvYWxsb2Mvc3JjL3N0cmluZy5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L3N0ZC9zcmMvcGFuaWNraW5nLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2Yvd2FzbS1iaW5kZ2VuLTAuMi4xMTcvc3JjL2V4dGVybnJlZi5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL21pbml6X294aWRlLTAuOC45L3NyYy9pbmZsYXRlL2NvcmUucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9jb3JlL3NyYy91bmljb2RlL3ByaW50YWJsZS5ycwBzcGFyay1saWIvc3JjL3NwbGF0X2VuY29kZS5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L3N0ZC9zcmMvc3luYy9vbmNlLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvc3RkL3NyYy9iYWNrdHJhY2UucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9jb3JlL3NyYy9mbXQvbW9kLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvY29yZS9zcmMvYnN0ci9tb2QucnMAL3J1c3RjLzhiYWIyNmY0ZjY4ZTBlMjZmMGJiNzk2MGJlMzM0ZDViNTIwZWE0NTIvbGlicmFyeS9zdGQvc3JjLy4uLy4uL2JhY2t0cmFjZS9zcmMvc3ltYm9saXplL21vZC5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2FsbG9jL3NyYy9yYXdfdmVjL21vZC5ycwAvcnVzdGMvOGJhYjI2ZjRmNjhlMGUyNmYwYmI3OTYwYmUzMzRkNWI1MjBlYTQ1Mi9saWJyYXJ5L2NvcmUvc3JjL251bS9pbXAvZmx0MmRlYy9tb2QucnMAL3J1c3QvZGVwcy9kbG1hbGxvYy0wLjIuMTMvc3JjL2RsbWFsbG9jLnJzAHNwYXJrLXdvcmtlci1ycy9zcmMvbGliLnJzAC9ydXN0L2RlcHMvcnVzdGMtZGVtYW5nbGUtMC4xLjI3L3NyYy9saWIucnMAL1VzZXJzL3dpbGxpYW0vLmNhcmdvL3JlZ2lzdHJ5L3NyYy9pbmRleC5jcmF0ZXMuaW8tMTk0OWNmOGM2YjViNTU3Zi9jb25zb2xlX2Vycm9yX3BhbmljX2hvb2stMC4xLjcvc3JjL2xpYi5ycwAvVXNlcnMvd2lsbGlhbS8uY2FyZ28vcmVnaXN0cnkvc3JjL2luZGV4LmNyYXRlcy5pby0xOTQ5Y2Y4YzZiNWI1NTdmL3NlcmRlLXdhc20tYmluZGdlbi0wLjYuNS9zcmMvbGliLnJzAC9Vc2Vycy93aWxsaWFtLy5jYXJnby9yZWdpc3RyeS9zcmMvaW5kZXguY3JhdGVzLmlvLTE5NDljZjhjNmI1YjU1N2YvanMtc3lzLTAuMy45NC9zcmMvbGliLnJzAC9ydXN0Yy84YmFiMjZmNGY2OGUwZTI2ZjBiYjc5NjBiZTMzNGQ1YjUyMGVhNDUyL2xpYnJhcnkvY29yZS9zcmMvdW5pY29kZS91bmljb2RlX2RhdGEucnMAL3J1c3QvZGVwcy9ydXN0Yy1kZW1hbmdsZS0wLjEuMjcvc3JjL3YwLnJz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KACoAGgA6AAYAJgAWADYADgAuAB4APgABACEAEQAxAAkAKQAZADkABQAlABUANQANAC0AHQA9AAMAIwATADMACwArABsAOwAHACcAFwA3AA8ALwAfAD8AAIAggBCAMIAIgCiAGIA4gASAJIAUgDSADIAsgByAPIACgCKAEoAygAqAKoAagDqABoAmgBaANoAOgC6AHoA+gAGAIYARgDGACYApgBmAOYAFgCWAFYA1gA2ALYAdgD2AA4AjgBOAM4ALgCuAG4A7gAeAJ4AXgDeAD4AvgB+AP4AAQCBAEEAwQAhAKEAYQDhABEAkQBRANEAMQCxAHEA8QAJAIkASQDJACkAqQBpAOkAGQCZAFkA2QA5ALkAeQD5AAUAhQBFAMUAJQClAGUA5QAVAJUAVQDVADUAtQB1APUADQCNAE0AzQAtAK0AbQDtAB0AnQBdAN0APQC9AH0A/QADAIMAQwDDACMAowBjAOMAEwCTAFMA0wAzALMAcwDzAAsAiwBLAMsAKwCrAGsA6wAbAJsAWwDbADsAuwB7APsABwCHAEcAxwAnAKcAZwDnABcAlwBXANcANwC3AHcA9wAPAI8ATwDPAC8ArwBvAO8AHwCfAF8A3wA/AL8AfwD/gACAgIBAgMCAIICggGCA4IAQgJCAUIDQgDCAsIBwgPCACICIgEiAyIAogKiAaIDogBiAmIBYgNiAOIC4gHiA+IAEgISARIDEgCSApIBkgOSAFICUgFSA1IA0gLSAdID0gAyAjIBMgMyALICsgGyA7IAcgJyAXIDcgDyAvIB8gPyAAoCCgEKAwoAigKKAYoDigBKAkoBSgNKAMoCygHKA8oAKgIqASoDKgCqAqoBqgOqAGoCagFqA2oA6gLqAeoD6gAaAhoBGgMaAJoCmgGaA5oAWgJaAVoDWgDaAtoB2gPaADoCOgE6AzoAugK6AboDugB6AnoBegN6APoC+gH6A/oABgIGAQYDBgCGAoYBhgOGAEYCRgFGA0YAxgLGAcYDxgAmAiYBJgMmAKYCpgGmA6YAZgJmAWYDZgDmAuYB5gPmABYCFgEWAxYAlgKWAZYDlgBWAlYBVgNWANYC1gHWA9YANgI2ATYDNgC2ArYBtgO2AHYCdgF2A3YA9gL2AfYD9gAOAg4BDgMOAI4CjgGOA44ATgJOAU4DTgDOAs4BzgPOAC4CLgEuAy4ArgKuAa4DrgBuAm4BbgNuAO4C7gHuA+4AHgIeAR4DHgCeAp4BngOeAF4CXgFeA14A3gLeAd4D3gA+Aj4BPgM+AL4CvgG+A74AfgJ+AX4DfgD+Av4B/gP97aW52YWxpZCBzeW50YXh9e3JlY3Vyc2lvbiBsaW1pdCByZWFjaGVkfT8AQbStwQAL9QIBAAAApwAAAGBmbXQ6OkVycm9yYHMgc2hvdWxkIGJlIGltcG9zc2libGUgd2l0aG91dCBhIGBmbXQ6OkZvcm1hdHRlcmAAAABSEhAAKgAAAIcCAAARAAAAZm9yPD4gLCBSEhAAKgAAAI8AAAAYAAAAOAoQAE8AAADnBQAAFAAAADgKEABPAAAA5wUAACEAAAA4ChAATwAAANsFAAAhAAAAMDEyMzQ1Njc4OWFiY2RlZlISEAAqAAAAigAAAA0AAABSEhAAKgAAAFwBAAAaAAAAaW50ZXJuYWwgZXJyb3I6IGVudGVyZWQgdW5yZWFjaGFibGUgY29kZVISEAAqAAAAMQEAABYAAABSEhAAKgAAADQBAABHAAAAQ3Vuc2FmZSBleHRlcm4gIlISEAAqAAAA1AMAAC0AAAAiIC1mbigpIC0+ICArIDogcHVueWNvZGV7fS5sbHZtLpoQEAArAAAAYgAAABsAAACaEBAAKwAAAGkAAAATAEG0sMEAC9cJAQAAAKgAAABjYWxsZWQgYFJlc3VsdDo6dW53cmFwKClgIG9uIGFuIGBFcnJgIHZhbHVlMFISEAAqAAAAHgEAADEAAABSEhAAKgAAAL8BAAAfAAAAUhIQACoAAAAeAgAAHgAAAFISEAAqAAAAIwIAACIAAABSEhAAKgAAACQCAAAlAAAAW106Ojo6e2Nsb3N1cmVzaGltOiM8IGFzID4mIG11dCAqY29uc3QgOyAoLGR5biAgaXMgX2ZhbHNldHJ1ZXsgeyAgfSA9IDB4UhIQACoAAADxBAAALQAAACcuLj0gfCAhbnVsbGJvb2xzdHIoKWk4aTE2aTMyaTY0aTEyOGlzaXpldTh1MTZ1MzJ1NjR1MTI4dXNpemVmNjQhLi4uUhIQACoAAAAyAAAAEwAAAFISEAAqAAAALwAAABMAAABSEhAAKgAAACsAAAATAAAAUhIQACoAAABaAAAAKAAAAFISEAAqAAAASwAAAA4AAAAmBRAALgAAAGYAAAAcAAAAJgUQAC4AAAA9AAAACwAAACYFEAAuAAAAOgAAAAsAAAAmBRAALgAAADYAAAALAAAAJgUQAC4AAABvAAAAJwAAACYFEAAuAAAAcAAAAB0AAAAmBRAALgAAAHIAAAAhAAAAJgUQAC4AAABzAAAAGgAAACYFEAAuAAAAdAAAABkAAAAmBRAALgAAAH4AAAAdAAAAJgUQAC4AAAC0AAAAJgAAACYFEAAuAAAAtQAAACEAAAAmBRAALgAAAIoAAABJAAAAJgUQAC4AAACLAAAAHwAAACYFEAAuAAAAiwAAAC8AAAAmBRAALgAAAJ0AAAA1AAAAQAAAACYFEAAuAAAAggAAACwAAAAmBRAALgAAAIQAAAAlAAAALgAAACYFEAAuAAAAhwAAACUAAAAAAAAAAQAAAAEAAACpAAAAJgUQAC4AAAByAAAASAAAAAAAAAAMAAAABAAAAKoAAACrAAAArAAAAHtzaXplIGxpbWl0IHJlYWNoZWR9AAAAAAAAAAABAAAArQAAAGBmbXQ6OkVycm9yYCBmcm9tIGBTaXplTGltaXRlZEZtdEFkYXB0ZXJgIHdhcyBkaXNjYXJkZWQAmhAQACsAAABTAQAAHgAAAFNpemVMaW1pdEV4aGF1c3RlZEVycm9yADgKEABPAAAAawQAACQAAACIChAAUAAAAKYAAAAFAAAAYnl0ZSBhcnJheXVuaXQgdmFsdWVPcHRpb24gdmFsdWVuZXd0eXBlIHN0cnVjdHNlcXVlbmNlbWFwZW51bXVuaXQgdmFyaWFudG5ld3R5cGUgdmFyaWFudHR1cGxlIHZhcmlhbnRzdHJ1Y3QgdmFyaWFudGYzMgAAAAAAAAgAAAAEAAAArgAAAK8AAACwAAAALjAAADQREABnAAAANQAAAA4AAACxAAAAsgAAALMAAAC0AAAAtQAAALYAAABIAAAAtwAAALgAAAC5AAAAugAAAE0AAABOAAAASAAAAEIAAAC7AAAAvAAAAL0AAABSAAAARwAAAEgAAABBdHRlbXB0ZWQgdG8gaW5pdGlhbGl6ZSB0aHJlYWQtbG9jYWwgd2hpbGUgaXQgaXMgYmVpbmcgZHJvcHBlZAAA6wcQAF4AAABrAAAADQAAAP//////////AF0QAEGYusEAC/MUvgAAAAwAAAAEAAAAVgAAAL4AAAAMAAAABAAAAFcAAABWAAAAGF0QAFgAAABZAAAAWgAAAFgAAABbAAAAAAAAAAgAAAAEAAAAXAAAAAAAAAAIAAAABAAAADwAAABcAAAAVF0QAFgAAABdAAAAWgAAAFgAAABbAAAAAAAAAAEAAAABAAAAvwAAAAAAAAABAAAAAQAAAMAAAAC/AAAAkF0QAMEAAADCAAAAwwAAAMEAAADEAAAAxQAAACgAAAAEAAAAYgAAAMUAAAAoAAAABAAAAGMAAABiAAAAzF0QAGQAAABlAAAAZgAAAGcAAABoAAAAaQAAACQAAAAEAAAAYgAAAGkAAAAkAAAABAAAAGMAAABiAAAACF4QAGQAAABqAAAAZgAAAGcAAABoAAAAxgAAACAAAAAEAAAAYgAAAMYAAAAgAAAABAAAAGMAAABiAAAARF4QAGQAAADHAAAAZgAAAGcAAABoAAAAC433dVDmd9zZz2APge/O3hEFEAAUAAAA1wQAACgAAAARBRAAFAAAAOkEAAAoAAAAEQUQABQAAADgBAAAKAAAABEFEAAUAAAAIwQAABwAAAARBRAAFAAAACQEAAAcAAAAEQUQABQAAAAlBAAAHAAAABEFEAAUAAAAJgQAABsAAAARBRAAFAAAACcEAAAbAAAAEQUQABQAAAAoBAAAGwAAABEFEAAUAAAAKQQAABkAAAARBRAAFAAAACoEAAAZAAAAEQUQABQAAAArBAAAGQAAABEFEAAUAAAALAQAAB0AAAARBRAAFAAAAC0EAAAaAAAAEQUQABQAAAAuBAAAGgAAABEFEAAUAAAALwQAABoAAAARBRAAFAAAADAEAAAaAAAATWlzc2luZyBjaHVuayBlbGVtZW50IGZvciBTdXBlclNwbGF0IFBMWW1pbl94TWlzc2luZyBtaW5feCBwcm9wZXJ0eW1pbl95TWlzc2luZyBtaW5feSBwcm9wZXJ0eW1pbl96TWlzc2luZyBtaW5feiBwcm9wZXJ0eW1heF94TWlzc2luZyBtYXhfeCBwcm9wZXJ0eW1heF95TWlzc2luZyBtYXhfeSBwcm9wZXJ0eW1heF96TWlzc2luZyBtYXhfeiBwcm9wZXJ0eW1pbl9zY2FsZV94TWlzc2luZyBtaW5fc2NhbGVfeCBwcm9wZXJ0eW1pbl9zY2FsZV95TWlzc2luZyBtaW5fc2NhbGVfeSBwcm9wZXJ0eW1pbl9zY2FsZV96TWlzc2luZyBtaW5fc2NhbGVfeiBwcm9wZXJ0eW1heF9zY2FsZV94TWlzc2luZyBtYXhfc2NhbGVfeCBwcm9wZXJ0eW1heF9zY2FsZV95TWlzc2luZyBtYXhfc2NhbGVfeSBwcm9wZXJ0eW1heF9zY2FsZV96TWlzc2luZyBtYXhfc2NhbGVfeiBwcm9wZXJ0eW1pbl9ybWluX2dtaW5fYm1heF9ybWF4X2dtYXhfYnBhY2tlZF9wb3NpdGlvbk1pc3NpbmcgcGFja2VkX3Bvc2l0aW9uIHByb3BlcnR5cGFja2VkX3JvdGF0aW9uTWlzc2luZyBwYWNrZWRfcm90YXRpb24gcHJvcGVydHlwYWNrZWRfc2NhbGVNaXNzaW5nIHBhY2tlZF9zY2FsZSBwcm9wZXJ0eXBhY2tlZF9jb2xvck1pc3NpbmcgcGFja2VkX2NvbG9yIHByb3BlcnR5AAARBRAAFAAAADcDAAAfAAAAEQUQABQAAABMBAAAHwAAABEFEAAUAAAAUgQAAD0AAAARBRAAFAAAAFIEAAAhAAAAEQUQABQAAABYBAAAPQAAABEFEAAUAAAAWAQAACEAAAARBRAAFAAAAF4EAAA9AAAAEQUQABQAAABeBAAAIQAAAHBseXNwenhNaXNzaW5nIHggcHJvcGVydHl5TWlzc2luZyB5IHByb3BlcnR5ek1pc3NpbmcgeiBwcm9wZXJ0eXNjYWxlXzBNaXNzaW5nIHNjYWxlXzAgcHJvcGVydHlzY2FsZV8xTWlzc2luZyBzY2FsZV8xIHByb3BlcnR5c2NhbGVfMk1pc3Npbmcgc2NhbGVfMiBwcm9wZXJ0eXJvdF8xTWlzc2luZyByb3RfMCBwcm9wZXJ0eXJvdF8yTWlzc2luZyByb3RfMSBwcm9wZXJ0eXJvdF8zTWlzc2luZyByb3RfMiBwcm9wZXJ0eXJvdF8wTWlzc2luZyByb3RfMyBwcm9wZXJ0eW9wYWNpdHlNaXNzaW5nIG9wYWNpdHkgcHJvcGVydHlmX2RjXzBNaXNzaW5nIGZfZGNfMCBwcm9wZXJ0eWZfZGNfMU1pc3NpbmcgZl9kY18xIHByb3BlcnR5Zl9kY18yTWlzc2luZyBmX2RjXzIgcHJvcGVydHlyZWRNaXNzaW5nIHJlZCBwcm9wZXJ0eWdyZWVuTWlzc2luZyBncmVlbiBwcm9wZXJ0eWJsdWVNaXNzaW5nIGJsdWUgcHJvcGVydHlhbHBoYQAAEQUQABQAAACyBQAAJgAAABEFEAAUAAAAswUAACcAAAARBRAAFAAAALUFAAAqAAAAEQUQABQAAAC5BQAAKgAAABEFEAAUAAAAvQUAACoAAAARBRAAFAAAAMEFAAAqAAAAEQUQABQAAACrBQAAKgAAABEFEAAUAAAArwUAACoAAAARBRAAFAAAAJMFAAAmAAAAEQUQABQAAACUBQAAJwAAABEFEAAUAAAAlgUAACoAAAARBRAAFAAAAJoFAAAqAAAAEQUQABQAAACeBQAAKgAAABEFEAAUAAAAogUAACoAAAARBRAAFAAAAIwFAAApAAAAEQUQABQAAACQBQAAKQAAABEFEAAUAAAA2wUAACYAAAARBRAAFAAAANoFAAAnAAAAEQUQABQAAADXBQAAKgAAABEFEAAUAAAA0wUAACoAAAARBRAAFAAAAMoFAAAqAAAAEQUQABQAAADdBQAAKgAAAPUNEAAdAAAAWgEAAC8AAAD1DRAAHQAAAHYBAAAJAAAA9Q0QAB0AAAB3AQAACQAAAPUNEAAdAAAAeAEAAAkAAAD1DRAAHQAAAHkBAAAJAAAA9Q0QAB0AAAB1AQAALwAAAPUNEAAdAAAAlgEAAAkAAAD1DRAAHQAAAJcBAAAJAAAA9Q0QAB0AAACYAQAACQAAAPUNEAAdAAAAmQEAAAkAAAD1DRAAHQAAAJUBAAAvAAAA9Q0QAB0AAACoAQAADQAAAEludmFsaWQgUExZIGhlYWRlcgAAEQUQABQAAAAcAgAAFQAAAE1pc3NpbmcgUExZIGZvcm1hdCBsaW5lTWlzc2luZyB2ZXJ0ZXggZWxlbWVudAAAAKpiEAABAAAAvWIQAAEAAADQYhAAAQAAACJkEAADAAAAOWQQAAUAAABUZBAABAAAAFBMWSBsaXN0IHByb3BlcnRpZXMgYXJlIG5vdCBzdXBwb3J0ZWRQcm9wZXJ0eSBvdXRzaWRlIG9mIGVsZW1lbnRjaGFySW52YWxpZCBnemlwIGhlYWRlcgBVBRAATwAAAPwDAAAzAAAAAgICAgICAgICAgIAQajPwQALCAICAAAAAAACAEHfz8EACwECAEGF0MEACwEBAEGg0MEACwEBAEGA0cEAC4ENaW50ZXJuYWwgZXJyb3I6IGVudGVyZWQgdW5yZWFjaGFibGUgY29kZTogaW52YWxpZCBPbmNlIHN0YXRlqAgQAFsAAAA6AAAAEgAAAHN0cnVjdCBTcGxhdEVuY29kaW5nRmFpbGVkQ2Fubm90TWFrZVByb2dyZXNzQmFkUGFyYW1BZGxlcjMyTWlzbWF0Y2hGYWlsZWREb25lTmVlZHNNb3JlSW5wdXRIYXNNb3JlT3V0cHV0OAoQAE8AAADPAQAANwAAAFBhcnNlSW50RXJyb3JraW5kRW1wdHlJbnZhbGlkRGlnaXRQb3NPdmVyZmxvd05lZ092ZXJmbG93WmVyb05vdEFQb3dlck9mVHdvZGVzY3JpcHRpb24oKSBpcyBkZXByZWNhdGVkOyB1c2UgRGlzcGxheQAA43LKNrWqR/cHixQpGEZnSA7dMYlWe3kqE4gf6Zc1kCH2mUsCe65qULiM+P93b/mHKC+FVOjdFqTDX/qFMT2C72QMWggFLt0rqNERqvljrZgTDhAATAAAAOIAAAAUAAAAb25lLXRpbWUgaW5pdGlhbGl6YXRpb24gbWF5IG5vdCBiZSBwZXJmb3JtZWQgcmVjdXJzaXZlbHkAAAAABAAAAAQAAADIAAAAEw4QAEwAAADiAAAAMQAAAG9wZXJhdGlvbiBub3Qgc3VwcG9ydGVkIG9uIHRoaXMgcGxhdGZvcm1wahAAKAAAACQAAAAAAAAAAgAAAJhqEACUAAAADAAAAAQAAADJAAAAygAAAMsAAAAAAAAACAAAAAQAAADMAAAAzQAAAM4AAADPAAAA0AAAABAAAAAEAAAA0QAAANIAAADTAAAA1AAAAFz26V/cAva58cFwbPJhwSTaB4xJeGVM08J9j02WnybPYXNzZXJ0aW9uIGZhaWxlZDogcHNpemUgPj0gc2l6ZSArIG1pbl9vdmVyaGVhZAAAVBAQACoAAACxBAAACQAAAGFzc2VydGlvbiBmYWlsZWQ6IHBzaXplIDw9IHNpemUgKyBtYXhfb3ZlcmhlYWQAAFQQEAAqAAAAtwQAAA0AAAByd2xvY2sgb3ZlcmZsb3dlZCByZWFkIGxvY2tzSggQAF0AAAAVAAAALAAAAGNhbm5vdCByZWN1cnNpdmVseSBhY3F1aXJlIG11dGV4jgcQAFwAAAATAAAACQAAAAEAAAAAAAAA0yAAAGgBAAAgICAgICAgICAgICAgYXQgCsMgAABoBAACOiAA0yAAAGgBAAMgLSAAICAgICAgPHVua25vd24+wSAAgGAAY2Fubm90IG1vZGlmeSB0aGUgcGFuaWMgaG9vayBmcm9tIGEgcGFuaWNraW5nIHRocmVhZAAAAH4MEABMAAAAkAAAAAkAAADvv70ARg8QAGQAAABnAQAAMAAAAExhenlMb2NrIGluc3RhbmNlIGhhcyBwcmV2aW91c2x5IGJlZW4gcG9pc29uZWQAAOALEABRAAAAnwEAAAUAAAAAAAAACAAAAAQAAADVAAAAdW5zdXBwb3J0ZWQgYmFja3RyYWNlZGlzYWJsZWQgYmFja3RyYWNlAGAOEABMAAAAigEAAB0AAADWAAAAEAAAAAQAAADXAAAA2AAAAHBhbmlja2VkIGF0IDoKAACUAAAADAAAAAQAAADZAAAAcndsb2NrIGhhcyBub3QgYmVlbiBsb2NrZWQgZm9yIHJlYWRpbmcAAEoIEABdAAAAPgAAAAkAAABudWxsIHBvaW50ZXIgcGFzc2VkIHRvIHJ1c3RyZWN1cnNpdmUgdXNlIG9mIGFuIG9iamVjdCBkZXRlY3RlZCB3aGljaCB3b3VsZCBsZWFkIHRvIHVuc2FmZSBhbGlhc2luZyBpbiBydXN0AADLDBAAaQAAAHwAAAARAAAAywwQAGkAAACJAAAAEQAAABgAAAAIAAAADwAAAAYAAAAEAAAADgAAAA0AAADgaBAA+GgQAABpEAAPaRAAFWkQABlpEAAnaRAABwAAAAYAAAADAAAABgAAAAUAAAACAAAABAAAADAiEAA3IhAAPSIQAEAiEABGIhAASyIQABVpEAAmAAAAHQAAACYAAAAmAAAAJgAAABwAAADMTBAA8kwQAA9NEAA1TRAAW00QAIFNEAACAAAABAAAAAQAAAADAAAAAwAAAAMAAAAAAAAAAgAAAAUAAAAFAAAAAAAAAAMAAAADAAAABAAAAAQAAAABAEGM3sEAC18DAAAAAwAAAAIAAAADAAAAAAAAAAMAAAADAAAAAQAAACVZEAAcWRAAWGcQAE1ZEAAgWRAAK1wQAAAAAAA5WRAANFkQAEhZEAAAAAAAKlkQAD5ZEAAwWRAARFkQAOtYEABB9N7BAAu8BCdZEAA7WRAAI1kQAFFZEAAAAAAALVkQAEFZEABQWRAABQAAAAwAAAALAAAACwAAAAQAAAAOAAAAVWkQAFppEABmaRAAcWkQAHxpEACAaRAAAwAAAAgAAAAPAAAAAwAAAAgAAAAPAAAAAwAAAAgAAAAPAAAABQAAAAwAAAALAAAACwAAAAQAAAAOAAAAVWkQAFppEABmaRAAcWkQAHxpEACAaRAAGAAAAAgAAAAPAAAABgAAAAQAAAAOAAAADQAAAOBoEAD4aBAAAGkQAA9pEAAVaRAAGWkQACdpEAAAAAA/AAAAvwMAAAAEAAAABAAAAAYAAACD+aIARE5uAPwpFQDRVycA3TT1AGLbwAA8mZUAQZBDAGNR/gC73qsAt2HFADpuJADSTUIASQbgAAnqLgAcktEA6x3+ACmxHADoPqcA9TWCAES7LgCc6YQAtCZwAEF+XwDWkTkAU4M5AJz0OQCLX4QAKPm9APgfOwDe/5cAD5gFABEv7wAKWosAbR9tAM9+NgAJyycARk+3AJ5mPwAt6l8Auid1AOXrxwA9e/EA9zkHAJJSigD7a+oAH7FfAAhdjQAwA1YAe/xGAPCrawAgvM8ANvSaAOOpHQBeYZEACBvmAIWZZQCgFF8AjUBoAIDY/wAnc00ABgYxAMpWFQDJqHMAe+JgAGuMwAAAAABA+yH5PwAAAAAtRHQ+AAAAgJhG+DwAAABgUcx4OwAAAICDG/A5AAAAQCAlejgAAACAIoLjNgAAAAAd82k1AEGw48EACwEEAHAJcHJvZHVjZXJzAghsYW5ndWFnZQEEUnVzdAAMcHJvY2Vzc2VkLWJ5AwVydXN0Yx0xLjk3LjEgKDhiYWIyNmY0ZiAyMDI2LTA3LTE0KQZ3YWxydXMGMC4yNi40DHdhc20tYmluZGdlbgcwLjIuMTE3AHQPdGFyZ2V0X2ZlYXR1cmVzBysPbXV0YWJsZS1nbG9iYWxzKxNub250cmFwcGluZy1mcHRvaW50KwdzaW1kMTI4KwtidWxrLW1lbW9yeSsIc2lnbi1leHQrD3JlZmVyZW5jZS10eXBlcysKbXVsdGl2YWx1ZQ==", self.location.href);\n    }\n    const imports = __wbg_get_imports();\n    if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {\n      module_or_path = fetch(module_or_path);\n    }\n    const { instance } = await __wbg_load(await module_or_path, imports);\n    return __wbg_finalize_init(instance);\n  }\n  const rpcHandlers = {\n    sortSplats32,\n    loadPackedSplats,\n    loadExtSplats,\n    nextChunk\n  };\n  async function onMessage(event) {\n    const {\n      id,\n      name,\n      args\n    } = event.data;\n    try {\n      const handler = rpcHandlers[name];\n      if (!handler) {\n        throw new Error(`Unknown worker RPC: ${name}`);\n      }\n      const sendStatus = (data) => {\n        self.postMessage(\n          { id, status: data },\n          { transfer: getTransferable(data) }\n        );\n      };\n      const result = await handler(args, { sendStatus });\n      self.postMessage({ id, result }, { transfer: getTransferable(result) });\n    } catch (error) {\n      console.warn(`Worker error: ${error}`);\n      self.postMessage({ id, error }, { transfer: getTransferable(error) });\n    }\n  }\n  function sortSplats32({\n    numSplats,\n    readback,\n    ordering\n  }) {\n    const activeSplats = sort32_splats(numSplats, readback, ordering);\n    return { activeSplats, readback, ordering };\n  }\n  async function decodeBytesUrl({\n    decoder,\n    fileBytes,\n    url,\n    requestHeader,\n    withCredentials,\n    chunked,\n    chunkedLength,\n    sendStatus\n  }) {\n    if (fileBytes) {\n      const chunkSize = 1048576;\n      for (let i = 0; i < fileBytes.length; i += chunkSize) {\n        decoder.push(\n          fileBytes.subarray(i, Math.min(i + chunkSize, fileBytes.length))\n        );\n      }\n    } else if (url) {\n      const request = new Request(url, {\n        headers: requestHeader ? new Headers(requestHeader) : void 0,\n        credentials: withCredentials ? "include" : "same-origin"\n      });\n      const response = await fetch(request);\n      if (!response.ok || !response.body) {\n        throw new Error(\n          `Failed to fetch "${url}": ${response.status} ${response.statusText}`\n        );\n      }\n      const readStream = response.body.getReader();\n      const contentLength = Number.parseInt(\n        response.headers.get("Content-Length") || "0"\n      );\n      const total = Number.isNaN(contentLength) ? 0 : contentLength;\n      let loaded = 0;\n      while (true) {\n        const { done, value } = await readStream.read();\n        if (done) {\n          readStream.releaseLock();\n          break;\n        }\n        loaded += value.length;\n        sendStatus({ loaded, total });\n        decoder.push(value);\n      }\n    } else if (chunked) {\n      let loaded = 0;\n      const total = chunkedLength ?? 0;\n      while (true) {\n        const readNextChunk = new Promise((resolve) => {\n          nextChunkWaiter = resolve;\n        });\n        sendStatus({ nextChunk: true });\n        const chunk = await readNextChunk;\n        if (chunk.length === 0) {\n          break;\n        }\n        decoder.push(chunk);\n        loaded += chunk.length;\n        sendStatus({ loaded, total });\n      }\n      if (total === 0) {\n        sendStatus({ loaded, total: loaded });\n      }\n    } else {\n      throw new Error("No url or fileBytes provided");\n    }\n    return decoder.finish();\n  }\n  function toPackedResult(packed) {\n    return {\n      numSplats: packed.numSplats,\n      packedArray: packed.packed,\n      extra: {\n        sh1: packed.sh1,\n        sh2: packed.sh2,\n        sh3: packed.sh3\n      },\n      splatEncoding: packed.splatEncoding\n    };\n  }\n  async function loadPackedSplats({\n    url,\n    requestHeader,\n    withCredentials,\n    fileBytes,\n    fileType,\n    pathName,\n    chunked,\n    chunkedLength,\n    encoding\n  }, { sendStatus }) {\n    const decoder = decode_to_packedsplats(fileType, pathName ?? url, encoding);\n    const decoded = await decodeBytesUrl({\n      decoder,\n      fileBytes,\n      url,\n      requestHeader,\n      withCredentials,\n      chunked,\n      chunkedLength,\n      sendStatus\n    });\n    return toPackedResult(decoded);\n  }\n  function toExtResult(packed) {\n    return {\n      numSplats: packed.numSplats,\n      extArrays: [packed.ext0, packed.ext1],\n      extra: {\n        sh1: packed.sh1,\n        sh2: packed.sh2,\n        sh3a: packed.sh3a,\n        sh3b: packed.sh3b\n      }\n    };\n  }\n  async function loadExtSplats({\n    url,\n    requestHeader,\n    withCredentials,\n    fileBytes,\n    fileType,\n    pathName,\n    chunked,\n    chunkedLength\n  }, { sendStatus }) {\n    const decoder = decode_to_extsplats(fileType, pathName ?? url);\n    const decoded = await decodeBytesUrl({\n      decoder,\n      fileBytes,\n      url,\n      requestHeader,\n      withCredentials,\n      chunked,\n      chunkedLength,\n      sendStatus\n    });\n    return toExtResult(decoded);\n  }\n  let nextChunkWaiter = (_chunk) => {\n  };\n  async function nextChunk({ chunk }) {\n    nextChunkWaiter(chunk);\n  }\n  function getTransferable(ctx) {\n    const buffers = [];\n    const seen = /* @__PURE__ */ new Set();\n    function traverse(obj) {\n      if (obj && typeof obj === "object" && !seen.has(obj)) {\n        seen.add(obj);\n        if (obj instanceof ArrayBuffer) {\n          buffers.push(obj);\n        } else if (ArrayBuffer.isView(obj)) {\n          buffers.push(obj.buffer);\n        } else if (Array.isArray(obj)) {\n          obj.forEach(traverse);\n        } else {\n          Object.values(obj).forEach(traverse);\n        }\n      }\n    }\n    traverse(ctx);\n    return buffers;\n  }\n  async function initialize() {\n    const pending = [];\n    const bufferMessage = (event) => {\n      pending.push(event);\n    };\n    self.addEventListener("message", bufferMessage);\n    await __wbg_init();\n    self.removeEventListener("message", bufferMessage);\n    self.addEventListener("message", onMessage);\n    for (const event of pending) {\n      onMessage(event);\n    }\n    pending.length = 0;\n  }\n  initialize().catch(console.error);\n})();\n//# sourceMappingURL=worker-BS1CJNuH.js.map\n';
const blob = typeof self !== "undefined" && self.Blob && new Blob([jsContent], { type: "text/javascript;charset=utf-8" });
function WorkerWrapper(options) {
  let objURL;
  try {
    objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);
    if (!objURL) throw "";
    const worker = new Worker(objURL, {
      name: options == null ? void 0 : options.name
    });
    worker.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(objURL);
    });
    return worker;
  } catch (e) {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent),
      {
        name: options == null ? void 0 : options.name
      }
    );
  } finally {
    objURL && (self.URL || self.webkitURL).revokeObjectURL(objURL);
  }
}
const _SplatWorker = class _SplatWorker {
  constructor() {
    this.messages = {};
    this.worker = new WorkerWrapper();
    this.worker.onmessage = (event) => this.onMessage(event);
  }
  onMessage(event) {
    var _a;
    const { id, result, error, status } = event.data;
    const promise = this.messages[id];
    if (promise) {
      if (error !== void 0) {
        delete this.messages[id];
        promise.reject(error);
      } else if (status !== void 0) {
        (_a = promise.onStatus) == null ? void 0 : _a.call(promise, status);
      } else {
        delete this.messages[id];
        promise.resolve(result);
      }
    }
  }
  async call(name, args, options = {}) {
    const id = ++_SplatWorker.currentId;
    const promise = new Promise((resolve, reject) => {
      this.messages[id] = { resolve, reject, onStatus: options.onStatus };
    });
    this.worker.postMessage(
      { id, name, args },
      { transfer: getTransferable(args) }
    );
    return await promise;
  }
  dispose() {
    this.worker.terminate();
    const messages = Object.values(this.messages);
    this.messages = {};
    for (const message of messages) {
      message.reject(new Error("Worker terminate"));
    }
  }
};
_SplatWorker.currentId = 0;
let SplatWorker = _SplatWorker;
class SplatWorkerPool {
  constructor(maxWorkers = 4) {
    this.numWorkers = 0;
    this.freelist = [];
    this.queue = [];
    this.maxWorkers = maxWorkers;
  }
  async withWorker(callback) {
    const worker = await this.allocWorker();
    try {
      return await callback(worker);
    } finally {
      this.freeWorker(worker);
    }
  }
  async allocWorker() {
    const worker = this.freelist.pop();
    if (worker) {
      return worker;
    }
    if (this.numWorkers < this.maxWorkers) {
      const worker2 = new SplatWorker();
      this.numWorkers += 1;
      return worker2;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  freeWorker(worker) {
    if (this.numWorkers > this.maxWorkers) {
      this.numWorkers -= 1;
      return;
    }
    const waiter = this.queue.shift();
    if (waiter) {
      waiter(worker);
      return;
    }
    this.freelist.push(worker);
  }
}
const workerPool = new SplatWorkerPool();
class SplatLoader extends THREE.Loader {
  load(url, onLoad, onProgress, onError) {
    return this.loadInternal({ url, onLoad, onProgress, onError });
  }
  async loadAsync(url, onProgress) {
    return new Promise((resolve, reject) => {
      this.load(url, resolve, onProgress, reject);
    });
  }
  parse(packedSplats) {
    return new SplatMesh({ packedSplats });
  }
  loadInternal({
    packedSplats,
    extSplats,
    url,
    fileBytes,
    fileType,
    fileName,
    stream,
    streamLength,
    onLoad,
    onProgress,
    onError
  }) {
    if (fileBytes instanceof ArrayBuffer) {
      fileBytes = new Uint8Array(fileBytes);
    }
    const resolvedURL = fileBytes ? void 0 : this.manager.resolveURL((this.path ?? "") + (url ?? ""));
    let readStream = stream == null ? void 0 : stream.getReader();
    this.manager.itemStart(resolvedURL ?? "");
    workerPool.withWorker(async (worker) => {
      const onStatus = async (data) => {
        const { loaded, total } = data;
        if (loaded !== void 0 && onProgress) {
          onProgress(
            new ProgressEvent("progress", {
              lengthComputable: total !== 0,
              loaded,
              total: total ?? 0
            })
          );
        }
        if (data.nextChunk) {
          let chunk;
          if (!readStream) {
            chunk = new Uint8Array(0);
          } else {
            const { done, value } = await readStream.read();
            if (done) {
              readStream.releaseLock();
              readStream = void 0;
              chunk = new Uint8Array(0);
            } else {
              chunk = value;
            }
          }
          worker.call("nextChunk", { chunk });
        }
      };
      const basedUrl = resolvedURL ? new URL(resolvedURL, window.location.href).toString() : void 0;
      const decoded = await worker.call(
        extSplats ? "loadExtSplats" : "loadPackedSplats",
        {
          url: basedUrl,
          requestHeader: this.requestHeader,
          withCredentials: this.withCredentials,
          fileBytes: fileBytes == null ? void 0 : fileBytes.slice(),
          fileType,
          pathName: resolvedURL || fileName,
          chunked: stream !== void 0,
          chunkedLength: streamLength,
          encoding: packedSplats == null ? void 0 : packedSplats.splatEncoding
        },
        { onStatus }
      );
      if (extSplats) {
        extSplats.initialize(decoded);
        onLoad == null ? void 0 : onLoad(extSplats);
      } else if (packedSplats) {
        packedSplats.initialize(decoded);
        onLoad == null ? void 0 : onLoad(packedSplats);
      } else {
        onLoad == null ? void 0 : onLoad(new PackedSplats(decoded));
      }
    }).catch((error) => {
      this.manager.itemError(resolvedURL ?? "");
      onError == null ? void 0 : onError(error);
    }).finally(() => {
      this.manager.itemEnd(resolvedURL ?? "");
    });
  }
  async loadInternalAsync({
    packedSplats,
    extSplats,
    url,
    fileBytes,
    fileType,
    fileName,
    stream,
    streamLength,
    onProgress
  }) {
    return new Promise((resolve, reject) => {
      this.loadInternal({
        packedSplats,
        extSplats,
        url,
        fileBytes,
        fileType,
        fileName,
        stream,
        streamLength,
        onLoad: resolve,
        onProgress,
        onError: reject
      });
    });
  }
}
const _ExtSplats = class _ExtSplats {
  constructor(options = {}) {
    this.maxSplats = 0;
    this.numSplats = 0;
    this.extra = {};
    this.maxSh = 3;
    this.isInitialized = false;
    this.extArrays = [new Uint32Array(0), new Uint32Array(0)];
    this.textures = [_ExtSplats.emptyTexture, _ExtSplats.emptyTexture];
    this.extra = {};
    this.dyno = new DynoExtSplats({ extSplats: this });
    this.dynoNumSh = new DynoInt({
      key: "numSh",
      value: 0,
      update: () => {
        return Math.min(this.getNumSh(), this.maxSh);
      }
    });
    this.initialized = Promise.resolve(this);
    this.reinitialize(options);
  }
  reinitialize(options) {
    this.isInitialized = false;
    this.extra = {};
    this.maxSplats = options.maxSplats ?? 0;
    if (options.url || options.fileBytes || options.stream || options.construct) {
      this.initialized = this.asyncInitialize(options).then(() => {
        this.isInitialized = true;
        return this;
      });
    } else {
      this.initialize(options);
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
    }
  }
  initialize(options) {
    this.extra = options.extra ?? {};
    if (options.extArrays) {
      this.extArrays = options.extArrays;
      this.maxSplats = Math.floor(
        Math.min(this.extArrays[0].length / 4, this.extArrays[1].length / 4)
      );
      this.numSplats = options.numSplats ?? this.maxSplats;
      this.maxSplats = Math.floor(this.maxSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      this.numSplats = Math.min(
        this.maxSplats,
        options.numSplats ?? Number.POSITIVE_INFINITY
      );
      this.updateTextures();
    } else {
      this.maxSplats = options.maxSplats ?? 0;
      this.numSplats = 0;
      this.extArrays = [new Uint32Array(0), new Uint32Array(0)];
    }
  }
  async asyncInitialize(options) {
    const {
      url,
      fileBytes,
      fileType,
      fileName,
      stream,
      streamLength,
      construct
    } = options;
    const loader = new SplatLoader();
    if (fileBytes || url || stream) {
      await loader.loadInternalAsync({
        extSplats: this,
        url,
        fileBytes,
        fileType,
        fileName,
        stream,
        streamLength,
        onProgress: options.onProgress
      });
    }
    if (construct) {
      const maybePromise = construct(this);
      if (maybePromise instanceof Promise) {
        await maybePromise;
      }
    }
  }
  // Call this when you are finished with the PackedSplats and want to free
  // any buffers it holds.
  dispose() {
    if (this.textures[0] !== _ExtSplats.emptyTexture) {
      this.textures[0].dispose();
      this.textures[0].source.data = null;
      this.textures[0] = _ExtSplats.emptyTexture;
    }
    if (this.textures[1] !== _ExtSplats.emptyTexture) {
      this.textures[1].dispose();
      this.textures[1].source.data = null;
      this.textures[1] = _ExtSplats.emptyTexture;
    }
    this.extArrays = [new Uint32Array(0), new Uint32Array(0)];
    for (const key in this.extra) {
      const dyno2 = this.extra[key];
      if (dyno2 instanceof DynoUniform) {
        const texture2 = dyno2.value;
        if (texture2 == null ? void 0 : texture2.isTexture) {
          texture2.dispose();
          texture2.source.data = null;
        }
      }
    }
    this.extra = {};
  }
  prepareFetchSplat() {
  }
  getNumSplats() {
    return this.numSplats;
  }
  hasRgbDir() {
    return Math.min(this.getNumSh(), this.maxSh) > 0;
  }
  getNumSh() {
    return !this.extra.sh1 ? 0 : !this.extra.sh2 ? 1 : !this.extra.sh3a || !this.extra.sh3b ? 2 : 3;
  }
  setMaxSh(maxSh) {
    this.maxSh = maxSh;
  }
  fetchSplat({
    index,
    viewOrigin
  }) {
    let gsplat = readExtSplat(this.dyno, index);
    if (this.hasRgbDir() && viewOrigin) {
      const splatCenter = splitGsplat(gsplat).outputs.center;
      const viewDir = normalize(sub(splatCenter, viewOrigin));
      const { sh1Texture, sh2Texture, sh3TextureA, sh3TextureB } = this.ensureShTextures();
      let { rgb } = evaluateExtSH({
        coord: splatTexCoord(index),
        viewDir,
        numSh: this.dynoNumSh,
        sh1Texture,
        sh2Texture,
        sh3TextureA,
        sh3TextureB
      });
      rgb = add(rgb, splitGsplat(gsplat).outputs.rgb);
      gsplat = combineGsplat({ gsplat, rgb });
    }
    return gsplat;
  }
  ensureShTextures() {
    if (!this.extra.sh1) {
      return {};
    }
    let sh1Texture = this.extra.sh1Texture;
    if (!sh1Texture) {
      let sh1 = this.extra.sh1;
      const { width, height, depth, maxSplats } = getTextureSize(
        sh1.length / 4
      );
      if (sh1.length < maxSplats * 4) {
        const newSh1 = new Uint32Array(maxSplats * 4);
        newSh1.set(sh1);
        this.extra.sh1 = newSh1;
        sh1 = newSh1;
      }
      const texture2 = newUint32ArrayTexture(
        sh1,
        width,
        height,
        depth,
        THREE__namespace.RGBAIntegerFormat,
        THREE__namespace.UnsignedIntType,
        "RGBA32UI"
      );
      sh1Texture = new DynoUsampler2DArray({
        value: texture2,
        key: "sh1"
      });
      this.extra.sh1Texture = sh1Texture;
    }
    if (!this.extra.sh2) {
      return { sh1Texture };
    }
    let sh2Texture = this.extra.sh2Texture;
    if (!sh2Texture) {
      let sh2 = this.extra.sh2;
      const { width, height, depth, maxSplats } = getTextureSize(
        sh2.length / 4
      );
      if (sh2.length < maxSplats * 4) {
        const newSh2 = new Uint32Array(maxSplats * 4);
        newSh2.set(sh2);
        this.extra.sh2 = newSh2;
        sh2 = newSh2;
      }
      const texture2 = newUint32ArrayTexture(
        sh2,
        width,
        height,
        depth,
        THREE__namespace.RGBAIntegerFormat,
        THREE__namespace.UnsignedIntType,
        "RGBA32UI"
      );
      sh2Texture = new DynoUsampler2DArray({
        value: texture2,
        key: "sh2"
      });
      this.extra.sh2Texture = sh2Texture;
    }
    if (!this.extra.sh3a || !this.extra.sh3b) {
      return { sh1Texture, sh2Texture };
    }
    let sh3TextureA = this.extra.sh3TextureA;
    if (!sh3TextureA) {
      let sh3a = this.extra.sh3a;
      const { width, height, depth, maxSplats } = getTextureSize(
        sh3a.length / 4
      );
      if (sh3a.length < maxSplats * 4) {
        const newSh3 = new Uint32Array(maxSplats * 4);
        newSh3.set(sh3a);
        this.extra.sh3a = newSh3;
        sh3a = newSh3;
      }
      const texture2 = newUint32ArrayTexture(
        sh3a,
        width,
        height,
        depth,
        THREE__namespace.RGBAIntegerFormat,
        THREE__namespace.UnsignedIntType,
        "RGBA32UI"
      );
      sh3TextureA = new DynoUsampler2DArray({
        value: texture2,
        key: "sh3"
      });
      this.extra.sh3TextureA = sh3TextureA;
    }
    let sh3TextureB = this.extra.sh3TextureB;
    if (!sh3TextureB) {
      let sh3b = this.extra.sh3b;
      const { width, height, depth, maxSplats } = getTextureSize(
        sh3b.length / 4
      );
      if (sh3b.length < maxSplats * 4) {
        const newSh3b = new Uint32Array(maxSplats * 4);
        newSh3b.set(sh3b);
        this.extra.sh3b = newSh3b;
        sh3b = newSh3b;
      }
      const texture2 = newUint32ArrayTexture(
        sh3b,
        width,
        height,
        depth,
        THREE__namespace.RGBAIntegerFormat,
        THREE__namespace.UnsignedIntType,
        "RGBA32UI"
      );
      sh3TextureB = new DynoUsampler2DArray({
        value: texture2,
        key: "sh3b"
      });
      this.extra.sh3TextureB = sh3TextureB;
    }
    return { sh1Texture, sh2Texture, sh3TextureA, sh3TextureB };
  }
  // Ensures that this.extArrays can fit numSplats Gsplats. If it's too small,
  // resize exponentially and copy over the original data.
  //
  // Typically you don't need to call this, because calling this.setSplat(index, ...)
  // and this.pushSplat(...) will automatically call ensureSplats() so we have
  // enough splats.
  ensureSplats(numSplats) {
    const targetSize = numSplats <= this.maxSplats ? this.maxSplats : (
      // Grow exponentially to avoid frequent reallocations
      Math.max(numSplats, 2 * this.maxSplats)
    );
    const currentSize = !this.extArrays[0] ? 0 : this.extArrays[0].length / 4;
    if (!this.extArrays[0] || targetSize > currentSize) {
      this.maxSplats = getTextureSize(targetSize).maxSplats;
      const newArray0 = new Uint32Array(this.maxSplats * 4);
      const newArray1 = new Uint32Array(this.maxSplats * 4);
      if (this.extArrays[0]) {
        newArray0.set(this.extArrays[0]);
        newArray1.set(this.extArrays[1]);
      }
      this.extArrays[0] = newArray0;
      this.extArrays[1] = newArray1;
    }
    return this.extArrays;
  }
  // Unpack the 16-byte Gsplat data at index into the Three.js components
  // center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion,
  // opacity: number 0..1, color: THREE.Color 0..1.
  getSplat(index) {
    if (index >= this.numSplats) {
      throw new Error("Invalid index");
    }
    return decodeExtSplat(this.extArrays, index);
  }
  // Set all ExtSplat components at index with the provided Gsplat attributes
  // (can be the same objects returned by getSplat). Ensures there is capacity
  // for at least index+1 Gsplats.
  setSplat(index, center, scales, quaternion, opacity, color) {
    const extArrays = this.ensureSplats(index + 1);
    encodeExtSplat(
      extArrays,
      index,
      center.x,
      center.y,
      center.z,
      scales.x,
      scales.y,
      scales.z,
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
      opacity,
      color.r,
      color.g,
      color.b
    );
    this.numSplats = Math.max(this.numSplats, index + 1);
  }
  // Effectively calls this.setSplat(this.numSplats++, center, ...), useful on
  // construction where you just want to iterate and create a collection of Gsplats.
  pushSplat(center, scales, quaternion, opacity, color) {
    const extArrays = this.ensureSplats(this.numSplats + 1);
    encodeExtSplat(
      extArrays,
      this.numSplats,
      center.x,
      center.y,
      center.z,
      scales.x,
      scales.y,
      scales.z,
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
      opacity,
      color.r,
      color.g,
      color.b
    );
    ++this.numSplats;
  }
  // Iterate over Gsplats index 0..=(this.numSplats-1), unpack each Gsplat
  // and invoke the callback function with the Gsplat attributes.
  forEachSplat(callback) {
    if (!this.numSplats) {
      return;
    }
    for (let i = 0; i < this.numSplats; ++i) {
      const unpacked = decodeExtSplat(this.extArrays, i);
      callback(
        i,
        unpacked.center,
        unpacked.scales,
        unpacked.quaternion,
        unpacked.opacity,
        unpacked.color
      );
    }
  }
  // Check if source texture needs to be created/updated
  updateTextures() {
    if (this.textures[0] !== _ExtSplats.emptyTexture) {
      const { width, height, depth } = this.textures[0].image;
      if (this.maxSplats !== width * height * depth) {
        this.textures[0].dispose();
        this.textures[0] = _ExtSplats.emptyTexture;
        this.textures[1].dispose();
        this.textures[1] = _ExtSplats.emptyTexture;
      }
    }
    if (this.textures[0] === _ExtSplats.emptyTexture) {
      const { width, height, depth } = getTextureSize(this.maxSplats);
      this.textures[0] = newUint32ArrayTexture(
        this.extArrays[0],
        width,
        height,
        depth,
        THREE__namespace.RGBAIntegerFormat,
        THREE__namespace.UnsignedIntType,
        "RGBA32UI"
      );
      this.textures[1] = newUint32ArrayTexture(
        this.extArrays[1],
        width,
        height,
        depth,
        THREE__namespace.RGBAIntegerFormat,
        THREE__namespace.UnsignedIntType,
        "RGBA32UI"
      );
    } else if (this.extArrays[0].buffer !== this.textures[0].image.data.buffer) {
      this.textures[0].image.data = new Uint8Array(this.extArrays[0].buffer);
      this.textures[1].image.data = new Uint8Array(this.extArrays[1].buffer);
      this.textures[0].needsUpdate = true;
      this.textures[1].needsUpdate = true;
    }
  }
};
_ExtSplats.emptyArray = (() => {
  const { width, height, depth, maxSplats } = getTextureSize(1);
  const emptyArray = new Uint32Array(maxSplats * 4);
  const texture2 = new THREE__namespace.DataArrayTexture(
    emptyArray,
    width,
    height,
    depth
  );
  texture2.format = THREE__namespace.RGBAIntegerFormat;
  texture2.type = THREE__namespace.UnsignedIntType;
  texture2.internalFormat = "RGBA32UI";
  texture2.needsUpdate = true;
  return texture2;
})();
_ExtSplats.emptyTexture = newUint32ArrayTexture(
  null,
  1,
  1,
  1,
  THREE__namespace.RGBAIntegerFormat,
  THREE__namespace.UnsignedIntType,
  "RGBA32UI"
);
_ExtSplats.emptyUint32x4 = (() => {
  const { width, height, depth, maxSplats } = getTextureSize(1);
  const emptyArray = new Uint32Array(maxSplats * 4);
  const texture2 = new THREE__namespace.DataArrayTexture(
    emptyArray,
    width,
    height,
    depth
  );
  texture2.format = THREE__namespace.RGBAIntegerFormat;
  texture2.type = THREE__namespace.UnsignedIntType;
  texture2.internalFormat = "RGBA32UI";
  texture2.needsUpdate = true;
  return texture2;
})();
let ExtSplats = _ExtSplats;
class DynoExtSplats extends DynoUniform {
  constructor({ extSplats } = {}) {
    super({
      key: "extSplats",
      type: TExtSplats,
      globals: () => [defineExtSplats],
      value: {
        textureArray1: ExtSplats.emptyTexture,
        textureArray2: ExtSplats.emptyTexture,
        numSplats: 0
      },
      update: (value) => {
        var _a, _b, _c;
        value.textureArray1 = ((_a = this.extSplats) == null ? void 0 : _a.textures[0]) ?? ExtSplats.emptyTexture;
        value.textureArray2 = ((_b = this.extSplats) == null ? void 0 : _b.textures[1]) ?? ExtSplats.emptyTexture;
        value.numSplats = ((_c = this.extSplats) == null ? void 0 : _c.numSplats) ?? 0;
        return value;
      }
    });
    this.extSplats = extSplats;
  }
}
const defineEvaluateExtSH1 = unindent(`
  vec3 evaluateExtSH1(uvec4 packedData, vec3 viewDir) {
    vec3 sh1_0 = decodeExtRgb(packedData.x);
    vec3 sh1_1 = decodeExtRgb(packedData.y);
    vec3 sh1_2 = decodeExtRgb(packedData.z);

    return sh1_0 * (-0.4886025 * viewDir.y)
      + sh1_1 * (0.4886025 * viewDir.z)
      + sh1_2 * (-0.4886025 * viewDir.x);
  }
`);
const defineEvaluateExtSH12 = unindent(`
  vec3 evaluateExtSH12(uvec4 packed1, uvec4 packed2, vec3 viewDir) {
    vec3 sh1_0 = decodeExtRgb(packed1.x);
    vec3 sh1_1 = decodeExtRgb(packed1.y);
    vec3 sh1_2 = decodeExtRgb(packed1.z);

    vec3 sh2_0 = decodeExtRgb(packed1.w);
    vec3 sh2_1 = decodeExtRgb(packed2.x);
    vec3 sh2_2 = decodeExtRgb(packed2.y);
    vec3 sh2_3 = decodeExtRgb(packed2.z);
    vec3 sh2_4 = decodeExtRgb(packed2.w);

    vec3 sh1Rgb = sh1_0 * (-0.4886025 * viewDir.y)
      + sh1_1 * (0.4886025 * viewDir.z)
      + sh1_2 * (-0.4886025 * viewDir.x);

    vec3 sh2Rgb = sh2_0 * (1.0925484 * viewDir.x * viewDir.y)
      + sh2_1 * (-1.0925484 * viewDir.y * viewDir.z)
      + sh2_2 * (0.3153915 * (2.0 * viewDir.z * viewDir.z - viewDir.x * viewDir.x - viewDir.y * viewDir.y))
      + sh2_3 * (-1.0925484 * viewDir.x * viewDir.z)
      + sh2_4 * (0.5462742 * (viewDir.x * viewDir.x - viewDir.y * viewDir.y));

    return sh1Rgb + sh2Rgb;
  }
`);
const defineEvaluateExtSH3 = unindent(`
  vec3 evaluateExtSH3(uvec4 packedA, uvec4 packedB, vec3 viewDir) {
    vec3 sh3_0 = decodeExtRgb(packedA.x);
    vec3 sh3_1 = decodeExtRgb(packedA.y);
    vec3 sh3_2 = decodeExtRgb(packedA.z);
    vec3 sh3_3 = decodeExtRgb(packedA.w);
    vec3 sh3_4 = decodeExtRgb(packedB.x);
    vec3 sh3_5 = decodeExtRgb(packedB.y);
    vec3 sh3_6 = decodeExtRgb(packedB.z);

    float xx = viewDir.x * viewDir.x;
    float yy = viewDir.y * viewDir.y;
    float zz = viewDir.z * viewDir.z;
    float xy = viewDir.x * viewDir.y;
    float yz = viewDir.y * viewDir.z;
    float zx = viewDir.z * viewDir.x;

    return sh3_0 * (-0.5900436 * viewDir.y * (3.0 * xx - yy))
      + sh3_1 * (2.8906114 * xy * viewDir.z) +
      + sh3_2 * (-0.4570458 * viewDir.y * (4.0 * zz - xx - yy))
      + sh3_3 * (0.3731763 * viewDir.z * (2.0 * zz - 3.0 * xx - 3.0 * yy))
      + sh3_4 * (-0.4570458 * viewDir.x * (4.0 * zz - xx - yy))
      + sh3_5 * (1.4453057 * viewDir.z * (xx - yy))
      + sh3_6 * (-0.5900436 * viewDir.x * (xx - 3.0 * yy));
  }
`);
function evaluateExtSH({
  coord,
  viewDir,
  numSh,
  sh1Texture,
  sh2Texture,
  sh3TextureA,
  sh3TextureB
}) {
  return new Dyno({
    inTypes: {
      coord: "ivec3",
      viewDir: "vec3",
      numSh: "int",
      sh1Texture: "usampler2DArray",
      sh2Texture: "usampler2DArray",
      sh3TextureA: "usampler2DArray",
      sh3TextureB: "usampler2DArray"
    },
    outTypes: { rgb: "vec3" },
    inputs: {
      coord,
      viewDir,
      numSh,
      sh1Texture,
      sh2Texture,
      sh3TextureA,
      sh3TextureB
    },
    globals: () => [
      defineEvaluateExtSH1,
      defineEvaluateExtSH12,
      defineEvaluateExtSH3
    ],
    statements: ({ inputs, outputs }) => {
      const lines = ["vec3 rgb = vec3(0.0);"];
      if (inputs.sh1Texture) {
        if (!inputs.sh2Texture) {
          lines.push(
            ...unindentLines(`
            if (${inputs.numSh} >= 1) {
              rgb = evaluateExtSH1(texelFetch(${inputs.sh1Texture}, ${inputs.coord}, 0), ${inputs.viewDir});
            }
            `)
          );
        } else {
          lines.push(
            ...unindentLines(`
            if (${inputs.numSh} == 1) {
              rgb = evaluateExtSH1(texelFetch(${inputs.sh1Texture}, ${inputs.coord}, 0), ${inputs.viewDir});
            } else if (${inputs.numSh} >= 2) {
              rgb = evaluateExtSH12(texelFetch(${inputs.sh1Texture}, ${inputs.coord}, 0), texelFetch(${inputs.sh2Texture}, ${inputs.coord}, 0), ${inputs.viewDir});
            `)
          );
          if (inputs.sh3TextureA && inputs.sh3TextureB) {
            lines.push(
              ...unindentLines(`
              if (${inputs.numSh} >= 3) {
                rgb += evaluateExtSH3(texelFetch(${inputs.sh3TextureA}, ${inputs.coord}, 0), texelFetch(${inputs.sh3TextureB}, ${inputs.coord}, 0), ${inputs.viewDir});
              }
            `)
            );
          }
          lines.push("}");
        }
      }
      lines.push(`${outputs.rgb} = rgb;`);
      return lines;
    }
  }).outputs;
}
function newUint32ArrayTexture(data, width, height, depth, format, type, internalFormat) {
  const texture2 = new THREE__namespace.DataArrayTexture(
    data,
    width,
    height,
    depth
  );
  texture2.format = format;
  texture2.type = type;
  texture2.internalFormat = internalFormat;
  texture2.needsUpdate = true;
  return texture2;
}
const _RgbaArray = class _RgbaArray {
  constructor(options = {}) {
    this.capacity = 0;
    this.count = 0;
    this.array = null;
    this.readback = null;
    this.source = null;
    this.needsUpdate = true;
    this.dyno = new DynoUniform({
      key: "rgbaArray",
      type: TRgbaArray,
      globals: () => [defineRgbaArray],
      value: {
        texture: _RgbaArray.getEmpty(),
        count: 0
      },
      update: (value) => {
        value.texture = this.getTexture();
        value.count = this.count;
        return value;
      }
    });
    if (options.array) {
      this.array = options.array;
      const splatCount = Math.floor(this.array.length / 4);
      this.capacity = Math.ceil(splatCount / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      if (this.capacity > splatCount) {
        this.array = new Uint8Array(this.capacity * 4);
        this.array.set(options.array);
      }
      this.count = Math.min(
        splatCount,
        options.count ?? Number.POSITIVE_INFINITY
      );
    } else {
      this.capacity = options.capacity ?? 0;
      this.count = 0;
    }
  }
  // Free up resources
  dispose() {
    if (this.readback) {
      this.readback.dispose();
      this.readback = null;
    }
    if (this.source) {
      this.source.dispose();
      this.source = null;
    }
  }
  // Ensure that our array is large enough to hold capacity RGBA8 values.
  ensureCapacity(capacity) {
    var _a;
    if (!this.array || capacity > (((_a = this.array) == null ? void 0 : _a.length) ?? 0) / 4) {
      this.capacity = getTextureSize(capacity).maxSplats;
      const newArray2 = new Uint8Array(this.capacity * 4);
      if (this.array) {
        newArray2.set(this.array);
      }
      this.array = newArray2;
    }
    return this.array;
  }
  // Get the THREE.DataArrayTexture from either the readback or the source.
  getTexture() {
    var _a;
    let texture2 = (_a = this.readback) == null ? void 0 : _a.getTexture();
    if (this.source || this.array) {
      texture2 = this.maybeUpdateSource();
    }
    return texture2 ?? _RgbaArray.getEmpty();
  }
  // Create or get a THREE.DataArrayTexture from the data array.
  maybeUpdateSource() {
    if (!this.array) {
      throw new Error("No array");
    }
    if (this.needsUpdate || !this.source) {
      this.needsUpdate = false;
      if (this.source) {
        const { width, height, depth } = this.source.image;
        if (this.capacity !== width * height * depth) {
          this.source.dispose();
          this.source = null;
        }
      }
      if (!this.source) {
        const { width, height, depth } = getTextureSize(this.capacity);
        this.source = new THREE__namespace.DataArrayTexture(
          this.array,
          width,
          height,
          depth
        );
        this.source.format = THREE__namespace.RGBAFormat;
        this.source.type = THREE__namespace.UnsignedByteType;
        this.source.internalFormat = "RGBA8";
        this.source.needsUpdate = true;
      } else if (this.array.buffer !== this.source.image.data.buffer) {
        this.source.image.data = new Uint8Array(this.array.buffer);
      }
      this.source.needsUpdate = true;
    }
    return this.source;
  }
  // Generate the RGBA8 values from a Rgba8Readback dyno program.
  render({
    reader,
    count,
    renderer
  }) {
    if (!this.readback) {
      this.readback = new Readback({ renderer });
    }
    this.readback.render({ reader, count, renderer });
    this.capacity = this.readback.capacity;
    this.count = this.readback.count;
  }
  // Extract the RGBA8 values from a PackedSplats collection.
  fromPackedSplats({
    packedSplats,
    base,
    count,
    renderer
  }) {
    const { dynoSplats, dynoBase, dynoCount, reader } = _RgbaArray.makeDynos();
    dynoSplats.packedSplats = packedSplats;
    dynoBase.value = base;
    dynoCount.value = count;
    this.render({ reader, count, renderer });
    return this;
  }
  // Read back the RGBA8 values from the readback buffer.
  async read() {
    if (!this.readback) {
      throw new Error("No readback");
    }
    if (!this.array || this.array.length < this.count * 4) {
      this.array = new Uint8Array(this.capacity * 4);
    }
    const result = await this.readback.readback({ readback: this.array });
    return result.subarray(0, this.count * 4);
  }
  async getArray() {
    if (this.readback) {
      return await this.read();
    }
    if (this.array) {
      return this.array;
    }
    throw new Error("No array");
  }
  // Can be used where you need an uninitialized THREE.DataArrayTexture like
  // a uniform you will update with the result of this.getTexture() later.
  static getEmpty() {
    if (!_RgbaArray.emptySource) {
      const emptyArray = new Uint8Array(1 * 4);
      _RgbaArray.emptySource = new THREE__namespace.DataArrayTexture(emptyArray, 1, 1, 1);
      _RgbaArray.emptySource.format = THREE__namespace.RGBAFormat;
      _RgbaArray.emptySource.type = THREE__namespace.UnsignedByteType;
      _RgbaArray.emptySource.internalFormat = "RGBA8";
      _RgbaArray.emptySource.needsUpdate = true;
    }
    return _RgbaArray.emptySource;
  }
  // Create a dyno program that can extract RGBA8 values from a PackedSplats
  static makeDynos() {
    if (!_RgbaArray.dynos) {
      const dynoSplats = new DynoPackedSplats();
      const dynoBase = new DynoInt({ value: 0 });
      const dynoCount = new DynoInt({ value: 0 });
      const reader = dynoBlock(
        { index: "int" },
        { rgba8: "vec4" },
        ({ index }) => {
          if (!index) {
            throw new Error("index is undefined");
          }
          index = add(index, dynoBase);
          const gsplat = readPackedSplatRange(
            dynoSplats,
            index,
            dynoBase,
            dynoCount
          );
          return { rgba8: splitGsplat(gsplat).outputs.rgba };
        }
      );
      _RgbaArray.dynos = { dynoSplats, dynoBase, dynoCount, reader };
    }
    return _RgbaArray.dynos;
  }
};
_RgbaArray.emptySource = null;
_RgbaArray.dynos = null;
let RgbaArray = _RgbaArray;
const TRgbaArray = { type: "RgbaArray" };
const defineRgbaArray = unindent(`
  struct RgbaArray {
    sampler2DArray texture;
    int count;
  };
`);
function readRgbaArray(rgba, index) {
  const dyno2 = new Dyno({
    inTypes: { rgba: TRgbaArray, index: "int" },
    outTypes: { rgba: "vec4" },
    inputs: { rgba, index },
    globals: () => [defineRgbaArray],
    statements: ({ inputs, outputs }) => unindentLines(`
        if ((${inputs.index} >= 0) && (${inputs.index} < ${inputs.rgba}.count)) {
          ${outputs.rgba} = texelFetch(${inputs.rgba}.texture, splatTexCoord(${inputs.index}), 0);
        } else {
          ${outputs.rgba} = vec4(0.0, 0.0, 0.0, 0.0);
        }
      `)
  });
  return dyno2.outputs.rgba;
}
class EmptySplatSource {
  constructor() {
    this.fetchDyno = new Dyno({
      inTypes: {},
      outTypes: { gsplat: Gsplat },
      globals: () => [defineGsplat],
      statements: ({ outputs }) => unindentLines(`
      ${outputs.gsplat}.flags = 0u;
      return;
    `)
    }).outputs.gsplat;
  }
  prepareFetchSplat() {
  }
  dispose() {
  }
  getNumSplats() {
    return 0;
  }
  hasRgbDir() {
    return false;
  }
  getNumSh() {
    return 0;
  }
  setMaxSh(maxSh) {
  }
  fetchSplat({ index }) {
    return this.fetchDyno;
  }
  forEachSplat() {
  }
}
const _SplatMesh = class _SplatMesh extends SplatGenerator {
  constructor(options = {}) {
    super({
      update: (context) => this.update(context)
    });
    this.isInitialized = false;
    this.recolor = new THREE__namespace.Color(1, 1, 1);
    this.opacity = 1;
    this.generatorDirty = true;
    this.enableViewToObject = false;
    this.enableViewToWorld = false;
    this.enableWorldToView = false;
    this.skinning = null;
    this.edits = null;
    this.rgbaDisplaceEdits = null;
    this.splatRgba = null;
    this.maxSh = 3;
    if (options.splats) {
      this.splats = options.splats;
      this.numSplats = options.splats.getNumSplats();
    } else if (options.extSplats) {
      this.extSplats = options.extSplats instanceof ExtSplats ? options.extSplats : new ExtSplats();
      options.extSplats = this.extSplats;
      this.numSplats = this.extSplats.numSplats;
      this.splats = this.extSplats;
    } else if (options.packedSplats) {
      this.packedSplats = options.packedSplats;
      this.packedSplats.splatEncoding = options.splatEncoding ?? {
        ...DEFAULT_SPLAT_ENCODING
      };
      this.splats = this.packedSplats;
    } else {
      this.packedSplats = new PackedSplats();
    }
    this.editable = options.editable ?? true;
    this.raycastable = options.raycastable ?? true;
    this.minRaycastOpacity = options.minRaycastOpacity ?? 0.2;
    this.onFrame = options.onFrame;
    this.context = {
      transform: new SplatTransformer(),
      viewToWorld: new SplatTransformer(),
      worldToView: new SplatTransformer(),
      viewToObject: new SplatTransformer(),
      covTransform: new CovSplatTransformer(),
      covViewToWorld: new CovSplatTransformer(),
      covWorldToView: new CovSplatTransformer(),
      covViewToObject: new CovSplatTransformer(),
      recolor: new DynoVec4({
        value: new THREE__namespace.Vector4().setScalar(Number.NEGATIVE_INFINITY)
      }),
      time: new DynoFloat({ value: 0 }),
      deltaTime: new DynoFloat({ value: 0 }),
      numSplats: new DynoInt({ value: 0 }),
      splats: new EmptySplatSource()
    };
    this.covSplats = options.covSplats ?? false;
    if (this.covSplats && !this.extSplats) {
      throw new Error("CovSplats requires ExtSplats");
    }
    this.objectModifiers = options.objectModifier ? [options.objectModifier] : void 0;
    this.worldModifiers = options.worldModifier ? [options.worldModifier] : void 0;
    if (options.objectModifiers) {
      this.objectModifiers = options.objectModifiers;
    }
    if (options.worldModifiers) {
      this.worldModifiers = options.worldModifiers;
    }
    this.updateGenerator();
    if (options.url || options.fileBytes || options.stream || options.constructSplats || options.packedSplats && !options.packedSplats.isInitialized || this.extSplats && !this.extSplats.isInitialized) {
      this.initialized = this.asyncInitialize(options).then(async () => {
        this.updateGenerator();
        this.isInitialized = true;
        if (options.onLoad) {
          const maybePromise = options.onLoad(this);
          if (maybePromise instanceof Promise) {
            await maybePromise;
          }
        }
        return this;
      });
    } else {
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
      if (options.onLoad) {
        const maybePromise = options.onLoad(this);
        if (maybePromise instanceof Promise) {
          this.initialized = maybePromise.then(() => this);
        }
      }
    }
  }
  async asyncInitialize(options) {
    const {
      url,
      fileBytes,
      fileType,
      fileName,
      stream,
      streamLength,
      maxSplats,
      constructSplats,
      onProgress,
      splatEncoding
    } = options;
    if (this.packedSplats) {
      if (url || fileBytes || stream || constructSplats) {
        const packedSplatsOptions = {
          url,
          fileBytes,
          fileType,
          fileName,
          stream,
          streamLength,
          maxSplats,
          construct: constructSplats,
          onProgress,
          splatEncoding
        };
        this.packedSplats.reinitialize(packedSplatsOptions);
      }
      await this.packedSplats.initialized;
      this.splats = this.packedSplats;
    } else if (this.extSplats) {
      if (url || fileBytes || stream || constructSplats) {
        const construct = constructSplats;
        this.extSplats.reinitialize({
          url,
          fileBytes,
          fileType,
          fileName,
          stream,
          streamLength,
          maxSplats,
          construct,
          onProgress
        });
        await this.extSplats.initialized;
        this.splats = this.extSplats;
      }
    }
    if (this.splats) {
      this.numSplats = this.splats.getNumSplats();
      this.updateGenerator();
    }
  }
  static async staticInitialize() {
    await __wbg_init();
    _SplatMesh.isStaticInitialized = true;
  }
  // Creates a new Gsplat with the provided parameters (all values in "float" space,
  // i.e. 0-1 for opacity and color) and adds it to the end of the packedSplats,
  // increasing numSplats by 1. If necessary, reallocates the buffer with an exponential
  // doubling strategy to fit the new data, so it's fairly efficient to just
  // pushSplat(...) each Gsplat you want to create in a loop.
  pushSplat(center, scales, quaternion, opacity, color) {
    if (this.packedSplats) {
      this.packedSplats.pushSplat(center, scales, quaternion, opacity, color);
    } else if (this.extSplats) {
      this.extSplats.pushSplat(center, scales, quaternion, opacity, color);
    }
  }
  // This method iterates over all Gsplats in this instance's packedSplats,
  // invoking the provided callback with index: number in 0..=(this.numSplats-1) and
  // center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion,
  // opacity: number (0..1), and color: THREE.Color (rgb values in 0..1).
  // Note that the objects passed in as center etc. are the same for every callback
  // invocation: these objects are reused for efficiency. Changing these values has
  // no effect as they are decoded/unpacked copies of the underlying data. To update
  // the packedSplats, call .packedSplats.setSplat(index, center, scales,
  // quaternion, opacity, color).
  forEachSplat(callback) {
    var _a;
    (_a = this.splats) == null ? void 0 : _a.forEachSplat(callback);
  }
  // Call this when you are finished with the SplatMesh and want to free
  // any buffers it holds (via packedSplats).
  dispose() {
    if (this.splats && this.splats !== this.packedSplats && this.splats !== this.extSplats) {
      this.splats.dispose();
      this.splats = void 0;
    }
    if (this.packedSplats) {
      this.packedSplats.dispose();
      this.packedSplats = void 0;
    }
    if (this.extSplats) {
      this.extSplats.dispose();
      this.extSplats = void 0;
    }
  }
  // Returns axis-aligned bounding box of the SplatMesh. If centers_only is true,
  // only the centers of the splats are used to compute the bounding box.
  // IMPORTANT: This should only be called after the SplatMesh is initialized.
  getBoundingBox(centers_only = true) {
    var _a;
    if (!this.initialized) {
      throw new Error(
        "Cannot get bounding box before SplatMesh is initialized"
      );
    }
    const minVec = new THREE__namespace.Vector3(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY
    );
    const maxVec = new THREE__namespace.Vector3(
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    );
    const corners = new THREE__namespace.Vector3();
    const signs = [-1, 1];
    function callback(_index, center, scales, quaternion, _opacity, _color) {
      if (centers_only) {
        minVec.min(center);
        maxVec.max(center);
      } else {
        for (const x of signs) {
          for (const y of signs) {
            for (const z of signs) {
              corners.set(x * scales.x, y * scales.y, z * scales.z);
              corners.applyQuaternion(quaternion);
              corners.add(center);
              minVec.min(corners);
              maxVec.max(corners);
            }
          }
        }
      }
    }
    (_a = this.splats) == null ? void 0 : _a.forEachSplat(callback);
    const box = new THREE__namespace.Box3(minVec, maxVec);
    return box;
  }
  set objectModifier(modifier) {
    if (modifier) {
      this.objectModifiers = [modifier];
    } else {
      this.objectModifiers = void 0;
    }
  }
  set worldModifier(modifier) {
    if (modifier) {
      this.worldModifiers = [modifier];
    } else {
      this.worldModifiers = void 0;
    }
  }
  constructGenerator(context) {
    if (this.covSplats) {
      return this.constructCovGenerator(context);
    }
    const { transform, viewToObject, recolor } = context;
    const generator = dynoBlock(
      { index: "int" },
      { gsplat: Gsplat },
      ({ index }) => {
        if (!index) {
          throw new Error("index is undefined");
        }
        context.splats.setMaxSh(this.maxSh);
        context.splats.prepareFetchSplat();
        let gsplat = context.splats.fetchSplat({
          index,
          viewOrigin: viewToObject.translate
        });
        if (this.splatRgba) {
          gsplat = maybeInjectSplatRgba(gsplat, this.splatRgba.dyno, index);
        }
        if (this.skinning) {
          gsplat = this.skinning.modify(gsplat);
        }
        if (this.objectModifiers) {
          for (const modifier of this.objectModifiers) {
            gsplat = modifier.apply({ gsplat }).gsplat;
          }
        }
        gsplat = transform.applyGsplat(gsplat);
        const recolorRgba = mul(recolor, splitGsplat(gsplat).outputs.rgba);
        gsplat = combineGsplat({ gsplat, rgba: recolorRgba });
        if (this.rgbaDisplaceEdits) {
          gsplat = this.rgbaDisplaceEdits.modify(gsplat);
        }
        if (this.worldModifiers) {
          for (const modifier of this.worldModifiers) {
            gsplat = modifier.apply({ gsplat }).gsplat;
          }
        }
        return { gsplat };
      }
    );
    this.generator = generator;
    this.covGenerator = void 0;
  }
  constructCovGenerator(context) {
    const { covTransform, covViewToObject, recolor } = context;
    const generator = dynoBlock(
      { index: "int" },
      { covsplat: CovSplat },
      ({ index }) => {
        if (!index) {
          throw new Error("index is undefined");
        }
        context.splats.prepareFetchSplat();
        let gsplat = context.splats.fetchSplat({
          index,
          viewOrigin: covViewToObject.offset
        });
        if (this.splatRgba) {
          gsplat = maybeInjectSplatRgba(gsplat, this.splatRgba.dyno, index);
        }
        if (this.objectModifiers) {
          for (const modifier of this.objectModifiers) {
            gsplat = modifier.apply({ gsplat }).gsplat;
          }
        }
        let covsplat = gsplatToCovSplat(gsplat);
        if (this.skinning) {
          covsplat = this.skinning.modifyCov(covsplat);
        }
        if (this.covObjectModifiers) {
          for (const modifier of this.covObjectModifiers) {
            covsplat = modifier.apply({ covsplat }).covsplat;
          }
        }
        covsplat = covTransform.applyCovSplat(covsplat);
        const recolorRgba = mul(recolor, splitCovSplat(covsplat).outputs.rgba);
        covsplat = combineCovSplat({ covsplat, rgba: recolorRgba });
        if (this.rgbaDisplaceEdits) {
          covsplat = this.rgbaDisplaceEdits.modifyCov(covsplat);
        }
        if (this.covWorldModifiers) {
          for (const modifier of this.covWorldModifiers) {
            covsplat = modifier.apply({ covsplat }).covsplat;
          }
        }
        return { covsplat };
      }
    );
    this.generator = void 0;
    this.covGenerator = generator;
  }
  // Call this whenever something changes in the Gsplat processing pipeline,
  // for example changing maxSh or updating objectModifier or worldModifier.
  // Compiled generators are cached for efficiency and re-use when the same
  // pipeline structure emerges after successive changes.
  updateGenerator() {
    this.generatorDirty = true;
  }
  // This is called automatically by SparkRenderer and you should not have to
  // call it. It updates parameters for the generated pipeline and calls
  // updateGenerator() if the pipeline needs to change.
  update({
    renderer,
    time,
    deltaTime,
    viewToWorld,
    camera,
    renderSize,
    globalEdits
  }) {
    var _a;
    this.context.time.value = time;
    this.context.deltaTime.value = deltaTime;
    _SplatMesh.dynoTime.value = time;
    const splats = this.splats ?? this.packedSplats ?? this.extSplats;
    if (splats) {
      this.context.splats = splats;
    }
    this.numSplats = this.context.splats.getNumSplats();
    let updated = false;
    this.context.numSplats.value = this.numSplats;
    if (this.context.splats !== this.lastSplats) {
      this.lastSplats = this.context.splats;
      this.generatorDirty = true;
    }
    if (!this.covSplats) {
      if (this.context.transform.update(this)) {
        updated = true;
      }
      if (this.context.viewToWorld.updateFromMatrix(viewToWorld) && this.enableViewToWorld) {
        updated = true;
      }
      const worldToView = viewToWorld.clone().invert();
      if (this.context.worldToView.updateFromMatrix(worldToView) && this.enableWorldToView) {
        updated = true;
      }
      const objectToWorld = new THREE__namespace.Matrix4().compose(
        this.context.transform.translate.value,
        this.context.transform.rotate.value,
        new THREE__namespace.Vector3().setScalar(this.context.transform.scale.value)
      );
      const worldToObject = objectToWorld.invert();
      const viewToObjectMatrix = worldToObject.multiply(viewToWorld);
      if (this.context.viewToObject.updateFromMatrix(viewToObjectMatrix) && (this.enableViewToObject || this.context.splats.hasRgbDir())) {
        updated = true;
      }
    } else {
      if (this.context.covTransform.update(this)) {
        updated = true;
      }
      if (this.context.covViewToWorld.updateFromMatrix(viewToWorld) && this.enableViewToWorld) {
        updated = true;
      }
      const worldToView = viewToWorld.clone().invert();
      if (this.context.covWorldToView.updateFromMatrix(worldToView) && this.enableWorldToView) {
        updated = true;
      }
      const worldToObject = this.matrixWorld.clone().invert();
      const viewToObjectMatrix = worldToObject.multiply(viewToWorld);
      if (this.context.covViewToObject.updateFromMatrix(viewToObjectMatrix) && (this.enableViewToObject || this.context.splats.hasRgbDir())) {
        updated = true;
      }
    }
    const newRecolor = new THREE__namespace.Vector4(
      this.recolor.r,
      this.recolor.g,
      this.recolor.b,
      this.opacity
    );
    if (!newRecolor.equals(this.context.recolor.value)) {
      this.context.recolor.value.copy(newRecolor);
      updated = true;
    }
    const edits = this.editable ? (this.edits ?? []).concat(globalEdits) : [];
    if (this.editable && !this.edits) {
      this.traverseVisible((node) => {
        if (node instanceof SplatEdit) {
          edits.push(node);
        }
      });
    }
    edits.sort((a, b) => a.ordering - b.ordering);
    const editsSdfs = edits.map((edit) => {
      if (edit.sdfs != null) {
        return { edit, sdfs: edit.sdfs };
      }
      const sdfs = [];
      edit.traverseVisible((node) => {
        if (node instanceof SplatEditSdf) {
          sdfs.push(node);
        }
      });
      return { edit, sdfs };
    });
    if (editsSdfs.length > 0 && !this.rgbaDisplaceEdits) {
      const edits2 = editsSdfs.length;
      const sdfs = editsSdfs.reduce(
        (total, edit) => total + edit.sdfs.length,
        0
      );
      this.rgbaDisplaceEdits = new SplatEdits({
        maxEdits: edits2,
        maxSdfs: sdfs
      });
      this.generatorDirty = true;
    }
    if (this.rgbaDisplaceEdits) {
      const editResult = this.rgbaDisplaceEdits.update(editsSdfs);
      updated || (updated = editResult.updated);
      if (editResult.dynoUpdated) {
        this.generatorDirty = true;
      }
    }
    if (this.generatorDirty) {
      this.constructGenerator(this.context);
      this.generatorDirty = false;
      updated = true;
    }
    if (updated) {
      this.updateVersion();
    }
    (_a = this.onFrame) == null ? void 0 : _a.call(this, { mesh: this, time, deltaTime });
  }
  // This method conforms to the standard THREE.Raycaster API, performing object-ray
  // intersections using this method to populate the provided intersects[] array
  // with each intersection point.
  raycast(raycaster, intersects) {
    var _a, _b, _c, _d;
    if (!_SplatMesh.isStaticInitialized || !this.raycastable || !this.packedSplats && !this.extSplats) {
      return;
    }
    const ext = this.extSplats != null;
    const { near, far, ray } = raycaster;
    const worldToMesh = this.matrixWorld.clone().invert();
    const worldToMeshRot = new THREE__namespace.Matrix3().setFromMatrix4(worldToMesh);
    const origin = ray.origin.clone().applyMatrix4(worldToMesh);
    const direction = ray.direction.clone().applyMatrix3(worldToMeshRot);
    const buffer = get_raycast_buffer();
    const bufferSize = buffer.length / 4;
    let intersections = 0;
    const numSplats = this.context.numSplats.value ?? 0;
    if (!ext) {
      const packed = (_a = this.packedSplats) == null ? void 0 : _a.packedArray;
      if (!packed) {
        return;
      }
      const splatEncoding = (_b = this.packedSplats) == null ? void 0 : _b.splatEncoding;
      for (let base = 0; base < numSplats; base += bufferSize) {
        const count = Math.min(bufferSize, numSplats - base);
        buffer.set(packed.subarray(base * 4, (base + count) * 4));
        const newIntersections = raycast_packed_buffer(
          origin.x,
          origin.y,
          origin.z,
          direction.x,
          direction.y,
          direction.z,
          this.minRaycastOpacity,
          near,
          far,
          count,
          (splatEncoding == null ? void 0 : splatEncoding.lnScaleMin) ?? LN_SCALE_MIN,
          (splatEncoding == null ? void 0 : splatEncoding.lnScaleMax) ?? LN_SCALE_MAX
        );
        intersections = this.appendRaycastBuffer(
          intersections,
          newIntersections
        );
      }
    } else {
      const buffer2 = get_raycast_buffer2();
      const ext1 = (_c = this.extSplats) == null ? void 0 : _c.extArrays[0];
      const ext2 = (_d = this.extSplats) == null ? void 0 : _d.extArrays[1];
      if (!ext1 || !ext2) {
        return;
      }
      for (let base = 0; base < numSplats; base += bufferSize) {
        const count = Math.min(bufferSize, numSplats - base);
        buffer.set(ext1.subarray(base * 4, (base + count) * 4));
        buffer2.set(ext2.subarray(base * 4, (base + count) * 4));
        const newIntersections = raycast_ext_buffers(
          origin.x,
          origin.y,
          origin.z,
          direction.x,
          direction.y,
          direction.z,
          this.minRaycastOpacity,
          near,
          far,
          count
        );
        intersections = this.appendRaycastBuffer(
          intersections,
          newIntersections
        );
      }
    }
    for (const distance2 of _SplatMesh.raycastBuffer.subarray(0, intersections)) {
      const point = ray.direction.clone().multiplyScalar(distance2).add(ray.origin);
      intersects.push({
        distance: distance2,
        point,
        object: this
      });
    }
  }
  appendRaycastBuffer(count, additional) {
    const total = count + additional.length;
    let capacity = _SplatMesh.raycastBuffer.length;
    if (total > capacity) {
      while (capacity < total) {
        capacity *= 2;
      }
      const newBuffer = new Float32Array(capacity);
      newBuffer.set(_SplatMesh.raycastBuffer.subarray(0, count));
      _SplatMesh.raycastBuffer = newBuffer;
    }
    _SplatMesh.raycastBuffer.set(additional, count);
    return count + additional.length;
  }
};
_SplatMesh.staticInitialized = _SplatMesh.staticInitialize();
_SplatMesh.isStaticInitialized = false;
_SplatMesh.dynoTime = new DynoFloat({ value: 0 });
_SplatMesh.raycastBuffer = new Float32Array(1024);
let SplatMesh = _SplatMesh;
function maybeInjectSplatRgba(gsplat, rgba, index) {
  return dyno$1({
    inTypes: {
      gsplat: Gsplat,
      rgba: TRgbaArray,
      index: "int"
    },
    outTypes: { gsplat: Gsplat },
    inputs: { gsplat, rgba, index },
    statements: ({ inputs, outputs }) => unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        if ((${inputs.index} >= 0) && (${inputs.index} < ${inputs.rgba}.count)) {
          ${outputs.gsplat}.rgba = texelFetch(${inputs.rgba}.texture, splatTexCoord(${inputs.index}), 0);
        }
      `)
  }).outputs.gsplat;
}
const _SplatAccumulator = class _SplatAccumulator {
  constructor({
    extSplats,
    covSplats
  } = {}) {
    this.time = 0;
    this.deltaTime = 0;
    this.viewToWorld = new THREE__namespace.Matrix4();
    this.viewOrigin = new THREE__namespace.Vector3();
    this.viewDirection = new THREE__namespace.Vector3();
    this.maxSplats = 0;
    this.numSplats = 0;
    this.target = null;
    this.mapping = [];
    this.version = -1;
    this.mappingVersion = -1;
    this.readback = null;
    this.readbackSplats = [];
    if (!threeMrtArray) {
      throw new Error("Spark requires THREE.js r179 or above");
    }
    this.extSplats = extSplats ?? true;
    this.covSplats = covSplats ?? false;
  }
  dispose() {
    if (this.target) {
      this.target.dispose();
      this.target = null;
    }
  }
  // Returns a THREE.DataArrayTexture representing the NewSplatAccumulator
  // content as 2 x Uint32x4 data array textures (2048 x 2048 x 2048 in size)
  getTextures() {
    if (this.target) {
      return this.target.textures;
    }
    return _SplatAccumulator.emptyTextures;
  }
  // Given an array of splatCounts (.numSplats for each
  // SplatGenerator/SplatMesh in the scene), compute a
  // "mapping layout" in the composite array of generated outputs.
  generateMapping(splatCounts) {
    let maxSplats = 0;
    const mapping = splatCounts.map((numSplats) => {
      const base = maxSplats;
      const rounded = Math.ceil(numSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      maxSplats += rounded;
      return { base, count: numSplats };
    });
    return { maxSplats, mapping };
  }
  // Ensures our NewSplatAccumulator.target render target has enough space
  // to generate maxSplats total Gsplats, and reallocate if not large enough.
  ensureGenerate({ maxSplats }) {
    if (this.target && (maxSplats ?? 1) <= this.maxSplats) {
      return false;
    }
    this.dispose();
    const textureSize2 = getTextureSize(maxSplats ?? 1);
    const { width, height, depth } = textureSize2;
    this.maxSplats = textureSize2.maxSplats;
    this.target = new THREE__namespace.WebGLArrayRenderTarget(width, height, depth, {
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      magFilter: THREE__namespace.NearestFilter,
      minFilter: THREE__namespace.NearestFilter,
      format: THREE__namespace.RGBAIntegerFormat,
      type: THREE__namespace.UnsignedIntType
    });
    this.target.scissorTest = true;
    if (this.extSplats) {
      const target2 = this.target.texture.clone();
      const target3 = this.target.texture.clone();
      target3.format = THREE__namespace.RGBAFormat;
      target3.type = THREE__namespace.UnsignedByteType;
      target3.internalFormat = "RGBA8";
      this.target.textures = [this.target.texture, target2, target3];
    } else {
      const target3 = this.target.texture.clone();
      target3.format = THREE__namespace.RGBAFormat;
      target3.type = THREE__namespace.UnsignedByteType;
      target3.internalFormat = "RGBA8";
      this.target.textures = [this.target.texture, target3];
    }
    return true;
  }
  saveRenderState(renderer) {
    return {
      target: renderer.getRenderTarget(),
      xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear
    };
  }
  resetRenderState(renderer, state) {
    renderer.setRenderTarget(state.target);
    renderer.xr.enabled = state.xrEnabled;
    renderer.autoClear = state.autoClear;
  }
  // Get a program and THREE.RawShaderMaterial for a given GsplatGenerator,
  // generating it if necessary and caching the result.
  prepareProgramMaterial(generator, covGenerator) {
    const theGenerator = generator ?? covGenerator;
    if (!theGenerator) {
      throw new Error("Either generator or covGenerator must be provided");
    }
    let program = _SplatAccumulator.generatorProgram.get(theGenerator);
    if (!program) {
      const graph = dynoBlock(
        { index: "int" },
        {},
        ({ index }, _outputs, { roots }) => {
          if (generator) {
            generator.inputs.index = index;
          }
          if (covGenerator) {
            covGenerator.inputs.index = index;
          }
          if (this.extSplats) {
            if (!this.covSplats) {
              if (generator) {
                const output = outputExtendedSplat(generator.outputs.gsplat);
                roots.push(output);
              } else {
                throw new Error("Generator must be provided");
              }
            } else {
              if (covGenerator) {
                const output = outputExtCovSplat(covGenerator.outputs.covsplat);
                roots.push(output);
              } else if (generator) {
                const covsplat = gsplatToCovSplat(generator.outputs.gsplat);
                const output = outputExtCovSplat(covsplat);
                roots.push(output);
              } else {
                throw new Error("Generator must be provided");
              }
            }
          } else {
            if (!this.covSplats) {
              if (generator) {
                const centerSubView = sub(
                  splitGsplat(generator.outputs.gsplat).outputs.center,
                  _SplatAccumulator.viewCenterUniform
                );
                const halfAlpha = mul(
                  splitGsplat(generator.outputs.gsplat).outputs.opacity,
                  dynoConst("float", 0.5)
                );
                const gsplat = combineGsplat({
                  gsplat: generator.outputs.gsplat,
                  center: centerSubView,
                  opacity: halfAlpha
                });
                const output = outputPackedSplat(
                  gsplat,
                  dynoConst("vec4", [0, 1, LN_SCALE_MIN, LN_SCALE_MAX])
                );
                roots.push(output);
              } else {
                throw new Error("Generator must be provided");
              }
            } else {
              let covsplat;
              if (covGenerator) {
                covsplat = covGenerator.outputs.covsplat;
              } else if (generator) {
                covsplat = gsplatToCovSplat(generator.outputs.gsplat);
              } else {
                throw new Error("Generator must be provided");
              }
              const centerSubView = sub(
                splitCovSplat(covsplat).outputs.center,
                _SplatAccumulator.viewCenterUniform
              );
              const halfAlpha = mul(
                splitCovSplat(covsplat).outputs.opacity,
                dynoConst("float", 0.5)
              );
              covsplat = combineCovSplat({
                covsplat,
                center: centerSubView,
                opacity: halfAlpha
              });
              const output = outputCovSplat(
                covsplat,
                dynoConst("vec4", [0, 1, LN_SCALE_MIN, LN_SCALE_MAX])
              );
              roots.push(output);
            }
            if (!generator) {
              throw new Error("Generator must be provided");
            }
          }
          if (generator) {
            const outputDepth = outputSplatDepth(
              generator.outputs.gsplat,
              _SplatAccumulator.viewCenterUniform,
              _SplatAccumulator.viewDirUniform,
              _SplatAccumulator.sortRadialUniform
            );
            roots.push(outputDepth);
          }
          if (covGenerator) {
            const outputDepth = outputCovSplatDepth(
              covGenerator.outputs.covsplat,
              _SplatAccumulator.viewCenterUniform,
              _SplatAccumulator.viewDirUniform,
              _SplatAccumulator.sortRadialUniform
            );
            roots.push(outputDepth);
          }
          return void 0;
        }
      );
      program = new DynoProgram({
        graph,
        inputs: { index: "_index" },
        outputs: {},
        template: this.extSplats ? _SplatAccumulator.programExtTemplate : _SplatAccumulator.programTemplate
        // consoleLog: true,
      });
      _SplatAccumulator.generatorProgram.set(theGenerator, program);
    }
    Object.assign(program.uniforms, {
      targetLayer: { value: 0 },
      targetBase: { value: 0 },
      targetCount: { value: 0 }
    });
    const material = program.prepareMaterial();
    _SplatAccumulator.fullScreenQuad.material = material;
    return { program, material };
  }
  generate({
    generator,
    covGenerator,
    base,
    count,
    renderer
  }) {
    if (!this.target) {
      throw new Error("Target must be initialized with ensureGenerate");
    }
    if (base + count > this.maxSplats) {
      throw new Error("Base + count exceeds maxSplats");
    }
    const { program, material } = this.prepareProgramMaterial(
      generator,
      covGenerator
    );
    program.update();
    const renderState = this.saveRenderState(renderer);
    const nextBase = Math.ceil((base + count) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    material.uniforms.targetBase.value = base;
    material.uniforms.targetCount.value = count;
    while (base < nextBase) {
      const layer = Math.floor(base / layerSize);
      material.uniforms.targetLayer.value = layer;
      const layerBase = layer * layerSize;
      const layerYStart = Math.floor((base - layerBase) / SPLAT_TEX_WIDTH);
      const layerYEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((nextBase - layerBase) / SPLAT_TEX_WIDTH)
      );
      this.target.scissor.set(
        0,
        layerYStart,
        SPLAT_TEX_WIDTH,
        layerYEnd - layerYStart
      );
      renderer.setRenderTarget(this.target, layer);
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      _SplatAccumulator.fullScreenQuad.render(renderer);
      base += SPLAT_TEX_WIDTH * (layerYEnd - layerYStart);
    }
    this.resetRenderState(renderer, renderState);
    return { nextBase };
  }
  prepareGenerate({
    renderer,
    scene,
    time,
    camera,
    sortRadial,
    renderSize,
    previous
  }) {
    var _a;
    this.viewToWorld.copy(camera.matrixWorld);
    camera.getWorldPosition(this.viewOrigin);
    camera.getWorldDirection(this.viewDirection);
    _SplatAccumulator.viewCenterUniform.value.copy(this.viewOrigin);
    _SplatAccumulator.viewDirUniform.value.copy(this.viewDirection);
    _SplatAccumulator.sortRadialUniform.value = sortRadial;
    this.time = time;
    this.deltaTime = time - previous.time;
    const allGenerators = [];
    scene.traverse((node) => {
      if (node instanceof SplatGenerator) {
        if (!camera.layers || camera.layers.test(node.layers)) {
          allGenerators.push(node);
        }
      }
    });
    const globalEditsSet = /* @__PURE__ */ new Set();
    scene.traverseVisible((node) => {
      if (node instanceof SplatEdit) {
        let ancestor = node.parent;
        while (ancestor != null && !(ancestor instanceof SplatMesh)) {
          ancestor = ancestor.parent;
        }
        if (ancestor == null) {
          globalEditsSet.add(node);
        }
      }
    });
    const globalEdits = Array.from(globalEditsSet);
    for (const object of allGenerators) {
      try {
        (_a = object.frameUpdate) == null ? void 0 : _a.call(object, {
          renderer,
          object,
          time: this.time,
          deltaTime: this.deltaTime,
          viewToWorld: this.viewToWorld,
          camera,
          renderSize,
          globalEdits
        });
      } catch (error) {
        console.error("frameUpdate error", error);
        object.generator = void 0;
        object.covGenerator = void 0;
        object.generatorError = error;
      }
    }
    const visibleGenerators = [];
    scene.traverseVisible((node) => {
      if (node instanceof SplatGenerator) {
        if (!camera.layers || camera.layers.test(node.layers)) {
          visibleGenerators.push(node);
        }
      }
    });
    const splatCounts = visibleGenerators.map(
      (generator) => generator.numSplats
    );
    const { maxSplats, mapping: baseCounts } = this.generateMapping(splatCounts);
    const previousMappings = previous.mapping.reduce((mappings, mapping) => {
      mappings.set(mapping.node, mapping);
      return mappings;
    }, /* @__PURE__ */ new Map());
    this.mapping = [];
    this.numSplats = 0;
    baseCounts.forEach(({ base, count }, index) => {
      const node = visibleGenerators[index];
      const previousNode = previousMappings.get(node);
      if (previousNode && previousNode.count !== node.numSplats) {
        node.updateMappingVersion();
      }
      const { generator, covGenerator } = node;
      if ((generator || covGenerator) && count > 0) {
        const { version, mappingVersion } = node;
        this.mapping.push({
          node,
          generator,
          covGenerator,
          version,
          mappingVersion,
          base,
          count
        });
        this.numSplats = Math.max(this.numSplats, base + count);
      }
    });
    const { splatsUpdated, mappingUpdated } = previous.checkVersions(
      this.mapping
    );
    this.version = previous.version + (splatsUpdated ? 1 : 0);
    this.mappingVersion = previous.mappingVersion + (mappingUpdated ? 1 : 0);
    return {
      sameMapping: !mappingUpdated,
      version: this.version,
      mappingVersion: this.mappingVersion,
      visibleGenerators,
      generate: () => {
        this.ensureGenerate({ maxSplats });
        for (const { node, base, count } of this.mapping) {
          const { generator, covGenerator } = node;
          if ((generator || covGenerator) && count > 0) {
            this.generate({ generator, covGenerator, base, count, renderer });
          }
        }
      },
      readback: async () => {
        const textures = this.getTextures();
        if (this.readbackSplats.length === 0) {
          this.readbackSplats = [
            new DynoUsampler2DArray({ value: textures[0], key: "extSplats" }),
            new DynoUsampler2DArray({ value: textures[1], key: "extSplats" })
          ];
        }
        this.readbackSplats[0].value = textures[0];
        this.readbackSplats[1].value = textures[1];
        if (!this.readback) {
          this.readback = new Readback({ renderer });
        }
        const readback = this.readback;
        const words = this.extSplats ? 8 : 4;
        const array = readback.ensureBuffer(
          this.numSplats * words,
          new Uint32Array(0)
        );
        const reader = dynoBlock(
          { index: "int" },
          { rgba8: "vec4" },
          ({ index }) => {
            const rgba8 = new Dyno({
              inTypes: {
                index: "int",
                extSplats1: "usampler2DArray",
                extSplats2: "usampler2DArray"
              },
              outTypes: { rgba8: "vec4" },
              inputs: {
                index,
                extSplats1: this.readbackSplats[0],
                extSplats2: this.readbackSplats[1]
              },
              statements: ({ inputs, outputs }) => {
                if (this.extSplats) {
                  return unindentLines(`
                    int indexDiv8 = ${inputs.index} >> 3;
                    ivec3 coord = splatTexCoord(indexDiv8);
                    uvec4 packedData;
                    if ((${inputs.index} & 4) == 0) {
                      packedData = texelFetch(${inputs.extSplats1}, coord, 0);
                    } else {
                      packedData = texelFetch(${inputs.extSplats2}, coord, 0);
                    }

                    int indexMod4 = ${inputs.index} & 3;
                    uint data = (indexMod4 == 0) ? packedData.x
                      : (indexMod4 == 1) ? packedData.y
                      : (indexMod4 == 2) ? packedData.z
                      : packedData.w;
                    ${outputs.rgba8} = uintToVec4(data);
                  `);
                }
                return unindentLines(`
                  int indexDiv4 = ${inputs.index} >> 2;
                  ivec3 coord = splatTexCoord(indexDiv4);
                  uvec4 packedData = texelFetch(${inputs.extSplats1}, coord, 0);

                  int indexMod4 = ${inputs.index} & 3;
                  uint data = (indexMod4 == 0) ? packedData.x
                    : (indexMod4 == 1) ? packedData.y
                    : (indexMod4 == 2) ? packedData.z
                    : packedData.w;
                  ${outputs.rgba8} = uintToVec4(data);
                `);
              }
            }).outputs.rgba8;
            return { rgba8 };
          }
        );
        return await readback.renderReadback({
          reader,
          count: this.numSplats * words,
          renderer,
          readback: array
        });
      }
    };
  }
  // Check if this accumulator has exactly the same generator mapping as
  // the previous one. If so, we can reuse the Gsplat sort order.
  checkVersions(otherMapping) {
    if (this.mapping.length !== otherMapping.length) {
      return { splatsUpdated: true, mappingUpdated: true };
    }
    const mappingUpdated = this.mapping.some((item, i) => {
      const other = otherMapping[i];
      return item.node !== other.node || item.base !== other.base || item.count !== other.count || item.mappingVersion !== other.mappingVersion;
    });
    if (mappingUpdated) {
      return { splatsUpdated: true, mappingUpdated: true };
    }
    const splatsUpdated = this.mapping.some((item, i) => {
      return item.version !== otherMapping[i].version;
    });
    return { splatsUpdated, mappingUpdated };
  }
};
_SplatAccumulator.viewCenterUniform = new DynoVec3({ value: new THREE__namespace.Vector3() });
_SplatAccumulator.viewDirUniform = new DynoVec3({ value: new THREE__namespace.Vector3() });
_SplatAccumulator.sortRadialUniform = new DynoBool({ value: true });
_SplatAccumulator.emptyTexture = (() => {
  const { width, height, depth, maxSplats } = getTextureSize(1);
  const emptyArray = new Uint32Array(maxSplats * 4);
  const texture2 = new THREE__namespace.DataArrayTexture(
    emptyArray,
    width,
    height,
    depth
  );
  texture2.format = THREE__namespace.RGBAIntegerFormat;
  texture2.type = THREE__namespace.UnsignedIntType;
  texture2.internalFormat = "RGBA32UI";
  texture2.needsUpdate = true;
  return texture2;
})();
_SplatAccumulator.emptyTextures = (() => {
  return [_SplatAccumulator.emptyTexture, _SplatAccumulator.emptyTexture];
})();
_SplatAccumulator.programExtTemplate = new DynoProgramTemplate(
  getShaders().computeUvec4x2Vec4Template
);
_SplatAccumulator.programTemplate = new DynoProgramTemplate(
  getShaders().computeUvec4Vec4Template
);
_SplatAccumulator.generatorProgram = /* @__PURE__ */ new WeakMap();
_SplatAccumulator.fullScreenQuad = new Pass_js.FullScreenQuad(
  new THREE__namespace.RawShaderMaterial({ visible: false })
);
let SplatAccumulator = _SplatAccumulator;
class SplatGeometry extends THREE__namespace.InstancedBufferGeometry {
  constructor() {
    super();
    this.setAttribute("position", new THREE__namespace.BufferAttribute(QUAD_VERTICES, 3));
    this.setIndex(new THREE__namespace.BufferAttribute(QUAD_INDICES, 1));
  }
}
const QUAD_VERTICES = new Float32Array([
  -1,
  -1,
  0,
  1,
  -1,
  0,
  1,
  1,
  0,
  -1,
  1,
  0
]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);
const _SparkRenderer = class _SparkRenderer extends THREE__namespace.Mesh {
  constructor(options) {
    if (!options) {
      throw new Error("SparkRenderer options are required");
    }
    if (!options.renderer) {
      throw new Error("renderer is required in SparkRenderer options");
    }
    const uniforms = _SparkRenderer.makeUniforms();
    Object.assign(uniforms, options.extraUniforms ?? {});
    const shaders2 = getShaders();
    const premultipliedAlpha = options.premultipliedAlpha ?? true;
    const geometry = new SplatGeometry();
    const material = new THREE__namespace.ShaderMaterial({
      glslVersion: THREE__namespace.GLSL3,
      vertexShader: options.vertexShader ?? shaders2.splatVertex,
      fragmentShader: options.fragmentShader ?? shaders2.splatFragment,
      uniforms,
      premultipliedAlpha,
      transparent: options.transparent ?? true,
      depthTest: options.depthTest ?? true,
      depthWrite: options.depthWrite ?? false,
      side: THREE__namespace.DoubleSide,
      allowOverride: false
    });
    super(geometry, material);
    this.renderSize = new THREE__namespace.Vector2();
    this.lastFrame = -1;
    this.updateTimeoutId = -1;
    this.orderingTexture = null;
    this.maxSplats = 0;
    this.activeSplats = 0;
    this.accumulators = [];
    this.sorting = false;
    this.sortDirty = false;
    this.lastSortTime = 0;
    this.sortWorker = null;
    this.sortTimeoutId = -1;
    this.sortedCenter = new THREE__namespace.Vector3().setScalar(Number.NEGATIVE_INFINITY);
    this.sortedDir = new THREE__namespace.Vector3().setScalar(0);
    this.readback32 = new Uint32Array(0);
    this.superXY = 1;
    this.flushAfterGenerate = false;
    this.flushAfterRead = false;
    this.readPause = 1;
    this.sortPause = 0;
    this.sortDelay = 0;
    this.material = material;
    this.uniforms = uniforms;
    this.frustumCulled = false;
    this.renderer = options.renderer;
    this.onDirty = options.onDirty;
    this.dirty = true;
    this.autoUpdate = options.autoUpdate ?? true;
    this.preUpdate = options.preUpdate ?? true;
    this.maxStdDev = options.maxStdDev ?? Math.sqrt(8);
    this.minPixelRadius = options.minPixelRadius ?? 0;
    this.maxPixelRadius = options.maxPixelRadius ?? 512;
    this.accumExtSplats = options.accumExtSplats ?? false;
    this.covSplats = options.covSplats ?? false;
    this.minAlpha = options.minAlpha ?? 0.5 * (1 / 255);
    this.enable2DGS = options.enable2DGS ?? false;
    this.preBlurAmount = options.preBlurAmount ?? 0;
    this.blurAmount = options.blurAmount ?? 0.3;
    this.focalDistance = options.focalDistance ?? 0;
    this.apertureAngle = options.apertureAngle ?? 0;
    this.falloff = options.falloff ?? 1;
    this.clipXY = options.clipXY ?? 1.4;
    this.focalAdjustment = options.focalAdjustment ?? 1;
    this.encodeLinear = options.encodeLinear ?? false;
    this.sortRadial = options.sortRadial ?? true;
    this.minSortIntervalMs = options.minSortIntervalMs ?? 0;
    this.clock = options.clock ? cloneClock(options.clock) : new THREE__namespace.Clock();
    const accumulatorOptions = {
      extSplats: this.accumExtSplats,
      covSplats: this.covSplats
    };
    this.display = new SplatAccumulator(accumulatorOptions);
    this.current = this.display;
    this.accumulators.push(new SplatAccumulator(accumulatorOptions));
    this.accumulators.push(new SplatAccumulator(accumulatorOptions));
    if (options.target) {
      const {
        width,
        height,
        doubleBuffer,
        superXY: origSuperXY,
        ...origTargetOptions
      } = options.target;
      const superXY = Math.max(1, Math.min(4, origSuperXY ?? 1));
      if (width * superXY > 8192 || height * superXY > 8192) {
        throw new Error("Target size too large");
      }
      this.superXY = superXY;
      const superWidth = width * superXY;
      const superHeight = height * superXY;
      const targetOptions = {
        format: THREE__namespace.RGBAFormat,
        type: THREE__namespace.UnsignedByteType,
        colorSpace: THREE__namespace.SRGBColorSpace,
        ...origTargetOptions
      };
      this.target = new THREE__namespace.WebGLRenderTarget(
        superWidth,
        superHeight,
        targetOptions
      );
      if (doubleBuffer) {
        this.backTarget = new THREE__namespace.WebGLRenderTarget(
          superWidth,
          superHeight,
          targetOptions
        );
      }
      this.encodeLinear = options.encodeLinear ?? true;
    }
  }
  static makeUniforms() {
    const uniforms = {
      // // number of active splats to render
      // numSplats: { value: 0 },
      // Size of render viewport in pixels
      renderSize: { value: new THREE__namespace.Vector2() },
      // Near and far plane distances
      near: { value: 0.1 },
      far: { value: 1e3 },
      // SplatAccumulator to view transformation quaternion
      renderToViewQuat: { value: new THREE__namespace.Quaternion() },
      // SplatAccumulator to view transformation translation
      renderToViewPos: { value: new THREE__namespace.Vector3() },
      renderToViewBasis: { value: new THREE__namespace.Matrix3() },
      renderToViewOffset: { value: new THREE__namespace.Vector3() },
      // Maximum distance (in stddevs) from Gsplat center to render
      maxStdDev: { value: 1 },
      // Minimum pixel radius for splat rendering
      minPixelRadius: { value: 0 },
      // Maximum pixel radius for splat rendering
      maxPixelRadius: { value: 512 },
      // Minimum alpha value for splat rendering
      minAlpha: { value: 0.5 * (1 / 255) },
      // Enable interpreting 0-thickness Gsplats as 2DGS
      enable2DGS: { value: false },
      // Enable ray-splat max response evaluation
      // enableRayEval: { value: false },
      // Add to projected 2D splat covariance diagonal (thickens and brightens)
      preBlurAmount: { value: 0 },
      // Add to 2D splat covariance diagonal and adjust opacity (anti-aliasing)
      blurAmount: { value: 0.3 },
      // Depth-of-field distance to focal plane
      focalDistance: { value: 0 },
      // Full-width angle of aperture opening (in radians)
      apertureAngle: { value: 0 },
      // Modulate Gaussian kernal falloff. 0 means "no falloff, flat shading",
      // 1 is normal e^-x^2 falloff.
      falloff: { value: 1 },
      // Clip Gsplats that are clipXY times beyond the +-1 frustum bounds
      clipXY: { value: 1.4 },
      // Debug renderSize scale factor
      focalAdjustment: { value: 1 },
      // Whether to encode Gsplat with linear RGB (for environment mapping)
      encodeLinear: { value: false },
      // Back-to-front sort ordering of splat indices
      ordering: { type: "t", value: _SparkRenderer.emptyOrdering },
      enableExtSplats: { value: false },
      enableCovSplats: { value: false },
      // Gsplat collection to render
      extSplats: { type: "t", value: SplatAccumulator.emptyTexture },
      extSplats2: { type: "t", value: SplatAccumulator.emptyTexture },
      // Time in seconds for time-based effects
      time: { value: 0 },
      // Delta time in seconds since last frame
      deltaTime: { value: 0 },
      // Debug flag that alternates each frame
      debugFlag: { value: false }
    };
    return uniforms;
  }
  dispose() {
    if (this.target) {
      this.target.dispose();
      this.target = void 0;
    }
    if (this.backTarget) {
      this.backTarget.dispose();
      this.backTarget = void 0;
    }
    if (this.orderingTexture) {
      this.orderingTexture.dispose();
      this.orderingTexture = null;
    }
    const accumulators = /* @__PURE__ */ new Set();
    accumulators.add(this.display);
    accumulators.add(this.current);
    for (const accumulator of this.accumulators) {
      accumulators.add(accumulator);
    }
    for (const accumulator of accumulators) {
      accumulator.dispose();
    }
    if (this.sortWorker) {
      this.sortWorker.dispose();
      this.sortWorker = null;
    }
  }
  setDirty() {
    var _a;
    if (!this.dirty) {
      this.dirty = true;
      (_a = this.onDirty) == null ? void 0 : _a.call(this);
    }
  }
  onBeforeRender(renderer, scene, camera) {
    var _a;
    const spark = _SparkRenderer.sparkOverride ?? this;
    const frame = renderer.info.render.frame;
    const isNewFrame = frame !== spark.lastFrame;
    spark.lastFrame = frame;
    if (spark.target) {
      spark.renderSize.set(spark.target.width, spark.target.height);
    } else {
      const renderSize = renderer.getDrawingBufferSize(spark.renderSize);
      if (renderer.xr.isPresenting) {
        if (renderSize.x === 1 && renderSize.y === 1) {
          const baseLayer = (_a = renderer.xr.getSession()) == null ? void 0 : _a.renderState.baseLayer;
          if (baseLayer) {
            renderSize.x = baseLayer.framebufferWidth;
            renderSize.y = baseLayer.framebufferHeight;
          }
        }
      }
    }
    this.uniforms.renderSize.value.copy(spark.renderSize);
    const typedCamera = camera;
    this.uniforms.near.value = typedCamera.near;
    this.uniforms.far.value = typedCamera.far;
    const geometry = this.geometry;
    geometry.instanceCount = spark.activeSplats;
    const accumToWorld = new THREE__namespace.Matrix4();
    if (!this.display.extSplats) {
      accumToWorld.makeTranslation(spark.display.viewOrigin);
    }
    const cameraToWorld = camera.matrixWorld.clone();
    const worldToCamera = cameraToWorld.invert();
    const accumToCamera = worldToCamera.multiply(accumToWorld);
    accumToCamera.decompose(
      this.uniforms.renderToViewPos.value,
      this.uniforms.renderToViewQuat.value,
      new THREE__namespace.Vector3()
    );
    this.uniforms.renderToViewBasis.value.setFromMatrix4(accumToCamera);
    this.uniforms.maxStdDev.value = spark.maxStdDev;
    this.uniforms.minPixelRadius.value = spark.minPixelRadius;
    this.uniforms.maxPixelRadius.value = spark.maxPixelRadius;
    this.uniforms.minAlpha.value = spark.minAlpha;
    this.uniforms.enable2DGS.value = spark.enable2DGS;
    this.uniforms.preBlurAmount.value = spark.preBlurAmount;
    this.uniforms.blurAmount.value = spark.blurAmount;
    this.uniforms.focalDistance.value = spark.focalDistance;
    this.uniforms.apertureAngle.value = spark.apertureAngle;
    this.uniforms.falloff.value = spark.falloff;
    this.uniforms.clipXY.value = spark.clipXY;
    this.uniforms.focalAdjustment.value = spark.focalAdjustment;
    this.uniforms.encodeLinear.value = spark.encodeLinear;
    this.uniforms.ordering.value = spark.orderingTexture ?? _SparkRenderer.emptyOrdering;
    this.uniforms.enableExtSplats.value = this.display.extSplats;
    this.uniforms.enableCovSplats.value = this.display.covSplats;
    if (this.display.extSplats) {
      const extSplats = spark.display.getTextures();
      this.uniforms.extSplats.value = extSplats[0];
      this.uniforms.extSplats2.value = extSplats[1];
    } else {
      const packedSplats = spark.display.getTextures();
      this.uniforms.extSplats.value = packedSplats[0];
      this.uniforms.extSplats2.value = packedSplats[0];
    }
    this.uniforms.time.value = spark.display.time;
    this.uniforms.deltaTime.value = spark.display.deltaTime;
    this.uniforms.debugFlag.value = performance.now() / 1e3 % 2 < 1;
    if (spark.autoUpdate && isNewFrame) {
      const preUpdate = spark.preUpdate && !renderer.xr.isPresenting;
      const useCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
      if (preUpdate) {
        spark.updateInternal({
          scene,
          camera: useCamera,
          autoUpdate: true
        });
      } else {
        if (spark.updateTimeoutId === -1) {
          spark.updateTimeoutId = setTimeout(() => {
            spark.updateTimeoutId = -1;
            spark.updateInternal({
              scene,
              camera: useCamera,
              autoUpdate: true
            });
          }, 1);
        }
      }
    }
    spark.dirty = false;
  }
  clearSplats() {
    this.activeSplats = 0;
    this.display.numSplats = 0;
    this.setDirty();
  }
  async update({
    scene,
    camera
  }) {
    await this.updateInternal({ scene, camera, autoUpdate: false });
  }
  async updateInternal({
    scene,
    camera,
    autoUpdate
  }) {
    const renderer = this.renderer;
    const time = this.time ?? this.clock.getElapsedTime();
    const center = camera.getWorldPosition(new THREE__namespace.Vector3());
    const dir = camera.getWorldDirection(new THREE__namespace.Vector3());
    const viewChanged = center.distanceTo(this.sortedCenter) > 1e-3 || dir.dot(this.sortedDir) < 0.999;
    const next = this.accumulators.pop();
    if (!next) {
      throw new Error("No next accumulator");
    }
    if (next === this.current) {
      throw new Error(
        "Next accumulator is the same as the current accumulator"
      );
    }
    const { version, mappingVersion, generate } = next.prepareGenerate({
      renderer,
      scene,
      time,
      camera,
      sortRadial: this.sortRadial ?? true,
      renderSize: this.renderSize,
      previous: this.current
    });
    let doUpdate = true;
    const needsUpdate = viewChanged || version !== this.current.version;
    const mappingUpdated = mappingVersion !== this.display.mappingVersion;
    if (autoUpdate && !needsUpdate) {
      doUpdate = false;
    }
    if (mappingUpdated && this.sorting) {
      doUpdate = false;
    }
    if (!doUpdate) {
      this.accumulators.push(next);
    } else {
      generate();
      if (this.flushAfterGenerate) {
        const gl = renderer.getContext();
        gl.flush();
      }
      if (this.display.mappingVersion === next.mappingVersion) {
        this.accumulators.push(this.display);
        this.display = next;
      } else {
        if (this.display !== this.current) {
          this.accumulators.push(this.current);
        }
      }
      this.current = next;
      this.sortDirty = true;
      this.setDirty();
    }
    await this.driveSort();
  }
  async driveSort() {
    if (this.sorting || !this.sortDirty) {
      return;
    }
    if (this.sortTimeoutId !== -1) {
      clearTimeout(this.sortTimeoutId);
      this.sortTimeoutId = -1;
    }
    const now = performance.now();
    const nextSortTime = this.lastSortTime ? this.lastSortTime + this.minSortIntervalMs : now;
    if (now < nextSortTime) {
      this.sortTimeoutId = setTimeout(() => {
        this.sortTimeoutId = -1;
        this.driveSort();
      }, nextSortTime - now);
      return;
    }
    this.sorting = true;
    this.sortDirty = false;
    this.lastSortTime = now;
    if (this.readPause > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.readPause));
    }
    const current = this.current;
    this.sortedCenter.copy(current.viewOrigin);
    this.sortedDir.copy(current.viewDirection);
    const { numSplats, maxSplats } = current;
    const rows = Math.max(1, Math.ceil(maxSplats / 16384));
    const orderingMaxSplats = rows * 16384;
    this.maxSplats = Math.max(this.maxSplats, orderingMaxSplats);
    const ordering = new Uint32Array(this.maxSplats);
    const readback = Readback.ensureBuffer(maxSplats, this.readback32);
    this.readback32 = readback;
    await this.readbackDepth({
      current,
      renderer: this.renderer,
      numSplats,
      readback
    });
    if (this.sortPause > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sortPause));
    }
    if (!this.sortWorker) {
      this.sortWorker = new SplatWorker();
    }
    const result = await this.sortWorker.call("sortSplats32", {
      numSplats,
      readback,
      ordering
    });
    if (this.sortDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sortDelay));
    }
    this.readback32 = result.readback;
    this.activeSplats = result.activeSplats;
    if (this.orderingTexture) {
      if (rows > this.orderingTexture.image.height) {
        this.orderingTexture.dispose();
        this.orderingTexture = null;
      }
    }
    if (!this.orderingTexture) {
      const orderingTexture = new THREE__namespace.DataTexture(
        result.ordering,
        4096,
        rows,
        THREE__namespace.RGBAIntegerFormat,
        THREE__namespace.UnsignedIntType
      );
      orderingTexture.internalFormat = "RGBA32UI";
      orderingTexture.needsUpdate = true;
      this.orderingTexture = orderingTexture;
    } else {
      const renderer = this.renderer;
      const gl = renderer.getContext();
      if (!renderer.properties.has(this.orderingTexture)) {
        this.orderingTexture.needsUpdate = true;
      } else {
        const props = renderer.properties.get(this.orderingTexture);
        const glTexture = props.__webglTexture;
        if (!glTexture) {
          throw new Error("ordering texture not found");
        }
        renderer.state.activeTexture(gl.TEXTURE0);
        renderer.state.bindTexture(gl.TEXTURE_2D, glTexture);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          4096,
          rows,
          gl.RGBA_INTEGER,
          gl.UNSIGNED_INT,
          // data,
          result.ordering
        );
        renderer.state.bindTexture(gl.TEXTURE_2D, null);
      }
    }
    if (this.current.mappingVersion === current.mappingVersion) {
      if (this.current.mappingVersion !== this.display.mappingVersion) {
        this.accumulators.push(this.display);
        this.display = this.current;
      }
    }
    this.sorting = false;
    this.setDirty();
    this.driveSort();
  }
  async readbackDepth({
    current,
    renderer,
    numSplats,
    readback
  }) {
    if (!renderer) {
      throw new Error("No renderer");
    }
    if (!current.target) {
      throw new Error("No target");
    }
    const roundedCount = Math.ceil(numSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    if (readback.byteLength < roundedCount * 4) {
      throw new Error(
        `Readback buffer too small: ${readback.byteLength} < ${roundedCount * 4}`
      );
    }
    const readbackUint8 = new Uint8Array(readback.buffer);
    const renderState = this.saveRenderState(renderer);
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    let baseIndex = 0;
    const promises = [];
    while (baseIndex < numSplats) {
      const layer = Math.floor(baseIndex / layerSize);
      const layerBase = layer * layerSize;
      const layerYEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((numSplats - layerBase) / SPLAT_TEX_WIDTH)
      );
      const readbackSize = SPLAT_TEX_WIDTH * layerYEnd * 4;
      const subReadback = readbackUint8.subarray(
        layerBase * 4,
        layerBase * 4 + readbackSize
      );
      renderer.setRenderTarget(current.target, layer);
      const promise = renderer.readRenderTargetPixelsAsync(
        current.target,
        0,
        0,
        SPLAT_TEX_WIDTH,
        layerYEnd,
        subReadback,
        void 0,
        current.extSplats ? 2 : 1
      );
      promises.push(promise);
      if (this.flushAfterRead) {
        const gl = renderer.getContext();
        gl.flush();
      }
      baseIndex += SPLAT_TEX_WIDTH * layerYEnd;
    }
    this.resetRenderState(renderer, renderState);
    return Promise.all(promises).then(() => readback);
  }
  saveRenderState(renderer) {
    return {
      target: renderer.getRenderTarget(),
      xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear
    };
  }
  resetRenderState(renderer, state) {
    renderer.setRenderTarget(state.target);
    renderer.xr.enabled = state.xrEnabled;
    renderer.autoClear = state.autoClear;
  }
  render(scene, camera) {
    try {
      _SparkRenderer.sparkOverride = this;
      this.renderer.render(scene, camera);
    } finally {
      _SparkRenderer.sparkOverride = void 0;
    }
  }
  renderTarget({
    scene,
    camera
  }) {
    const target = this.backTarget ?? this.target;
    if (!target) {
      throw new Error("No target");
    }
    const previousTarget = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(target);
      _SparkRenderer.sparkOverride = this;
      this.renderer.render(scene, camera);
    } finally {
      _SparkRenderer.sparkOverride = void 0;
      this.renderer.setRenderTarget(previousTarget);
    }
    if (target !== this.target) {
      [this.target, this.backTarget] = [this.backTarget, this.target];
    }
    return target;
  }
  // Read back the previously rendered target image as a Uint8Array of packed
  // RGBA values (in that order). Subsequent calls to this.readTarget()
  // will reuse the same buffers to minimize memory allocations.
  async readTarget() {
    if (!this.target) {
      throw new Error("Must initialize with target");
    }
    const { width, height } = this.target;
    const byteSize = width * height * 4;
    if (!this.superPixels || this.superPixels.length < byteSize) {
      this.superPixels = new Uint8Array(byteSize);
    }
    const superPixels = this.superPixels;
    await this.renderer.readRenderTargetPixelsAsync(
      this.target,
      0,
      0,
      width,
      height,
      superPixels
    );
    const { superXY } = this;
    if (superXY === 1) {
      return superPixels;
    }
    const subWidth = width / superXY;
    const subHeight = height / superXY;
    const subSize = subWidth * subHeight * 4;
    if (!this.targetPixels || this.targetPixels.length < subSize) {
      this.targetPixels = new Uint8Array(subSize);
    }
    const targetPixels = this.targetPixels;
    const super2 = superXY * superXY;
    for (let y = 0; y < subHeight; y++) {
      const row = y * subWidth;
      for (let x = 0; x < subWidth; x++) {
        const superCol = x * superXY;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < superXY; sy++) {
          const superRow = (y * superXY + sy) * width;
          for (let sx = 0; sx < superXY; sx++) {
            const superIndex = (superRow + superCol + sx) * 4;
            r += superPixels[superIndex];
            g += superPixels[superIndex + 1];
            b += superPixels[superIndex + 2];
            a += superPixels[superIndex + 3];
          }
        }
        const pixelIndex = (row + x) * 4;
        targetPixels[pixelIndex] = r / super2;
        targetPixels[pixelIndex + 1] = g / super2;
        targetPixels[pixelIndex + 2] = b / super2;
        targetPixels[pixelIndex + 3] = a / super2;
      }
    }
    return targetPixels;
  }
  async renderReadTarget({
    scene,
    camera
  }) {
    this.renderTarget({ scene, camera });
    return this.readTarget();
  }
  // Renders out the scene to a cube map that can be used for
  // Image-based lighting or similar applications. First optionally updates Gsplats,
  // sorts them with respect to the provided worldCenter, renders 6 cube faces.
  async renderCubeMap({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1e3,
    hideObjects = [],
    update = true,
    filter = false
  }) {
    if (!_SparkRenderer.cubeRender || _SparkRenderer.cubeRender.target.width !== size || _SparkRenderer.cubeRender.near !== near || _SparkRenderer.cubeRender.far !== far) {
      if (_SparkRenderer.cubeRender) {
        _SparkRenderer.cubeRender.target.dispose();
      }
      const target2 = new THREE__namespace.WebGLCubeRenderTarget(size, {
        format: THREE__namespace.RGBAFormat,
        type: THREE__namespace.UnsignedByteType,
        generateMipmaps: filter,
        minFilter: filter ? THREE__namespace.LinearMipMapLinearFilter : THREE__namespace.LinearFilter,
        magFilter: THREE__namespace.LinearFilter,
        colorSpace: filter ? THREE__namespace.LinearSRGBColorSpace : THREE__namespace.SRGBColorSpace
      });
      const cubeCamera2 = new THREE__namespace.CubeCamera(near, far, target2);
      _SparkRenderer.cubeRender = { target: target2, cubeCamera: cubeCamera2, near, far };
    }
    const { target, cubeCamera } = _SparkRenderer.cubeRender;
    cubeCamera.position.copy(worldCenter);
    const objectVisibility = /* @__PURE__ */ new Map();
    for (const object of hideObjects) {
      objectVisibility.set(object, object.visible);
      object.visible = false;
    }
    if (update) {
      const tempCamera = new THREE__namespace.Camera();
      tempCamera.position.copy(worldCenter);
      await this.update({ scene, camera: tempCamera });
    }
    try {
      _SparkRenderer.sparkOverride = this;
      cubeCamera.update(this.renderer, scene);
    } finally {
      _SparkRenderer.sparkOverride = void 0;
    }
    for (const [object, visible] of objectVisibility.entries()) {
      object.visible = visible;
    }
    return target.texture;
  }
  async readCubeTargets() {
    if (!_SparkRenderer.cubeRender) {
      throw new Error("No cube render");
    }
    const textures = _SparkRenderer.cubeRender.target.texture;
    const promises = [];
    const buffers = [];
    for (let i = 0; i < textures.images.length; ++i) {
      const { width, height } = textures.images[i];
      const byteSize = width * height * 4;
      const readback = new Uint8Array(byteSize);
      buffers.push(readback);
      const promise = this.renderer.readRenderTargetPixelsAsync(
        _SparkRenderer.cubeRender.target,
        0,
        0,
        width,
        height,
        readback,
        i
      );
      promises.push(promise);
    }
    await Promise.all(promises);
    return buffers;
  }
  // Renders out the scene to an environment map that can be used for
  // Image-based lighting or similar applications. First optionally updates Gsplats,
  // sorts them with respect to the provided worldCenter, renders 6 cube faces,
  // then pre-filters them using THREE.PMREMGenerator and returns a THREE.Texture
  // that can assigned directly to a THREE.MeshStandardMaterial.envMap property.
  async renderEnvMap({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1e3,
    hideObjects = [],
    update = true
  }) {
    var _a;
    const cubeTexture = await this.renderCubeMap({
      scene,
      worldCenter,
      size,
      near,
      far,
      hideObjects,
      update,
      filter: true
    });
    if (!_SparkRenderer.pmrem) {
      _SparkRenderer.pmrem = new THREE__namespace.PMREMGenerator(this.renderer);
    }
    return (_a = _SparkRenderer.pmrem) == null ? void 0 : _a.fromCubemap(cubeTexture).texture;
  }
  // Utility function to recursively set the envMap property for any
  // THREE.MeshStandardMaterial within the subtree of root.
  recurseSetEnvMap(root, envMap) {
    root.traverse((node) => {
      if (node instanceof THREE__namespace.Mesh) {
        if (Array.isArray(node.material)) {
          for (const material of node.material) {
            if (material instanceof THREE__namespace.MeshStandardMaterial) {
              material.envMap = envMap;
            }
          }
        } else {
          if (node.material instanceof THREE__namespace.MeshStandardMaterial) {
            node.material.envMap = envMap;
          }
        }
      }
    });
  }
  get premultipliedAlpha() {
    return this.material.premultipliedAlpha;
  }
  set premultipliedAlpha(value) {
    if (this.material.premultipliedAlpha !== value) {
      this.material.premultipliedAlpha = value;
      this.material.needsUpdate = true;
    }
  }
};
_SparkRenderer.emptyOrdering = (() => {
  const numIndices = 4 * 4096 * 1;
  const emptyArray = new Uint32Array(numIndices);
  const texture2 = new THREE__namespace.DataTexture(emptyArray, 4096, 1);
  texture2.format = THREE__namespace.RGBAIntegerFormat;
  texture2.type = THREE__namespace.UnsignedIntType;
  texture2.internalFormat = "RGBA32UI";
  texture2.needsUpdate = true;
  return texture2;
})();
_SparkRenderer.cubeRender = null;
_SparkRenderer.pmrem = null;
let SparkRenderer = _SparkRenderer;
var SplatSkinningMode = /* @__PURE__ */ ((SplatSkinningMode2) => {
  SplatSkinningMode2["DUAL_QUATERNION"] = "dual_quaternion";
  SplatSkinningMode2["LINEAR_BLEND"] = "linear_blend";
  return SplatSkinningMode2;
})(SplatSkinningMode || {});
const _SplatSkinning = class _SplatSkinning {
  constructor(options) {
    this.mesh = options.mesh;
    this.numSplats = options.numSplats ?? this.mesh.numSplats;
    this.mode = options.mode ?? "dual_quaternion";
    const { width, height, depth, maxSplats } = getTextureSize(this.numSplats);
    this.skinData = new Uint16Array(maxSplats * 4);
    this.skinTexture = new THREE__namespace.DataArrayTexture(
      this.skinData,
      width,
      height,
      depth
    );
    this.skinTexture.format = THREE__namespace.RGBAIntegerFormat;
    this.skinTexture.type = THREE__namespace.UnsignedShortType;
    this.skinTexture.internalFormat = "RGBA16UI";
    this.skinTexture.needsUpdate = true;
    this.numBones = options.numBones ?? 256;
    this.boneData = new Float32Array(this.numBones * 16);
    this.boneTexture = new THREE__namespace.DataTexture(
      this.boneData,
      4,
      this.numBones,
      THREE__namespace.RGBAFormat,
      THREE__namespace.FloatType
    );
    this.boneTexture.internalFormat = "RGBA32F";
    this.boneTexture.needsUpdate = true;
    this.boneRestQuatPosScale = newArray(this.numBones, () => ({
      quat: new THREE__namespace.Quaternion(),
      pos: new THREE__namespace.Vector3(),
      scale: new THREE__namespace.Vector3()
    }));
    if (this.mode === "linear_blend") {
      this.boneRestInvMats = newArray(this.numBones, () => new THREE__namespace.Matrix4());
    } else {
      this.boneRestInvMats = [];
    }
    this.uniform = new DynoUniform({
      key: "skinning",
      type: GsplatSkinning,
      globals: () => [defineGsplatSkinning],
      value: {
        numSplats: this.numSplats,
        numBones: this.numBones,
        skinTexture: this.skinTexture,
        boneTexture: this.boneTexture
      }
    });
  }
  // Apply the skeletal animation to a Gsplat in a dyno program.
  modify(gsplat) {
    if (this.mode === "linear_blend") {
      throw new Error("Linear blend skinning requires covSplats=true");
    }
    return applyGsplatSkinning(gsplat, this.uniform);
  }
  modifyCov(covsplat) {
    if (this.mode === "dual_quaternion") {
      return applyCovSplatDQSkinning(covsplat, this.uniform);
    }
    return applyCovSplatLBSkinning(covsplat, this.uniform);
  }
  // Set the "rest" pose for a bone with position and quaternion orientation.
  setRestQuatPos(boneIndex, quat, pos) {
    this.boneRestQuatPosScale[boneIndex].quat.copy(quat);
    this.boneRestQuatPosScale[boneIndex].pos.copy(pos);
    this.boneRestQuatPosScale[boneIndex].scale.copy(_SplatSkinning.UNIT_SCALE);
    if (this.mode === "linear_blend") {
      this.boneRestInvMats[boneIndex].compose(pos, quat, _SplatSkinning.UNIT_SCALE).invert();
    }
    this.setBoneQuatPos(boneIndex, quat, pos);
  }
  getRestQuatPos(boneIndex, quat, pos) {
    quat.copy(this.boneRestQuatPosScale[boneIndex].quat);
    pos.copy(this.boneRestQuatPosScale[boneIndex].pos);
  }
  setRestQuatPosScale(boneIndex, quat, pos, scale) {
    this.boneRestQuatPosScale[boneIndex].quat.copy(quat);
    this.boneRestQuatPosScale[boneIndex].pos.copy(pos);
    this.boneRestQuatPosScale[boneIndex].scale.copy(scale);
    if (this.mode === "linear_blend") {
      this.boneRestInvMats[boneIndex].compose(pos, quat, scale).invert();
    }
    this.setBoneQuatPosScale(boneIndex, quat, pos, scale);
  }
  getRestQuatPosScale(boneIndex, quat, pos, scale) {
    quat.copy(this.boneRestQuatPosScale[boneIndex].quat);
    pos.copy(this.boneRestQuatPosScale[boneIndex].pos);
    scale.copy(this.boneRestQuatPosScale[boneIndex].scale);
  }
  setRestMatrix(boneIndex, matrix) {
    if (this.mode !== "linear_blend") {
      throw new Error("setRestMat only supported for linear blend skinning");
    }
    this.boneRestInvMats[boneIndex].copy(matrix).invert();
    this.setBoneMatrix(boneIndex, matrix);
  }
  getRestMatrix(boneIndex, matrix) {
    if (this.mode !== "linear_blend") {
      throw new Error("getRestMat only supported for linear blend skinning");
    }
    matrix.copy(this.boneRestInvMats[boneIndex]).invert();
  }
  // Set the "current" position and orientation of a bone.
  setBoneQuatPos(boneIndex, quat, pos) {
    if (this.mode === "dual_quaternion") {
      _SplatSkinning.relQuat.copy(this.boneRestQuatPosScale[boneIndex].quat).invert();
      _SplatSkinning.relPos.copy(pos).sub(this.boneRestQuatPosScale[boneIndex].pos);
      _SplatSkinning.relQuat.multiply(quat);
      _SplatSkinning.dual.set(
        _SplatSkinning.relPos.x,
        _SplatSkinning.relPos.y,
        _SplatSkinning.relPos.z,
        0
      ).multiply(_SplatSkinning.relQuat);
      const i16 = boneIndex * 16;
      this.boneData[i16 + 0] = _SplatSkinning.relQuat.x;
      this.boneData[i16 + 1] = _SplatSkinning.relQuat.y;
      this.boneData[i16 + 2] = _SplatSkinning.relQuat.z;
      this.boneData[i16 + 3] = _SplatSkinning.relQuat.w;
      this.boneData[i16 + 4] = 0.5 * _SplatSkinning.dual.x;
      this.boneData[i16 + 5] = 0.5 * _SplatSkinning.dual.y;
      this.boneData[i16 + 6] = 0.5 * _SplatSkinning.dual.z;
      this.boneData[i16 + 7] = 0.5 * _SplatSkinning.dual.w;
    } else {
      this.setBoneQuatPosScale(boneIndex, quat, pos, _SplatSkinning.UNIT_SCALE);
    }
  }
  setBoneQuatPosScale(boneIndex, quat, pos, scale) {
    if (this.mode === "dual_quaternion") {
      throw new Error(
        "setBoneQuatPosScale only supported for linear blend skinning"
      );
    }
    _SplatSkinning.skinMat.compose(pos, quat, scale);
    this.setBoneMatrix(boneIndex, _SplatSkinning.skinMat);
  }
  setBoneMatrix(boneIndex, matrix) {
    if (this.mode !== "linear_blend") {
      throw new Error("setBoneMatrix only supported for linear blend skinning");
    }
    _SplatSkinning.skinMat.multiplyMatrices(
      this.boneRestInvMats[boneIndex],
      matrix
    );
    const i16 = boneIndex * 16;
    this.boneData[i16 + 0] = _SplatSkinning.skinMat.elements[0];
    this.boneData[i16 + 1] = _SplatSkinning.skinMat.elements[1];
    this.boneData[i16 + 2] = _SplatSkinning.skinMat.elements[2];
    this.boneData[i16 + 3] = _SplatSkinning.skinMat.elements[4];
    this.boneData[i16 + 4] = _SplatSkinning.skinMat.elements[5];
    this.boneData[i16 + 5] = _SplatSkinning.skinMat.elements[6];
    this.boneData[i16 + 6] = _SplatSkinning.skinMat.elements[8];
    this.boneData[i16 + 7] = _SplatSkinning.skinMat.elements[9];
    this.boneData[i16 + 8] = _SplatSkinning.skinMat.elements[10];
    this.boneData[i16 + 9] = _SplatSkinning.skinMat.elements[12];
    this.boneData[i16 + 10] = _SplatSkinning.skinMat.elements[13];
    this.boneData[i16 + 11] = _SplatSkinning.skinMat.elements[14];
  }
  // Set up to 4 bone indices and weights for a Gsplat. For fewer than 4 bones,
  // you can set the remaining weights to 0 (and index=0).
  setSplatBones(splatIndex, boneIndices, weights) {
    const i4 = splatIndex * 4;
    this.skinData[i4 + 0] = Math.min(255, Math.max(0, Math.round(weights.x * 255))) + (boneIndices.x << 8);
    this.skinData[i4 + 1] = Math.min(255, Math.max(0, Math.round(weights.y * 255))) + (boneIndices.y << 8);
    this.skinData[i4 + 2] = Math.min(255, Math.max(0, Math.round(weights.z * 255))) + (boneIndices.z << 8);
    this.skinData[i4 + 3] = Math.min(255, Math.max(0, Math.round(weights.w * 255))) + (boneIndices.w << 8);
  }
  // Call this to indicate that the bones have changed and the Gsplats need to be
  // re-generated with updated skinning.
  updateBones() {
    this.boneTexture.needsUpdate = true;
    this.mesh.needsUpdate = true;
  }
};
_SplatSkinning.UNIT_SCALE = new THREE__namespace.Vector3(1, 1, 1);
_SplatSkinning.relQuat = new THREE__namespace.Quaternion();
_SplatSkinning.relPos = new THREE__namespace.Vector3();
_SplatSkinning.dual = new THREE__namespace.Quaternion();
_SplatSkinning.skinMat = new THREE__namespace.Matrix4();
let SplatSkinning = _SplatSkinning;
const GsplatSkinning = { type: "GsplatSkinning" };
const defineGsplatSkinning = unindent(`
  struct GsplatSkinning {
    int numSplats;
    int numBones;
    usampler2DArray skinTexture;
    sampler2D boneTexture;
  };
`);
const defineApplyGsplatSkinning = unindent(`
  void applyGsplatSkinning(
    int numSplats, int numBones,
    usampler2DArray skinTexture, sampler2D boneTexture,
    int splatIndex, inout vec3 center, inout vec4 quaternion
  ) {
    if ((splatIndex < 0) || (splatIndex >= numSplats)) {
      return;
    }

    uvec4 skinData = texelFetch(skinTexture, splatTexCoord(splatIndex), 0);

    float weights[4];
    weights[0] = float(skinData.x & 0xffu) / 255.0;
    weights[1] = float(skinData.y & 0xffu) / 255.0;
    weights[2] = float(skinData.z & 0xffu) / 255.0;
    weights[3] = float(skinData.w & 0xffu) / 255.0;

    uint boneIndices[4];
    boneIndices[0] = (skinData.x >> 8u) & 0xffu;
    boneIndices[1] = (skinData.y >> 8u) & 0xffu;
    boneIndices[2] = (skinData.z >> 8u) & 0xffu;
    boneIndices[3] = (skinData.w >> 8u) & 0xffu;

    vec4 quat = vec4(0.0);
    vec4 dual = vec4(0.0);
    for (int i = 0; i < 4; i++) {
      if (weights[i] > 0.0) {
        int boneIndex = int(boneIndices[i]);
        vec4 boneQuat = vec4(0.0, 0.0, 0.0, 1.0);
        vec4 boneDual = vec4(0.0);
        if (boneIndex < numBones) {
          boneQuat = texelFetch(boneTexture, ivec2(0, boneIndex), 0);
          boneDual = texelFetch(boneTexture, ivec2(1, boneIndex), 0);
        }

        if ((i > 0) && (dot(quat, boneQuat) < 0.0)) {
          // Flip sign if next blend is pointing in the opposite direction
          boneQuat = -boneQuat;
          boneDual = -boneDual;
        }
        quat += weights[i] * boneQuat;
        dual += weights[i] * boneDual;
      }
    }

    // Normalize dual quaternion
    float norm = length(quat);
    quat /= norm;
    dual /= norm;
    vec3 translate = vec3(
      2.0 * (-dual.w * quat.x + dual.x * quat.w - dual.y * quat.z + dual.z * quat.y),
      2.0 * (-dual.w * quat.y + dual.x * quat.z + dual.y * quat.w - dual.z * quat.x),
      2.0 * (-dual.w * quat.z - dual.x * quat.y + dual.y * quat.x + dual.z * quat.w)
    );

    center = quatVec(quat, center) + translate;
    quaternion = quatQuat(quat, quaternion);
  }
`);
function applyGsplatSkinning(gsplat, skinning) {
  const dyno2 = new Dyno({
    inTypes: { gsplat: Gsplat, skinning: GsplatSkinning },
    outTypes: { gsplat: Gsplat },
    globals: () => [defineGsplatSkinning, defineApplyGsplatSkinning],
    inputs: { gsplat, skinning },
    statements: ({ inputs, outputs }) => {
      const { skinning: skinning2 } = inputs;
      const { gsplat: gsplat2 } = outputs;
      return unindentLines(`
        ${gsplat2} = ${inputs.gsplat};
        if (isGsplatActive(${gsplat2}.flags)) {
          applyGsplatSkinning(
            ${skinning2}.numSplats, ${skinning2}.numBones,
            ${skinning2}.skinTexture, ${skinning2}.boneTexture,
            ${gsplat2}.index, ${gsplat2}.center, ${gsplat2}.quaternion
          );
        }
      `);
    }
  });
  return dyno2.outputs.gsplat;
}
const defineApplyCovSplatDQSkinning = unindent(`
  void applyCovSplatDQSkinning(
    int numSplats, int numBones,
    usampler2DArray skinTexture, sampler2D boneTexture,
    int splatIndex, inout vec3 center, inout vec3 xxyyzz, inout vec3 xyxzyz
  ) {
    if ((splatIndex < 0) || (splatIndex >= numSplats)) {
      return;
    }

    uvec4 skinData = texelFetch(skinTexture, splatTexCoord(splatIndex), 0);

    float weights[4];
    weights[0] = float(skinData.x & 0xffu) / 255.0;
    weights[1] = float(skinData.y & 0xffu) / 255.0;
    weights[2] = float(skinData.z & 0xffu) / 255.0;
    weights[3] = float(skinData.w & 0xffu) / 255.0;

    uint boneIndices[4];
    boneIndices[0] = (skinData.x >> 8u) & 0xffu;
    boneIndices[1] = (skinData.y >> 8u) & 0xffu;
    boneIndices[2] = (skinData.z >> 8u) & 0xffu;
    boneIndices[3] = (skinData.w >> 8u) & 0xffu;

    vec4 quat = vec4(0.0);
    vec4 dual = vec4(0.0);
    for (int i = 0; i < 4; i++) {
      if (weights[i] > 0.0) {
        int boneIndex = int(boneIndices[i]);
        vec4 boneQuat = vec4(0.0, 0.0, 0.0, 1.0);
        vec4 boneDual = vec4(0.0);
        if (boneIndex < numBones) {
          boneQuat = texelFetch(boneTexture, ivec2(0, boneIndex), 0);
          boneDual = texelFetch(boneTexture, ivec2(1, boneIndex), 0);
        }

        if ((i > 0) && (dot(quat, boneQuat) < 0.0)) {
          // Flip sign if next blend is pointing in the opposite direction
          boneQuat = -boneQuat;
          boneDual = -boneDual;
        }
        quat += weights[i] * boneQuat;
        dual += weights[i] * boneDual;
      }
    }

    // Normalize dual quaternion
    float norm = length(quat);
    quat /= norm;
    dual /= norm;
    vec3 translate = vec3(
      2.0 * (-dual.w * quat.x + dual.x * quat.w - dual.y * quat.z + dual.z * quat.y),
      2.0 * (-dual.w * quat.y + dual.x * quat.z + dual.y * quat.w - dual.z * quat.x),
      2.0 * (-dual.w * quat.z - dual.x * quat.y + dual.y * quat.x + dual.z * quat.w)
    );
    mat3 basis = quaternionToMatrix(quat);

    center = quatVec(quat, center) + translate;

    mat3 cov = mat3(xxyyzz.x, xyxzyz.x, xyxzyz.y, xyxzyz.x, xxyyzz.y, xyxzyz.z, xyxzyz.y, xyxzyz.z, xxyyzz.z);
    cov = basis * cov * transpose(basis);
    xxyyzz = vec3(cov[0][0], cov[1][1], cov[2][2]);
    xyxzyz = vec3(cov[0][1], cov[0][2], cov[1][2]);
  }
`);
const defineApplyCovSplatLBSkinning = unindent(`
  void applyCovSplatLBSkinning(
    int numSplats, int numBones,
    usampler2DArray skinTexture, sampler2D boneTexture,
    int splatIndex, inout vec3 center, inout vec3 xxyyzz, inout vec3 xyxzyz
  ) {
    if ((splatIndex < 0) || (splatIndex >= numSplats)) {
      return;
    }

    uvec4 skinData = texelFetch(skinTexture, splatTexCoord(splatIndex), 0);

    float weights[4];
    weights[0] = float(skinData.x & 0xffu) / 255.0;
    weights[1] = float(skinData.y & 0xffu) / 255.0;
    weights[2] = float(skinData.z & 0xffu) / 255.0;
    weights[3] = float(skinData.w & 0xffu) / 255.0;

    uint boneIndices[4];
    boneIndices[0] = (skinData.x >> 8u) & 0xffu;
    boneIndices[1] = (skinData.y >> 8u) & 0xffu;
    boneIndices[2] = (skinData.z >> 8u) & 0xffu;
    boneIndices[3] = (skinData.w >> 8u) & 0xffu;

    mat3 basis = mat3(0.0);
    vec3 offset = vec3(0.0);

    for (int i = 0; i < 4; i++) {
      if (weights[i] > 0.0) {
        int boneIndex = int(boneIndices[i]);
        if (boneIndex < numBones) {
          vec4 v0 = texelFetch(boneTexture, ivec2(0, boneIndex), 0);
          vec4 v1 = texelFetch(boneTexture, ivec2(1, boneIndex), 0);
          vec4 v2 = texelFetch(boneTexture, ivec2(2, boneIndex), 0);
          basis += weights[i] * mat3(v0.x, v0.y, v0.z, v0.w, v1.x, v1.y, v1.z, v1.w, v2.x);
          offset += weights[i] * vec3(v2.y, v2.z, v2.w);
        }
      }
    }

    center = basis * center + offset;

    mat3 cov = mat3(xxyyzz.x, xyxzyz.x, xyxzyz.y, xyxzyz.x, xxyyzz.y, xyxzyz.z, xyxzyz.y, xyxzyz.z, xxyyzz.z);
    cov = basis * cov * transpose(basis);
    xxyyzz = vec3(cov[0][0], cov[1][1], cov[2][2]);
    xyxzyz = vec3(cov[0][1], cov[0][2], cov[1][2]);
  }
`);
function applyCovSplatDQSkinning(covsplat, skinning) {
  const dyno2 = new Dyno({
    inTypes: { covsplat: CovSplat, skinning: GsplatSkinning },
    outTypes: { covsplat: CovSplat },
    globals: () => [defineGsplatSkinning, defineApplyCovSplatDQSkinning],
    inputs: { covsplat, skinning },
    statements: ({ inputs, outputs }) => {
      const { skinning: skinning2 } = inputs;
      const { covsplat: covsplat2 } = outputs;
      return unindentLines(`
        ${covsplat2} = ${inputs.covsplat};
        if (isCovSplatActive(${covsplat2}.flags)) {
          applyCovSplatDQSkinning(
            ${skinning2}.numSplats, ${skinning2}.numBones,
            ${skinning2}.skinTexture, ${skinning2}.boneTexture,
            ${covsplat2}.index, ${covsplat2}.center, ${covsplat2}.xxyyzz, ${covsplat2}.xyxzyz
          );
        }
      `);
    }
  });
  return dyno2.outputs.covsplat;
}
function applyCovSplatLBSkinning(covsplat, skinning) {
  const dyno2 = new Dyno({
    inTypes: { covsplat: CovSplat, skinning: GsplatSkinning },
    outTypes: { covsplat: CovSplat },
    globals: () => [defineGsplatSkinning, defineApplyCovSplatLBSkinning],
    inputs: { covsplat, skinning },
    statements: ({ inputs, outputs }) => {
      const { skinning: skinning2 } = inputs;
      const { covsplat: covsplat2 } = outputs;
      return unindentLines(`
        ${covsplat2} = ${inputs.covsplat};
        if (isCovSplatActive(${covsplat2}.flags)) {
          applyCovSplatLBSkinning(
            ${skinning2}.numSplats, ${skinning2}.numBones,
            ${skinning2}.skinTexture, ${skinning2}.boneTexture,
            ${covsplat2}.index, ${covsplat2}.center, ${covsplat2}.xxyyzz, ${covsplat2}.xyxzyz
          );
        }
      `);
    }
  });
  return dyno2.outputs.covsplat;
}
function constructGrid({
  // PackedSplats object to add splats to
  splats,
  // min and max box extents of the grid
  extents,
  // step size along each grid axis
  stepSize = 1,
  // spherical radius of each Gsplat
  pointRadius = 0.01,
  // relative size of the "shadow copy" of each Gsplat placed behind it
  pointShadowScale = 2,
  // Gsplat opacity
  opacity = 1,
  // Gsplat color (THREE.Color) or function to set color for position:
  // ((THREE.Color, THREE.Vector3) => void) (default: RGB-modulated grid)
  color
}) {
  const EPSILON = 1e-6;
  const center = new THREE__namespace.Vector3();
  const scales = new THREE__namespace.Vector3();
  const quaternion = new THREE__namespace.Quaternion(0, 0, 0, 1);
  if (color == null) {
    color = (color2, point) => color2.set(
      0.55 + 0.45 * Math.cos(point.x * 1),
      0.55 + 0.45 * Math.cos(point.y * 1),
      0.55 + 0.45 * Math.cos(point.z * 1)
    );
  }
  const pointColor = new THREE__namespace.Color();
  for (let z = extents.min.z; z < extents.max.z + EPSILON; z += stepSize) {
    for (let y = extents.min.y; y < extents.max.y + EPSILON; y += stepSize) {
      for (let x = extents.min.x; x < extents.max.x + EPSILON; x += stepSize) {
        center.set(x, y, z);
        for (let layer = 0; layer < 2; ++layer) {
          scales.setScalar(pointRadius * (layer ? 1 : pointShadowScale));
          if (!layer) {
            pointColor.setScalar(0);
          } else if (typeof color === "function") {
            color(pointColor, center);
          } else {
            pointColor.copy(color);
          }
          splats.pushSplat(center, scales, quaternion, opacity, pointColor);
        }
      }
    }
  }
}
function constructAxes({
  // PackedSplats object to add splats to
  splats,
  // scale (Gsplat scale along axis)
  scale = 0.25,
  // radius of the axes (Gsplat scale orthogonal to axis)
  axisRadius = 75e-4,
  // relative size of the "shadow copy" of each Gsplat placed behind it
  axisShadowScale = 2,
  // origins of the axes (default single axis at origin)
  origins = [new THREE__namespace.Vector3()]
}) {
  const center = new THREE__namespace.Vector3();
  const scales = new THREE__namespace.Vector3();
  const quaternion = new THREE__namespace.Quaternion(0, 0, 0, 1);
  const color = new THREE__namespace.Color();
  const opacity = 1;
  for (const origin of origins) {
    for (let axis = 0; axis < 3; ++axis) {
      center.set(
        origin.x + (axis === 0 ? scale : 0),
        origin.y + (axis === 1 ? scale : 0),
        origin.z + (axis === 2 ? scale : 0)
      );
      for (let layer = 0; layer < 2; ++layer) {
        scales.set(
          (axis === 0 ? scale : axisRadius) * (layer ? 1 : axisShadowScale),
          (axis === 1 ? scale : axisRadius) * (layer ? 1 : axisShadowScale),
          (axis === 2 ? scale : axisRadius) * (layer ? 1 : axisShadowScale)
        );
        color.setRGB(
          layer === 0 ? 0 : axis === 0 ? 1 : 0,
          layer === 0 ? 0 : axis === 1 ? 1 : 0,
          layer === 0 ? 0 : axis === 2 ? 1 : 0
        );
        splats.pushSplat(center, scales, quaternion, opacity, color);
      }
    }
  }
}
function constructSpherePoints({
  // PackedSplats object to add splats to
  splats,
  // center of the sphere (default: origin)
  origin = new THREE__namespace.Vector3(),
  // radius of the sphere
  radius = 1,
  // maximum depth of recursion for subdividing the sphere
  // Warning: Gsplat count grows exponentially with depth
  maxDepth = 3,
  // filter function to apply to each point, for example to select
  // points in a certain direction or other function ((THREE.Vector3) => boolean)
  // (default: null)
  filter = null,
  // radius of each oriented Gsplat
  pointRadius = 0.02,
  // flatness of each oriented Gsplat
  pointThickness = 1e-3,
  // color of each Gsplat (THREE.Color) or function to set color for point:
  // ((THREE.Color, THREE.Vector3) => void) (default: white)
  color = new THREE__namespace.Color(1, 1, 1)
}) {
  const pointsHash = {};
  function addPoint(p) {
    if (filter && !filter(p)) {
      return;
    }
    const key = `${p.x},${p.y},${p.z}`;
    if (!pointsHash[key]) {
      pointsHash[key] = p;
    }
  }
  function recurse(depth, p0, p1, p2) {
    addPoint(p0);
    addPoint(p1);
    addPoint(p2);
    if (depth >= maxDepth) {
      return;
    }
    const p01 = new THREE__namespace.Vector3().addVectors(p0, p1).normalize();
    const p12 = new THREE__namespace.Vector3().addVectors(p1, p2).normalize();
    const p20 = new THREE__namespace.Vector3().addVectors(p2, p0).normalize();
    recurse(depth + 1, p0, p01, p20);
    recurse(depth + 1, p01, p1, p12);
    recurse(depth + 1, p20, p12, p2);
    recurse(depth + 1, p01, p12, p20);
  }
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        const p0 = new THREE__namespace.Vector3(x, 0, 0);
        const p1 = new THREE__namespace.Vector3(0, y, 0);
        const p2 = new THREE__namespace.Vector3(0, 0, z);
        recurse(0, p0, p1, p2);
      }
    }
  }
  const points = Object.values(pointsHash);
  const scales = new THREE__namespace.Vector3(pointRadius, pointRadius, pointThickness);
  const quaternion = new THREE__namespace.Quaternion();
  const pointColor = typeof color === "function" ? new THREE__namespace.Color() : color;
  for (const point of points) {
    quaternion.setFromUnitVectors(new THREE__namespace.Vector3(0, 0, -1), point);
    if (typeof color === "function") {
      color(pointColor, point);
    }
    point.multiplyScalar(radius);
    point.add(origin);
    splats.pushSplat(point, scales, quaternion, 1, pointColor);
  }
}
function textSplats({
  // text string to display
  text,
  // browser font to render text with (default: "Arial")
  font,
  // font size in pixels/Gsplats (default: 32)
  fontSize,
  // SplatMesh.recolor tint assuming white Gsplats (default: white)
  color,
  // Individual Gsplat color (default: white)
  rgb,
  // Gsplat radius (default: 0.8 covers 1-unit spacing well)
  dotRadius,
  // text alignment: "left", "center", "right", "start", "end" (default: "start")
  textAlign,
  // line spacing multiplier, lines delimited by "\n" (default: 1.0)
  lineHeight,
  // Coordinate scale in object-space (default: 1.0)
  objectScale
}) {
  font = font ?? "Arial";
  fontSize = fontSize ?? 32;
  color = color ?? new THREE__namespace.Color(1, 1, 1);
  dotRadius = dotRadius ?? 0.8;
  textAlign = textAlign ?? "start";
  lineHeight = lineHeight ?? 1;
  objectScale = objectScale ?? 1;
  const lines = text.split("\n");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create canvas context");
  }
  ctx.font = `${fontSize}px ${font}`;
  ctx.textAlign = textAlign;
  const metrics = ctx.measureText("");
  const fontHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  let minLeft = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;
  let maxBottom = Number.NEGATIVE_INFINITY;
  for (let line = 0; line < lines.length; ++line) {
    const metrics2 = ctx.measureText(lines[line]);
    const y = fontHeight * lineHeight * line;
    minLeft = Math.min(minLeft, -metrics2.actualBoundingBoxLeft);
    maxRight = Math.max(maxRight, metrics2.actualBoundingBoxRight);
    minTop = Math.min(minTop, y - metrics2.actualBoundingBoxAscent);
    maxBottom = Math.max(maxBottom, y + metrics2.actualBoundingBoxDescent);
  }
  const originLeft = Math.floor(minLeft);
  const originTop = Math.floor(minTop);
  const width = Math.ceil(maxRight) - originLeft;
  const height = Math.ceil(maxBottom) - originTop;
  canvas.width = width;
  canvas.height = height;
  ctx.font = `${fontSize}px ${font}`;
  ctx.textAlign = textAlign;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#FFFFFF";
  for (let i = 0; i < lines.length; ++i) {
    const y = fontHeight * lineHeight * i - originTop;
    ctx.fillText(lines[i], -originLeft, y);
  }
  const imageData = ctx.getImageData(0, 0, width, height);
  const rgba = new Uint8Array(imageData.data.buffer);
  const splats = new PackedSplats();
  const center = new THREE__namespace.Vector3();
  const scales = new THREE__namespace.Vector3().setScalar(dotRadius * objectScale);
  const quaternion = new THREE__namespace.Quaternion(0, 0, 0, 1);
  rgb = rgb ?? new THREE__namespace.Color(1, 1, 1);
  let offset = 0;
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const a = rgba[offset + 3];
      if (a > 0) {
        const opacity = a / 255;
        center.set(x - 0.5 * (width - 1), 0.5 * (height - 1) - y, 0);
        center.multiplyScalar(objectScale);
        splats.pushSplat(center, scales, quaternion, opacity, rgb);
      }
      offset += 4;
    }
  }
  const mesh = new SplatMesh({ packedSplats: splats });
  mesh.recolor = color;
  return mesh;
}
function imageSplats({
  // URL of the image to convert to splats (example: `url: "./image.png"`)
  url,
  // Radius of each Gsplat, default covers 1-unit spacing well (default: 0.8)
  dotRadius,
  // Subsampling factor for the image. Higher values reduce resolution,
  // for example 2 will halve the width and height by averaging (default: 1)
  subXY,
  // Optional callback function to modify each Gsplat before it's added.
  // Return null to skip adding the Gsplat, or a number to set the opacity
  // and add the Gsplat with parameter values in the objects center, rgba etc. were
  // passed into the forEachSplat callback. Ending the callback in `return opacity;`
  // will retain the original opacity.
  // ((width: number, height: number, index: number, center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number, color: THREE.Color) => number | null)
  forEachSplat
}) {
  dotRadius = dotRadius ?? 0.8;
  subXY = Math.max(1, Math.floor(subXY ?? 1));
  return new SplatMesh({
    constructSplats: async (splats) => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onerror = reject;
        img.onload = () => {
          const { width, height } = img;
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("Failed to create canvas context"));
            return;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          const destWidth = Math.round(width / subXY);
          const destHeight = Math.round(height / subXY);
          ctx.drawImage(img, 0, 0, destWidth, destHeight);
          try {
            const imageData = ctx.getImageData(0, 0, destWidth, destHeight);
            const rgba = new Uint8Array(imageData.data.buffer);
            const center = new THREE__namespace.Vector3();
            const scales = new THREE__namespace.Vector3().setScalar(dotRadius);
            const quaternion = new THREE__namespace.Quaternion(0, 0, 0, 1);
            const rgb = new THREE__namespace.Color();
            let index = 0;
            for (let y = 0; y < destHeight; ++y) {
              for (let x = 0; x < destWidth; ++x) {
                const offset = index * 4;
                const a = rgba[offset + 3];
                if (a > 0) {
                  let opacity = a / 255;
                  rgb.set(
                    rgba[offset + 0] / 255,
                    rgba[offset + 1] / 255,
                    rgba[offset + 2] / 255
                  );
                  center.set(
                    x - 0.5 * (destWidth - 1),
                    0.5 * (destHeight - 1) - y,
                    0
                  );
                  scales.setScalar(dotRadius);
                  quaternion.set(0, 0, 0, 1);
                  let push = true;
                  if (forEachSplat) {
                    const maybeOpacity = forEachSplat(
                      destWidth,
                      destHeight,
                      index,
                      center,
                      scales,
                      quaternion,
                      opacity,
                      rgb
                    );
                    opacity = maybeOpacity ?? opacity;
                    push = maybeOpacity !== null;
                  }
                  if (push) {
                    splats.pushSplat(center, scales, quaternion, opacity, rgb);
                  }
                }
                index += 1;
              }
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        img.src = url;
      });
    }
  });
}
function staticBox({
  box,
  cells,
  dotScale,
  color,
  opacity
}) {
  cells.x = Math.max(1, Math.round(cells.x));
  cells.y = Math.max(1, Math.round(cells.y));
  cells.z = Math.max(1, Math.round(cells.z));
  opacity = opacity ?? 1;
  const numSplats = cells.x * cells.y * cells.z;
  const dynoX = dynoConst("int", cells.x);
  const dynoY = dynoConst("int", cells.y);
  dynoConst("int", cells.z);
  const dynoTime = dynoFloat(0);
  const generator = new SplatGenerator({
    numSplats,
    generator: dynoBlock(
      { index: "int" },
      { gsplat: Gsplat },
      ({ index }) => {
        if (!index) {
          throw new Error("index is undefined");
        }
        const cellX = imod(index, dynoX);
        const index2 = div(index, dynoX);
        const cellY = imod(index2, dynoY);
        const cellZ = div(index2, dynoY);
        const cell = combine({
          vectorType: "ivec3",
          x: cellX,
          y: cellY,
          z: cellZ
        });
        const intTime = floatBitsToInt(dynoTime);
        const inputs = combine({ vectorType: "ivec2", x: index, y: intTime });
        const random = hashVec3(inputs);
        const min2 = dynoConst("vec3", box.min);
        const max2 = dynoConst("vec3", box.max);
        const size = sub(max2, min2);
        const coord = div(add(vec3(cell), random), dynoConst("vec3", cells));
        let r;
        let g;
        let b;
        if (color) {
          r = dynoConst("float", color.r);
          g = dynoConst("float", color.g);
          b = dynoConst("float", color.b);
        } else {
          ({ r, g, b } = split(coord).outputs);
        }
        const rgba = combine({
          vectorType: "vec4",
          r,
          g,
          b,
          a: dynoConst("float", opacity)
        });
        const center = add(min2, mul(size, coord));
        const scales = vec3(dynoConst("float", dotScale));
        const quaternion = dynoConst("vec4", new THREE__namespace.Quaternion(0, 0, 0, 1));
        let gsplat = combineGsplat({
          flags: dynoLiteral("uint", "GSPLAT_FLAG_ACTIVE"),
          index,
          center,
          scales,
          quaternion,
          rgba
        });
        gsplat = transformer.applyGsplat(gsplat);
        return { gsplat };
      },
      {
        globals: () => [defineGsplat]
      }
    ),
    update: ({ time }) => {
      dynoTime.value = time;
      transformer.update(generator);
      generator.updateVersion();
    }
  });
  const transformer = new SplatTransformer();
  return generator;
}
const DEFAULT_SNOW = {
  box: new THREE__namespace.Box3(
    new THREE__namespace.Vector3(-1, -1, -1),
    new THREE__namespace.Vector3(1, 1, 1)
  ),
  density: 100,
  fallDirection: new THREE__namespace.Vector3(-1, -3, 1).normalize(),
  fallVelocity: 0.02,
  wanderScale: 0.04,
  wanderVariance: 2,
  color1: new THREE__namespace.Color(1, 1, 1),
  color2: new THREE__namespace.Color(0.5, 0.5, 1),
  minScale: 1e-3,
  maxScale: 5e-3,
  anisoScale: new THREE__namespace.Vector3(1, 1, 1)
};
const DEFAULT_RAIN = {
  box: new THREE__namespace.Box3(
    new THREE__namespace.Vector3(-2, -1, -2),
    new THREE__namespace.Vector3(2, 5, 2)
  ),
  density: 10,
  fallDirection: new THREE__namespace.Vector3(0, -1, 0),
  fallVelocity: 2,
  wanderScale: 0.1,
  wanderVariance: 1,
  color1: new THREE__namespace.Color(1, 1, 1),
  color2: new THREE__namespace.Color(0.25, 0.25, 0.5),
  minScale: 5e-3,
  maxScale: 0.01,
  anisoScale: new THREE__namespace.Vector3(0.1, 1, 0.1)
};
function snowBox({
  // min and max box extents of the snowBox
  box,
  // minimum y-coordinate to clamp particle position, which can be used to
  // fake hitting a ground plane and lingering there for a bit
  minY,
  // number of Gsplats to generate (default: calculated from box and density)
  numSplats,
  // density of Gsplats per unit volume (default: 100)
  density,
  // The xyz anisotropic scale of the Gsplat, which can be used for example
  // to elongate rain particles (default: (1, 1, 1))
  anisoScale,
  // Minimum Gsplat particle scale (default: 0.001)
  minScale,
  // Maximum Gsplat particle scale (default: 0.005)
  maxScale,
  // The average direction of fall (default: (0, -1, 0))
  fallDirection,
  // The average speed of the fall (multiplied with fallDirection) (default: 0.02)
  fallVelocity,
  // The world scale of wandering overlay motion (default: 0.01)
  wanderScale,
  // Controls how uniformly the particles wander in sync, more variance mean
  // more randomness in the motion (default: 2)
  wanderVariance,
  // Color 1 of the two colors interpolated between (default: (1, 1, 1))
  color1,
  // Color 2 of the two colors interpolated between (default: (0.5, 0.5, 1))
  color2,
  // The base opacity of the Gsplats (default: 1)
  opacity,
  // Optional callback function to call each frame.
  onFrame
}) {
  box = box ?? new THREE__namespace.Box3(new THREE__namespace.Vector3(-1, -1, -1), new THREE__namespace.Vector3(1, 1, 1));
  const volume = (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);
  density = density ?? 100;
  numSplats = numSplats ?? Math.max(1, Math.min(1e6, Math.round(volume * density)));
  const dynoMinScale = dynoFloat(minScale ?? 1e-3);
  const dynoMaxScale = dynoFloat(maxScale ?? 5e-3);
  const dynoAnisoScale = dynoVec3(
    ((anisoScale == null ? void 0 : anisoScale.clone()) ?? new THREE__namespace.Vector3(1, 1, 1)).normalize()
  );
  const dynoFallDirection = dynoVec3(
    (fallDirection ?? new THREE__namespace.Vector3(0, -1, 0)).normalize()
  );
  const dynoFallVelocity = dynoFloat(fallVelocity ?? 0.02);
  const dynoWanderScale = dynoFloat(wanderScale ?? 0.01);
  const dynoWanderVariance = dynoFloat(wanderVariance ?? 2);
  const dynoColor1 = dynoVec3(color1 ?? new THREE__namespace.Color(1, 1, 1));
  const dynoColor2 = dynoVec3(color2 ?? new THREE__namespace.Color(0.5, 0.5, 1));
  const dynoOpacity = dynoFloat(opacity ?? 1);
  const dynoTime = dynoFloat(0);
  const globalOffset = dynoVec3(new THREE__namespace.Vector3(0, 0, 0));
  const dynoMin = dynoVec3(box.min);
  const dynoMax = dynoVec3(box.max);
  const dynoMinY = dynoFloat(minY ?? Number.NEGATIVE_INFINITY);
  const minMax = sub(dynoMax, dynoMin);
  const snow = new SplatGenerator({
    numSplats,
    generator: dynoBlock(
      { index: "int" },
      { gsplat: Gsplat },
      ({ index }) => {
        if (!index) {
          throw new Error("index not defined");
        }
        const random = hashVec4(index);
        const randomW = split(random).outputs.w;
        let position = vec3(random);
        let size = fract(mul(randomW, dynoConst("float", 100)));
        size = sin(mul(dynoLiteral("float", "PI"), size));
        size = add(dynoMinScale, mul(size, sub(dynoMaxScale, dynoMinScale)));
        const scales = mul(size, dynoAnisoScale);
        const intensity = fract(mul(randomW, dynoConst("float", 10)));
        const hue = fract(randomW);
        const color = mix(dynoColor1, dynoColor2, hue);
        const rgb = mul(color, intensity);
        const random2 = hashVec4(
          combine({
            vectorType: "ivec2",
            x: index,
            y: dynoConst("int", 6837)
          })
        );
        let perturb = vec3(random2);
        let timeOffset = mul(split(random2).outputs.w, dynoWanderVariance);
        timeOffset = add(dynoTime, timeOffset);
        position = add(position, globalOffset);
        const modulo = mod(
          position,
          dynoConst("vec3", new THREE__namespace.Vector3(1, 1, 1))
        );
        position = add(dynoMin, mul(minMax, modulo));
        const quaternion = dynoConst("vec4", new THREE__namespace.Quaternion(0, 0, 0, 1));
        perturb = sin(add(vec3(timeOffset), perturb));
        perturb = mul(perturb, dynoWanderScale);
        let center = add(position, perturb);
        let centerY = split(center).outputs.y;
        centerY = max(dynoMinY, centerY);
        center = combine({ vector: center, y: centerY });
        let gsplat = combineGsplat({
          flags: dynoLiteral("uint", "GSPLAT_FLAG_ACTIVE"),
          index,
          center,
          scales,
          quaternion,
          rgb,
          opacity: dynoOpacity
        });
        gsplat = transformer.applyGsplat(gsplat);
        return { gsplat };
      },
      {
        globals: () => [defineGsplat]
      }
    ),
    update: ({ object, time, deltaTime }) => {
      dynoTime.value = time;
      transformer.update(snow);
      const fallDelta = dynoFallDirection.value.clone().multiplyScalar(dynoFallVelocity.value * deltaTime);
      globalOffset.value.add(fallDelta);
      object.visible = dynoOpacity.value > 0;
      onFrame == null ? void 0 : onFrame({ object, time, deltaTime });
      snow.updateVersion();
    }
  });
  const transformer = new SplatTransformer();
  return {
    snow,
    min: dynoMin,
    max: dynoMax,
    minY: dynoMinY,
    color1: dynoColor1,
    color2: dynoColor2,
    opacity: dynoOpacity,
    fallVelocity: dynoFallVelocity,
    wanderVariance: dynoWanderVariance,
    wanderScale: dynoWanderScale,
    fallDirection: dynoFallDirection,
    minScale: dynoMinScale,
    maxScale: dynoMaxScale,
    anisoScale: dynoAnisoScale
  };
}
const generators = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DEFAULT_RAIN,
  DEFAULT_SNOW,
  snowBox,
  staticBox
}, Symbol.toStringTag, { value: "Module" }));
function makeNormalColorModifier(splatToView) {
  return dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
    if (!gsplat) {
      throw new Error("No gsplat input");
    }
    let normal = gsplatNormal(gsplat);
    const viewGsplat = splatToView.applyGsplat(gsplat);
    const viewCenter = splitGsplat(viewGsplat).outputs.center;
    const viewNormal = gsplatNormal(viewGsplat);
    const splatDot = dot(viewCenter, viewNormal);
    const sameDir = greaterThanEqual(splatDot, dynoConst("float", 0));
    normal = select(sameDir, neg(normal), normal);
    const rgb = add(
      mul(normal, dynoConst("float", 0.5)),
      dynoConst("float", 0.5)
    );
    gsplat = combineGsplat({ gsplat, rgb });
    return { gsplat };
  });
}
function setWorldNormalColor(splats) {
  splats.enableWorldToView = true;
  splats.worldModifier = makeNormalColorModifier(splats.context.worldToView);
  splats.updateGenerator();
}
function makeDepthColorModifier(splatToView, minDepth, maxDepth, reverse) {
  return dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
    if (!gsplat) {
      throw new Error("No gsplat input");
    }
    let { center } = splitGsplat(gsplat).outputs;
    center = splatToView.apply(center);
    const { z } = split(center).outputs;
    let depth = normalizedDepth(neg(z), minDepth, maxDepth);
    depth = select(reverse, sub(dynoConst("float", 1), depth), depth);
    gsplat = combineGsplat({ gsplat, r: depth, g: depth, b: depth });
    return { gsplat };
  });
}
function setDepthColor(splats, minDepth, maxDepth, reverse) {
  splats.enableWorldToView = true;
  const dynoMinDepth = dynoConst("float", minDepth);
  const dynoMaxDepth = dynoConst("float", maxDepth);
  const dynoReverse = dynoConst("bool", reverse ?? false);
  splats.worldModifier = makeDepthColorModifier(
    splats.context.worldToView,
    dynoMinDepth,
    dynoMaxDepth,
    dynoReverse
  );
  splats.updateGenerator();
  return {
    minDepth: dynoMinDepth,
    maxDepth: dynoMaxDepth,
    reverse: dynoReverse
  };
}
const modifiers = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  makeDepthColorModifier,
  makeNormalColorModifier,
  setDepthColor,
  setWorldNormalColor
}, Symbol.toStringTag, { value: "Module" }));
const DEFAULT_CONTROLLER_MOVE_SPEED = 1;
const DEFAULT_CONTROLLER_ROTATE_SPEED = 4;
const DEFAULT_CONTROLLER_ROLL_SPEED = 2;
const DEFAULT_CONTROLLER_FAST_MULTIPLIER = 5;
const DEFAULT_CONTROLLER_SLOW_MULTIPLIER = 1 / 5;
const DEFAULT_CONTROLLER_MOVE_HEADING = false;
const DEFAULT_CONTROLLER_GETMOVE = (gamepads, sparkXr) => {
  var _a, _b, _c, _d;
  return gamepads.leftIsHand ? new THREE__namespace.Vector3() : new THREE__namespace.Vector3(
    ((_a = gamepads.left) == null ? void 0 : _a.axes[2]) ?? 0,
    (((_b = gamepads.left) == null ? void 0 : _b.buttons[0].value) ?? 0) - (((_c = gamepads.left) == null ? void 0 : _c.buttons[1].value) ?? 0),
    ((_d = gamepads.left) == null ? void 0 : _d.axes[3]) ?? 0
  );
};
const DEFAULT_CONTROLLER_GETROTATE = (gamepads, sparkXr) => {
  var _a;
  return gamepads.rightIsHand ? new THREE__namespace.Vector3() : new THREE__namespace.Vector3(((_a = gamepads.right) == null ? void 0 : _a.axes[2]) ?? 0, 0, 0);
};
const DEFAULT_CONTROLLER_GETFAST = (gamepads, sparkXr) => {
  var _a, _b;
  return gamepads.rightIsHand ? false : ((_b = (_a = gamepads.right) == null ? void 0 : _a.buttons[0]) == null ? void 0 : _b.pressed) ?? false;
};
const DEFAULT_CONTROLLER_GETSLOW = (gamepads, sparkXr) => {
  var _a, _b;
  return gamepads.rightIsHand ? false : ((_b = (_a = gamepads.right) == null ? void 0 : _a.buttons[1]) == null ? void 0 : _b.pressed) ?? false;
};
var JointEnum$1 = /* @__PURE__ */ ((JointEnum2) => {
  JointEnum2["w"] = "wrist";
  JointEnum2["t0"] = "thumb-metacarpal";
  JointEnum2["t1"] = "thumb-phalanx-proximal";
  JointEnum2["t2"] = "thumb-phalanx-distal";
  JointEnum2["t3"] = "thumb-tip";
  JointEnum2["i0"] = "index-finger-metacarpal";
  JointEnum2["i1"] = "index-finger-phalanx-proximal";
  JointEnum2["i2"] = "index-finger-phalanx-intermediate";
  JointEnum2["i3"] = "index-finger-phalanx-distal";
  JointEnum2["i4"] = "index-finger-tip";
  JointEnum2["m0"] = "middle-finger-metacarpal";
  JointEnum2["m1"] = "middle-finger-phalanx-proximal";
  JointEnum2["m2"] = "middle-finger-phalanx-intermediate";
  JointEnum2["m3"] = "middle-finger-phalanx-distal";
  JointEnum2["m4"] = "middle-finger-tip";
  JointEnum2["r0"] = "ring-finger-metacarpal";
  JointEnum2["r1"] = "ring-finger-phalanx-proximal";
  JointEnum2["r2"] = "ring-finger-phalanx-intermediate";
  JointEnum2["r3"] = "ring-finger-phalanx-distal";
  JointEnum2["r4"] = "ring-finger-tip";
  JointEnum2["p0"] = "pinky-finger-metacarpal";
  JointEnum2["p1"] = "pinky-finger-phalanx-proximal";
  JointEnum2["p2"] = "pinky-finger-phalanx-intermediate";
  JointEnum2["p3"] = "pinky-finger-phalanx-distal";
  JointEnum2["p4"] = "pinky-finger-tip";
  return JointEnum2;
})(JointEnum$1 || {});
const JOINT_IDS$1 = Object.keys(JointEnum$1);
const NUM_JOINTS$1 = JOINT_IDS$1.length;
const JOINT_INDEX$1 = {
  w: 0,
  t0: 1,
  t1: 2,
  t2: 3,
  t3: 4,
  i0: 5,
  i1: 6,
  i2: 7,
  i3: 8,
  i4: 9,
  m0: 10,
  m1: 11,
  m2: 12,
  m3: 13,
  m4: 14,
  r0: 15,
  r1: 16,
  r2: 17,
  r3: 18,
  r4: 19,
  p0: 20,
  p1: 21,
  p2: 22,
  p3: 23,
  p4: 24
};
const JOINT_RADIUS$1 = {
  w: 0.02,
  t0: 0.015,
  t1: 0.012,
  t2: 0.0105,
  t3: 85e-4,
  i0: 0.022,
  i1: 0.012,
  i2: 85e-4,
  i3: 75e-4,
  i4: 65e-4,
  m0: 0.021,
  m1: 0.012,
  m2: 8e-3,
  m3: 75e-4,
  m4: 65e-4,
  r0: 0.019,
  r1: 0.011,
  r2: 75e-4,
  r3: 7e-3,
  r4: 6e-3,
  p0: 0.012,
  p1: 0.01,
  p2: 7e-3,
  p3: 65e-4,
  p4: 55e-4
};
const JOINT_SEGMENTS$1 = [
  ["w", "t0", "t1", "t2", "t3"],
  ["w", "i0", "i1", "i2", "i3", "i4"],
  ["w", "m0", "m1", "m2", "m3", "m4"],
  ["w", "r0", "r1", "r2", "r3", "r4"],
  ["w", "p0", "p1", "p2", "p3", "p4"]
];
const JOINT_SEGMENT_STEPS$1 = [
  [8, 10, 8, 6],
  [8, 19, 14, 8, 6],
  [8, 19, 14, 8, 6],
  [8, 19, 14, 8, 6],
  [8, 19, 14, 8, 6]
];
const JOINT_TIPS$1 = ["t3", "i4", "m4", "r4", "p4"];
const FINGER_TIPS$1 = ["i4", "m4", "r4", "p4"];
var Hand$1 = /* @__PURE__ */ ((Hand2) => {
  Hand2["left"] = "left";
  Hand2["right"] = "right";
  return Hand2;
})(Hand$1 || {});
const HANDS$1 = Object.keys(Hand$1);
const XR_HEADSET_HINTS = /Quest|OculusBrowser|VisionOS|XRBrowser|Pico|Lynx|MagicLeap/i;
function isLikelyMobilePhone() {
  const ua = navigator.userAgent ?? "";
  if (XR_HEADSET_HINTS.test(ua)) {
    return false;
  }
  const androidMobile = /Android/i.test(ua) || /Mobile/i.test(ua);
  if (androidMobile) {
    return true;
  }
  const uaData = navigator.userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") {
    return uaData.mobile;
  }
  return false;
}
const _SparkXr = class _SparkXr {
  constructor(options) {
    this.lastControllersUpdate = 0;
    this.hands = [];
    this.renderer = options.renderer;
    this.xr = navigator.xr;
    this.mode = "initializing";
    this.onEnterXr = options.onEnterXr;
    this.onExitXr = options.onExitXr;
    this.enableHands = options.enableHands ?? false;
    this.controllers = options.controllers;
    Promise.resolve().then(() => {
      var _a;
      if (!this.xr) {
        this.mode = "not_supported";
        return;
      }
      if (!options.allowMobileXr && isLikelyMobilePhone()) {
        this.mode = "not_supported";
        return;
      }
      if (this.enableHands) {
        this.hands = [new XrHand(
          "left"
          /* left */
        ), new XrHand(
          "right"
          /* right */
        )];
      }
      let element = void 0;
      let button = void 0;
      if (options.element) {
        element = options.element;
      } else if (options.elementId) {
        element = document.getElementById(options.elementId) ?? void 0;
      } else {
        element = _SparkXr.createButton();
        button = options.button == null || typeof options.button === "boolean" ? {} : options.button;
      }
      if (!element) {
        throw new Error("No element or button provided");
      }
      element.style.display = "none";
      element.classList.add("hidden");
      this.button = button;
      this.element = element;
      const opacity = (_a = options.onMouseLeaveOpacity) == null ? void 0 : _a.toString();
      if (opacity !== void 0) {
        element.addEventListener("mouseleave", () => {
          element.style.opacity = opacity;
        });
        element.addEventListener("mouseenter", () => {
          element.style.opacity = "";
        });
      }
      return this.initializeXr(options);
    }).then(() => {
      var _a;
      return (_a = options.onReady) == null ? void 0 : _a.call(options, this.mode !== "not_supported");
    }).catch((error) => {
      alert(`Error initializing SparkXr: ${error}`);
    });
  }
  async initializeXr(options) {
    var _a, _b;
    if (!this.xr || !this.element) {
      return;
    }
    const element = this.element;
    const modes = {
      vr: ["immersive-vr"],
      ar: ["immersive-ar"],
      arvr: ["immersive-ar", "immersive-vr"],
      vrar: ["immersive-vr", "immersive-ar"]
    }[options.mode ?? "vrar"];
    if (!modes) {
      throw new Error(`Invalid mode: ${options.mode}`);
    }
    let supported = null;
    for (const mode of modes) {
      if (await this.xr.isSessionSupported(mode)) {
        supported = mode;
        break;
      }
    }
    if (!supported) {
      this.mode = "not_supported";
      return;
    }
    this.mode = supported;
    const referenceSpaceType = options.referenceSpaceType ?? "local";
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType(referenceSpaceType);
    if (options.fixedFoveation !== void 0) {
      this.renderer.xr.setFoveation(options.fixedFoveation);
    }
    const frameBufferScaleFactor = options.frameBufferScaleFactor ?? 0.5;
    this.renderer.xr.setFramebufferScaleFactor(frameBufferScaleFactor);
    const optionalFeatures = ((_a = options.sessionInit) == null ? void 0 : _a.optionalFeatures) ?? [];
    if (options.enableHands) {
      optionalFeatures.push("hand-tracking");
    }
    const requiredFeatures = ((_b = options.sessionInit) == null ? void 0 : _b.requiredFeatures) ?? [];
    requiredFeatures.push(referenceSpaceType);
    this.sessionInit = {
      ...options.sessionInit,
      optionalFeatures,
      requiredFeatures
    };
    element.addEventListener("click", () => {
      this.toggleXr();
    });
    this.updateElement();
  }
  async toggleXr() {
    var _a, _b, _c;
    if (!this.xr || !this.sessionInit) {
      return;
    }
    if (!this.session) {
      try {
        const mode = this.mode;
        const session = await this.xr.requestSession(mode, this.sessionInit);
        this.session = session;
        const onSessionEnded = () => {
          var _a2;
          session == null ? void 0 : session.removeEventListener("end", onSessionEnded);
          session == null ? void 0 : session.removeEventListener("visibilitychange", visibilityChanged);
          this.session = void 0;
          this.updateElement();
          (_a2 = this.onExitXr) == null ? void 0 : _a2.call(this);
        };
        let lastVisibilityState = session.visibilityState;
        const visibilityChanged = () => {
          if ((session == null ? void 0 : session.visibilityState) === "visible-blurred" && lastVisibilityState === "visible") {
            session == null ? void 0 : session.end();
          }
          lastVisibilityState = session == null ? void 0 : session.visibilityState;
        };
        (_a = this.session) == null ? void 0 : _a.addEventListener("end", onSessionEnded);
        (_b = this.session) == null ? void 0 : _b.addEventListener("visibilitychange", visibilityChanged);
        await this.renderer.xr.setSession(this.session);
        return (_c = this.onEnterXr) == null ? void 0 : _c.call(this);
      } catch (error) {
        console.error("Error requesting XR session", error);
        return;
      }
    } else {
      this.session.end();
    }
  }
  updateElement() {
    const mode = this.mode;
    const element = this.element;
    if (element) {
      element.style.display = "";
      element.classList.remove("hidden");
      const button = typeof this.button === "boolean" ? {} : this.button;
      if (button) {
        if (!this.session) {
          const enterHtml = (mode === "immersive-vr" ? button.enterVrHtml : button.enterArHtml) ?? button.enterXrHtml;
          const enterText = (mode === "immersive-vr" ? button.enterVrText : button.enterArText) ?? button.enterXrText;
          if (enterHtml) {
            element.innerHTML = enterHtml;
          } else if (enterText) {
            element.textContent = enterText;
          } else {
            element.textContent = mode === "immersive-vr" ? "ENTER VR" : "ENTER AR";
          }
        } else {
          const exitHtml = (mode === "immersive-vr" ? button.exitVrHtml : button.exitArHtml) ?? button.exitXrHtml;
          const exitText = (mode === "immersive-vr" ? button.exitVrText : button.exitArText) ?? button.exitXrText;
          if (exitHtml) {
            element.innerHTML = exitHtml;
          } else if (exitText) {
            element.textContent = exitText;
          } else {
            element.textContent = mode === "immersive-vr" ? "EXIT VR" : "EXIT AR";
          }
        }
        element.style.display = "";
      }
    }
  }
  static createButton() {
    const button = document.createElement("button");
    Object.assign(button.style, {
      position: "absolute",
      bottom: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "40px 40px",
      border: "2px solid #fff",
      borderRadius: "16px",
      background: "rgba(0,0,0,0.1)",
      color: "#fff",
      font: "bold 28px sans-serif",
      textAlign: "center",
      userSelect: "none",
      zIndex: "999"
    });
    document.body.appendChild(button);
    return button;
  }
  xrSupported() {
    return !!this.xr;
  }
  left() {
    return this.hands[0];
  }
  right() {
    return this.hands[1];
  }
  updateControllers(camera) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
    const cameraFrame = camera.parent;
    const now = performance.now();
    const deltaTime = (now - (this.lastControllersUpdate || now)) / 1e3;
    this.lastControllersUpdate = now;
    const xrGamepads = {};
    for (const source of ((_a = this.renderer.xr.getSession()) == null ? void 0 : _a.inputSources) ?? []) {
      const gamepad = source.gamepad;
      if (gamepad && (source.handedness === "left" || source.handedness === "right")) {
        xrGamepads[source.handedness] = gamepad;
        if (source.handedness === "left") {
          xrGamepads.leftIsHand = !!source.hand;
        } else if (source.handedness === "right") {
          xrGamepads.rightIsHand = !!source.hand;
        }
      }
    }
    const rotate = (((_b = this.controllers) == null ? void 0 : _b.getRotate) ?? DEFAULT_CONTROLLER_GETROTATE)(xrGamepads, this);
    rotate.multiply(
      new THREE__namespace.Vector3(
        ((_c = this.controllers) == null ? void 0 : _c.rotateSpeed) ?? DEFAULT_CONTROLLER_ROTATE_SPEED,
        ((_d = this.controllers) == null ? void 0 : _d.rotateSpeed) ?? DEFAULT_CONTROLLER_ROTATE_SPEED,
        ((_e = this.controllers) == null ? void 0 : _e.rollSpeed) ?? DEFAULT_CONTROLLER_ROLL_SPEED
      )
    );
    if (rotate.manhattanLength() > 0) {
      rotate.multiplyScalar(deltaTime);
      const eulers = new THREE__namespace.Euler(-rotate.y, -rotate.x, rotate.z, "YXZ");
      const quat = new THREE__namespace.Quaternion().setFromEuler(eulers);
      const pivot = camera.getWorldPosition(new THREE__namespace.Vector3());
      (_f = cameraFrame.parent) == null ? void 0 : _f.worldToLocal(pivot);
      cameraFrame.position.sub(pivot);
      cameraFrame.position.applyQuaternion(quat);
      cameraFrame.position.add(pivot);
      cameraFrame.quaternion.premultiply(quat);
    }
    const move = (((_g = this.controllers) == null ? void 0 : _g.getMove) ?? DEFAULT_CONTROLLER_GETMOVE)(
      xrGamepads,
      this
    );
    let moveSpeed = ((_h = this.controllers) == null ? void 0 : _h.moveSpeed) ?? DEFAULT_CONTROLLER_MOVE_SPEED;
    if ((((_i = this.controllers) == null ? void 0 : _i.getFast) ?? DEFAULT_CONTROLLER_GETFAST)(
      xrGamepads,
      this
    )) {
      moveSpeed *= DEFAULT_CONTROLLER_FAST_MULTIPLIER;
    }
    if ((((_j = this.controllers) == null ? void 0 : _j.getSlow) ?? DEFAULT_CONTROLLER_GETSLOW)(
      xrGamepads,
      this
    )) {
      moveSpeed *= DEFAULT_CONTROLLER_SLOW_MULTIPLIER;
    }
    if ((_k = this.controllers) == null ? void 0 : _k.moveHeading) {
      move.applyQuaternion(camera.quaternion);
    } else if ((_l = this.controllers) == null ? void 0 : _l.moveDirection) {
      SCRATCH_EULER.setFromQuaternion(camera.quaternion, "YXZ");
      SCRATCH_EULER.x = 0;
      SCRATCH_EULER.z = 0;
      SCRATCH_QUAT_A.setFromEuler(SCRATCH_EULER);
      move.applyQuaternion(SCRATCH_QUAT_A);
    }
    move.applyQuaternion(cameraFrame.quaternion);
    move.multiplyScalar(deltaTime * moveSpeed);
    cameraFrame.position.add(move);
  }
  updateHands({ xrFrame }) {
    const xrSession = this.renderer.xr.getSession();
    if (!xrSession) {
      return;
    }
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!referenceSpace) {
      return;
    }
    if (!xrFrame.getJointPose) {
      return;
    }
    for (const hand of this.hands) {
      if (hand) {
        hand.lastJoints = hand.joints;
        hand.joints = void 0;
      }
    }
    for (const inputSource of xrSession.inputSources) {
      if (!inputSource.hand) {
        continue;
      }
      const hand = inputSource.handedness;
      const xrHand = this.hands[hand === "left" ? 0 : 1];
      if (!xrHand) {
        continue;
      }
      for (const jointId of JOINT_IDS$1) {
        const jointSpace = inputSource.hand.get(JointEnum$1[jointId]);
        if (jointSpace) {
          const jointPose = xrFrame.getJointPose(jointSpace, referenceSpace);
          if (jointPose) {
            const { position, orientation } = jointPose.transform;
            if (!xrHand.joints) {
              xrHand.joints = {};
            }
            xrHand.joints[jointId] = {
              position: new THREE__namespace.Vector3(position.x, position.y, position.z),
              quaternion: new THREE__namespace.Quaternion(
                orientation.x,
                orientation.y,
                orientation.z,
                orientation.w
              ),
              radius: JOINT_RADIUS$1[jointId]
            };
          }
        }
      }
    }
  }
  makeJointSplats(hand) {
    const mesh = new JointSplats(hand);
    mesh.onFrame = () => {
      const xrHand = this.hands[hand === "left" ? 0 : 1];
      const joints = xrHand == null ? void 0 : xrHand.joints;
      mesh.updateJoints(joints);
    };
    return mesh;
  }
  snapshotHands(time) {
    var _a, _b;
    const hands = [
      (_a = this.hands[0]) == null ? void 0 : _a.snapshotJoints(),
      (_b = this.hands[1]) == null ? void 0 : _b.snapshotJoints()
    ];
    return { time, hands };
  }
};
_SparkXr.JointEnum = JointEnum$1;
_SparkXr.JOINT_IDS = JOINT_IDS$1;
_SparkXr.NUM_JOINTS = NUM_JOINTS$1;
_SparkXr.JOINT_INDEX = JOINT_INDEX$1;
_SparkXr.JOINT_RADIUS = JOINT_RADIUS$1;
_SparkXr.JOINT_SEGMENTS = JOINT_SEGMENTS$1;
_SparkXr.JOINT_SEGMENT_STEPS = JOINT_SEGMENT_STEPS$1;
_SparkXr.JOINT_TIPS = JOINT_TIPS$1;
_SparkXr.FINGER_TIPS = FINGER_TIPS$1;
_SparkXr.Hand = Hand$1;
_SparkXr.HANDS = HANDS$1;
let SparkXr = _SparkXr;
const round4 = (value) => Math.round(value * 1e4) / 1e4;
const SCRATCH_EULER = new THREE__namespace.Euler(0, 0, 0, "YXZ");
const SCRATCH_QUAT_A = new THREE__namespace.Quaternion();
const SCRATCH_QUAT_B = new THREE__namespace.Quaternion();
function lerpHandsSnapshots(snapshots, time) {
  if (!snapshots.length) {
    return null;
  }
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  if (time < first.time || time > last.time) {
    return null;
  }
  const floorIndex = findSnapshotFloorIndex(snapshots, time);
  if (floorIndex === -1) {
    return null;
  }
  const from = snapshots[floorIndex];
  const to = snapshots[floorIndex + 1];
  if (!to) {
    return cloneSnapshot(from, time);
  }
  const span = to.time - from.time;
  const factor = span > 0 ? (time - from.time) / span : 0;
  return interpolateSnapshots(from, to, factor, time);
}
function interpolateSnapshots(from, to, factor, time) {
  const maxHands = Math.max(from.hands.length, to.hands.length);
  const hands = Array.from(
    { length: maxHands },
    (_, handIndex) => lerpHandSnapshot(from.hands[handIndex], to.hands[handIndex], factor)
  );
  return { time, hands };
}
function cloneSnapshot(snapshot, time) {
  return {
    time,
    hands: snapshot.hands.map((hand) => cloneHandSnapshot(hand))
  };
}
class XrHand {
  constructor(hand) {
    this.hand = hand;
  }
  static newFromSnapshot(hand, snapshot) {
    const h = new XrHand(hand);
    h.joints = {};
    for (const jointId of JOINT_IDS$1) {
      const joint = snapshot[jointId];
      if (!joint) {
        continue;
      }
      h.joints[jointId] = {
        position: new THREE__namespace.Vector3(joint.pos[0], joint.pos[1], joint.pos[2]),
        quaternion: new THREE__namespace.Quaternion(
          joint.quat[0],
          joint.quat[1],
          joint.quat[2],
          joint.quat[3]
        ),
        radius: joint.radius
      };
    }
    return h;
  }
  valid() {
    return !!this.joints;
  }
  snapshotJoints() {
    if (!this.joints) {
      return void 0;
    }
    const snapshot = {};
    for (const jointId of JOINT_IDS$1) {
      const joint = this.joints[jointId];
      if (!joint) {
        continue;
      }
      snapshot[jointId] = {
        pos: joint.position.toArray().map(round4),
        quat: joint.quaternion.toArray().map(round4),
        radius: round4(joint.radius)
      };
    }
    return snapshot;
  }
  toFlatArray() {
    if (!this.joints) {
      return void 0;
    }
    const array = new Float32Array(1 + 25 * 7);
    array[0] = this.hand === "left" ? 0 : 1;
    let index = 1;
    for (const jointId of JOINT_IDS$1) {
      const joint = this.joints[jointId];
      if (joint) {
        array[index] = joint.position.x;
        array[index + 1] = joint.position.y;
        array[index + 2] = joint.position.z;
        array[index + 3] = joint.quaternion.x;
        array[index + 4] = joint.quaternion.y;
        array[index + 5] = joint.quaternion.z;
        array[index + 6] = joint.quaternion.w;
      }
      index += 7;
    }
    return array;
  }
}
function findSnapshotFloorIndex(snapshots, time) {
  let low = 0;
  let high = snapshots.length - 1;
  while (low <= high) {
    const mid = low + high >> 1;
    if (snapshots[mid].time <= time) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high;
}
function lerpHandSnapshot(fromHand, toHand, factor = 0) {
  if (!fromHand || !toHand) {
    return void 0;
  }
  const hand = {};
  for (const jointId of JOINT_IDS$1) {
    const joint = lerpJointSnapshot(fromHand[jointId], toHand[jointId], factor);
    if (joint) {
      hand[jointId] = joint;
    }
  }
  return hand;
}
function lerpJointSnapshot(fromJoint, toJoint, factor = 0) {
  if (!fromJoint || !toJoint) {
    return void 0;
  }
  const pos = fromJoint.pos.map(
    (value, index) => value + (toJoint.pos[index] - value) * factor
  );
  const quat = SCRATCH_QUAT_A.fromArray(fromJoint.quat).slerp(SCRATCH_QUAT_B.fromArray(toJoint.quat), factor).toArray();
  const radius = fromJoint.radius + (toJoint.radius - fromJoint.radius) * factor;
  return { pos, quat, radius };
}
function cloneHandSnapshot(hand) {
  if (!hand) {
    return void 0;
  }
  const clone = {};
  for (const jointId of JOINT_IDS$1) {
    const joint = hand[jointId];
    if (joint) {
      clone[jointId] = cloneJointSnapshot(joint);
    }
  }
  return clone;
}
function cloneJointSnapshot(joint) {
  return {
    pos: [...joint.pos],
    quat: [...joint.quat],
    radius: joint.radius
  };
}
class JointSplats extends SplatMesh {
  constructor(hand) {
    super({});
    this.scratchCenter = new THREE__namespace.Vector3();
    this.scratchQuat = new THREE__namespace.Quaternion(0, 0, 0, 1);
    this.scratchScales = new THREE__namespace.Vector3().setScalar(0.01);
    this.scratchColor = new THREE__namespace.Color(1, 1, 1);
    this.hand = hand;
  }
  updateJoints(joints) {
    this.visible = false;
    if (!joints || !this.packedSplats) {
      return;
    }
    this.visible = true;
    let splatIndex = 0;
    for (const jointId of JOINT_IDS$1) {
      const joint = joints[jointId];
      if (!joint) {
        continue;
      }
      this.scratchCenter.copy(joint.position);
      this.scratchQuat.copy(joint.quaternion);
      this.scratchScales.set(
        joint.radius,
        0.75 * joint.radius,
        1.5 * joint.radius
      );
      const opacity = 0.75;
      this.packedSplats.setSplat(
        splatIndex,
        this.scratchCenter,
        this.scratchScales,
        this.scratchQuat,
        opacity,
        this.scratchColor
      );
      splatIndex += 1;
    }
    this.packedSplats.numSplats = splatIndex;
    this.packedSplats.needsUpdate = true;
    this.numSplats = splatIndex;
    this.updateVersion();
  }
}
const DEFAULT_MOVE_INERTIA$1 = 0.5;
const DEFAULT_ROTATE_INERTIA$1 = 0.5;
const TOUCH_BIAS = 0;
var JointEnum = /* @__PURE__ */ ((JointEnum2) => {
  JointEnum2["w"] = "wrist";
  JointEnum2["t0"] = "thumb-metacarpal";
  JointEnum2["t1"] = "thumb-phalanx-proximal";
  JointEnum2["t2"] = "thumb-phalanx-distal";
  JointEnum2["t3"] = "thumb-tip";
  JointEnum2["i0"] = "index-finger-metacarpal";
  JointEnum2["i1"] = "index-finger-phalanx-proximal";
  JointEnum2["i2"] = "index-finger-phalanx-intermediate";
  JointEnum2["i3"] = "index-finger-phalanx-distal";
  JointEnum2["i4"] = "index-finger-tip";
  JointEnum2["m0"] = "middle-finger-metacarpal";
  JointEnum2["m1"] = "middle-finger-phalanx-proximal";
  JointEnum2["m2"] = "middle-finger-phalanx-intermediate";
  JointEnum2["m3"] = "middle-finger-phalanx-distal";
  JointEnum2["m4"] = "middle-finger-tip";
  JointEnum2["r0"] = "ring-finger-metacarpal";
  JointEnum2["r1"] = "ring-finger-phalanx-proximal";
  JointEnum2["r2"] = "ring-finger-phalanx-intermediate";
  JointEnum2["r3"] = "ring-finger-phalanx-distal";
  JointEnum2["r4"] = "ring-finger-tip";
  JointEnum2["p0"] = "pinky-finger-metacarpal";
  JointEnum2["p1"] = "pinky-finger-phalanx-proximal";
  JointEnum2["p2"] = "pinky-finger-phalanx-intermediate";
  JointEnum2["p3"] = "pinky-finger-phalanx-distal";
  JointEnum2["p4"] = "pinky-finger-tip";
  return JointEnum2;
})(JointEnum || {});
const JOINT_IDS = Object.keys(JointEnum);
const NUM_JOINTS = JOINT_IDS.length;
const JOINT_INDEX = {
  w: 0,
  t0: 1,
  t1: 2,
  t2: 3,
  t3: 4,
  i0: 5,
  i1: 6,
  i2: 7,
  i3: 8,
  i4: 9,
  m0: 10,
  m1: 11,
  m2: 12,
  m3: 13,
  m4: 14,
  r0: 15,
  r1: 16,
  r2: 17,
  r3: 18,
  r4: 19,
  p0: 20,
  p1: 21,
  p2: 22,
  p3: 23,
  p4: 24
};
const JOINT_RADIUS = {
  w: 0.02,
  t0: 0.02,
  t1: 0.014,
  t2: 0.0115,
  t3: 85e-4,
  i0: 0.022,
  i1: 0.012,
  i2: 85e-4,
  i3: 75e-4,
  i4: 65e-4,
  m0: 0.021,
  m1: 0.012,
  m2: 8e-3,
  m3: 75e-4,
  m4: 65e-4,
  r0: 0.019,
  r1: 0.011,
  r2: 75e-4,
  r3: 7e-3,
  r4: 6e-3,
  p0: 0.012,
  p1: 0.01,
  p2: 7e-3,
  p3: 65e-4,
  p4: 55e-4
};
const JOINT_SEGMENTS = [
  ["w", "t0", "t1", "t2", "t3"],
  ["w", "i0", "i1", "i2", "i3", "i4"],
  ["w", "m0", "m1", "m2", "m3", "m4"],
  ["w", "r0", "r1", "r2", "r3", "r4"],
  ["w", "p0", "p1", "p2", "p3", "p4"]
];
const JOINT_SEGMENT_STEPS = [
  [8, 10, 8, 6],
  [8, 19, 14, 8, 6],
  [8, 19, 14, 8, 6],
  [8, 19, 14, 8, 6],
  [8, 19, 14, 8, 6]
];
const JOINT_TIPS = ["t3", "i4", "m4", "r4", "p4"];
const FINGER_TIPS = ["i4", "m4", "r4", "p4"];
var Hand = /* @__PURE__ */ ((Hand2) => {
  Hand2["left"] = "left";
  Hand2["right"] = "right";
  return Hand2;
})(Hand || {});
const HANDS = Object.keys(Hand);
class XrHands {
  constructor() {
    this.hands = {};
    this.last = {};
    this.values = {};
    this.tests = {};
    this.lastTests = {};
    this.updated = false;
  }
  update({ xr, xrFrame }) {
    const xrSession = xr.getSession();
    if (!xrSession) {
      return;
    }
    const referenceSpace = xr.getReferenceSpace();
    if (!referenceSpace) {
      return;
    }
    if (!xrFrame.getJointPose) {
      return;
    }
    this.last = this.hands;
    this.lastTests = this.tests;
    this.hands = {};
    this.values = {};
    this.tests = {};
    for (const inputSource of xrSession.inputSources) {
      if (!inputSource.hand) {
        continue;
      }
      const hand = inputSource.handedness;
      this.hands[hand] = {};
      for (const jointId of JOINT_IDS) {
        const jointSpace = inputSource.hand.get(JointEnum[jointId]);
        if (jointSpace) {
          const jointPose = xrFrame.getJointPose(jointSpace, referenceSpace);
          if (jointPose) {
            const { position, orientation } = jointPose.transform;
            this.hands[hand][jointId] = {
              position: new THREE.Vector3(position.x, position.y, position.z),
              quaternion: new THREE.Quaternion(
                orientation.x,
                orientation.y,
                orientation.z,
                orientation.w
              ),
              radius: jointPose.radius || 1e-3
            };
          }
        }
      }
    }
    for (const hand of HANDS) {
      for (const { key, value } of [
        { key: `${hand}AllTips`, value: this.allTipsTouching(hand) },
        {
          key: `${hand}IndexThumb`,
          value: this.touching(hand, "i4", hand, "t3")
        },
        {
          key: `${hand}MiddleThumb`,
          value: this.touching(hand, "m4", hand, "t3")
        },
        {
          key: `${hand}RingThumb`,
          value: this.touching(hand, "r4", hand, "t3")
        },
        {
          key: `${hand}PinkyThumb`,
          value: this.touching(hand, "p4", hand, "t3")
        },
        { key: `${hand}TriTips`, value: this.triTipsTouching(hand) }
      ]) {
        this.values[key] = value;
        this.tests[key] = value === 1 ? true : value === 0 ? false : this.lastTests[key] ?? false;
      }
    }
  }
  makeGhostMesh() {
    const center = new THREE.Vector3();
    const scales = new THREE.Vector3(0.01, 0.01, 0.01);
    const quaternion = new THREE.Quaternion(0, 0, 0, 1);
    const color = new THREE.Color(1, 1, 1);
    const CYCLE = Math.PI * 3;
    new THREE.Color(1, 1, 1);
    let opacity = 1;
    const mesh = new SplatMesh({
      onFrame: () => {
        if (!mesh.packedSplats) {
          return;
        }
        let splatIndex = 0;
        for (const handedness of HANDS) {
          const xrHand = this.hands[handedness];
          for (const [index, segment] of JOINT_SEGMENTS.entries()) {
            for (let i = 1; i < segment.length; ++i) {
              const segmentSplats = JOINT_SEGMENT_STEPS[index][i - 1] * 2;
              const lastSegment = i + 1 === segment.length;
              const jointA = xrHand == null ? void 0 : xrHand[segment[i - 1]];
              const jointB = xrHand == null ? void 0 : xrHand[segment[i]];
              for (let j = 0; j < segmentSplats; ++j) {
                const t = (j + 0.5) / segmentSplats;
                opacity = 0;
                if (jointA && jointB) {
                  center.copy(jointA.position).lerp(jointB.position, t);
                  quaternion.copy(jointA.quaternion).slerp(jointB.quaternion, t);
                  const radiusA = JOINT_RADIUS[segment[i - 1]];
                  const radiusB = JOINT_RADIUS[segment[i]];
                  let radius = (1 - t) * radiusA + t * radiusB;
                  if (lastSegment && t > 0.8) {
                    radius *= Math.sqrt(1 - ((t - 0.8) / 0.2) ** 2);
                  }
                  scales.set(0.65 * radius, 0.5 * radius, 3e-3);
                  color.set(
                    0.55 + 0.45 * Math.sin(center.x * CYCLE),
                    0.55 + 0.45 * Math.sin(center.y * CYCLE),
                    0.55 + 0.45 * Math.sin(center.z * CYCLE)
                  );
                  if (handedness === "right") {
                    color.set(1 - color.r, 1 - color.g, 1 - color.b);
                  }
                  opacity = 0.75;
                }
                mesh.packedSplats.setSplat(
                  splatIndex,
                  center,
                  scales,
                  quaternion,
                  opacity,
                  color
                );
                splatIndex += 1;
              }
            }
          }
        }
        mesh.packedSplats.numSplats = splatIndex;
        mesh.packedSplats.needsUpdate = true;
        mesh.numSplats = splatIndex;
        mesh.updateVersion();
      }
    });
    return mesh;
  }
  distance(handA, jointA, handB, jointB, last = false) {
    const hA = last ? this.last[handA] : this.hands[handA];
    const hB = last ? this.last[handB] : this.hands[handB];
    const jA = hA == null ? void 0 : hA[jointA];
    const jB = hB == null ? void 0 : hB[jointB];
    if (!jA || !jB) {
      return Number.POSITIVE_INFINITY;
    }
    return jA.position.distanceTo(jB.position);
  }
  separation(handA, jointA, handB, jointB, last = false) {
    const d = this.distance(handA, jointA, handB, jointB, last);
    if (d === Number.POSITIVE_INFINITY) {
      return Number.POSITIVE_INFINITY;
    }
    return d - JOINT_RADIUS[jointA] - JOINT_RADIUS[jointB];
  }
  touching(handA, jointA, handB, jointB, last = false) {
    const d = this.separation(handA, jointA, handB, jointB, last);
    if (d === Number.POSITIVE_INFINITY) {
      return Number.POSITIVE_INFINITY;
    }
    return 1 - Math.max(0, Math.min(1, d / 0.01 - TOUCH_BIAS));
  }
  allTipsTouching(hand, last = false) {
    return Math.min(
      this.touching(hand, "t3", hand, "i4", last),
      this.touching(hand, "i4", hand, "m4", last),
      this.touching(hand, "m4", hand, "r4", last),
      this.touching(hand, "r4", hand, "p4", last)
      // this.touching(hand, "p4", hand, "t3", last),
    );
  }
  triTipsTouching(hand, last = false) {
    return Math.min(
      this.touching(hand, "t3", hand, "i4", last),
      this.touching(hand, "i4", hand, "m4", last),
      this.touching(hand, "m4", hand, "t3", last)
    );
  }
}
class HandMovement {
  constructor({
    xrHands,
    control,
    moveInertia,
    rotateInertia
  }) {
    this.lastGrip = {};
    this.lastPivot = new THREE.Vector3();
    this.rotateVelocity = 0;
    this.velocity = new THREE.Vector3();
    this.xrHands = xrHands;
    this.control = control;
    this.moveInertia = moveInertia ?? DEFAULT_MOVE_INERTIA$1;
    this.rotateInertia = rotateInertia ?? DEFAULT_ROTATE_INERTIA$1;
  }
  update(deltaTime) {
    var _a, _b, _c, _d, _e;
    const grip = {};
    for (const handedness of HANDS) {
      const hand = this.xrHands.hands[handedness];
      if (hand && this.xrHands.tests[`${handedness}MiddleThumb`]) {
        grip[handedness] = new THREE.Vector3().add(((_a = hand.t3) == null ? void 0 : _a.position) ?? new THREE.Vector3()).add(((_b = hand.i4) == null ? void 0 : _b.position) ?? new THREE.Vector3()).add(((_c = hand.m4) == null ? void 0 : _c.position) ?? new THREE.Vector3()).add(((_d = hand.r4) == null ? void 0 : _d.position) ?? new THREE.Vector3()).add(((_e = hand.p4) == null ? void 0 : _e.position) ?? new THREE.Vector3()).multiplyScalar(1 / 5);
      }
    }
    if (grip.left && grip.right && this.lastGrip.left && this.lastGrip.right) {
      const mid = grip.left.clone().add(grip.right).multiplyScalar(0.5);
      const lastMid = this.lastGrip.left.clone().add(this.lastGrip.right).multiplyScalar(0.5);
      this.lastPivot = mid;
      const delta = mid.clone().applyMatrix4(this.control.matrix);
      delta.sub(lastMid.clone().applyMatrix4(this.control.matrix));
      delta.multiplyScalar(1 / deltaTime);
      this.velocity.lerp(delta, 1 - Math.exp(-20 * deltaTime));
      const angle = Math.atan2(grip.left.z - mid.z, grip.left.x - mid.x);
      const lastAngle = Math.atan2(
        this.lastGrip.left.z - lastMid.z,
        this.lastGrip.left.x - lastMid.x
      );
      let closestAngle = angle - lastAngle;
      if (closestAngle > Math.PI) {
        closestAngle -= Math.PI * 2;
      } else if (closestAngle < -Math.PI) {
        closestAngle += Math.PI * 2;
      }
      const rotateVelocity = closestAngle / deltaTime;
      const blend = Math.exp(-20 * deltaTime);
      this.rotateVelocity = this.rotateVelocity * blend + rotateVelocity * (1 - blend);
    } else {
      this.rotateVelocity *= Math.exp(-deltaTime / this.rotateInertia);
      if (grip.left && this.lastGrip.left) {
        const delta = grip.left.clone().applyMatrix4(this.control.matrix);
        delta.sub(this.lastGrip.left.clone().applyMatrix4(this.control.matrix));
        delta.multiplyScalar(1 / deltaTime);
        this.velocity.lerp(delta, 1 - Math.exp(-20 * deltaTime));
      } else if (grip.right && this.lastGrip.right) {
        const delta = grip.right.clone().applyMatrix4(this.control.matrix);
        delta.sub(
          this.lastGrip.right.clone().applyMatrix4(this.control.matrix)
        );
        delta.multiplyScalar(1 / deltaTime);
        this.velocity.lerp(delta, 1 - Math.exp(-20 * deltaTime));
      } else {
        this.velocity.multiplyScalar(Math.exp(-deltaTime / this.moveInertia));
      }
    }
    const negPivot = this.lastPivot.clone().negate();
    const rotate = new THREE.Matrix4().makeTranslation(negPivot).premultiply(new THREE.Matrix4().makeRotationY(this.rotateVelocity * deltaTime)).premultiply(new THREE.Matrix4().makeTranslation(this.lastPivot));
    this.control.matrix.multiply(rotate);
    this.control.matrix.decompose(
      this.control.position,
      this.control.quaternion,
      this.control.scale
    );
    this.control.updateMatrixWorld(true);
    this.control.position.sub(this.velocity.clone().multiplyScalar(deltaTime));
    this.lastGrip = grip;
  }
}
const DEFAULT_MOVEMENT_SPEED = 1;
const DEFAULT_ROLL_SPEED = 2;
const DEFAULT_ROTATE_SPEED = 2e-3;
const DEFAULT_SLIDE_SPEED = 6e-3;
const DEFAULT_SCROLL_SPEED = 15e-4;
const DEFAULT_ROTATE_INERTIA = 0.15;
const DEFAULT_MOVE_INERTIA = 0.15;
const DEFAULT_STICK_THRESHOLD = 0.1;
const DEFAULT_FPS_ROTATE_SPEED = 2;
const DEFAULT_POINTER_ROLL_SCALE = 0;
const DEFAULT_PRESS_MOVE_DELAY_MS = 500;
const DEFAULT_PRESS_MOVE_ACCEL_MS = 500;
const DUAL_PRESS_MS = 200;
const DOUBLE_PRESS_LIMIT_MS = 400;
const DOUBLE_PRESS_DISTANCE = 25;
const MOVEMENT_THRESHOLD = 1e-4;
const WASD_KEYCODE_MOVE = {
  KeyW: new THREE__namespace.Vector3(0, 0, -1),
  KeyS: new THREE__namespace.Vector3(0, 0, 1),
  KeyA: new THREE__namespace.Vector3(-1, 0, 0),
  KeyD: new THREE__namespace.Vector3(1, 0, 0),
  KeyE: new THREE__namespace.Vector3(0, 1, 0),
  KeyQ: new THREE__namespace.Vector3(0, -1, 0)
};
const ARROW_KEYCODE_MOVE = {
  ArrowUp: new THREE__namespace.Vector3(0, 0, -1),
  ArrowDown: new THREE__namespace.Vector3(0, 0, 1),
  ArrowLeft: new THREE__namespace.Vector3(-1, 0, 0),
  ArrowRight: new THREE__namespace.Vector3(1, 0, 0),
  PageUp: new THREE__namespace.Vector3(0, 1, 0),
  PageDown: new THREE__namespace.Vector3(0, -1, 0)
};
({
  KeyQ: new THREE__namespace.Vector3(0, 0, 1),
  KeyE: new THREE__namespace.Vector3(0, 0, -1)
});
const ARROW_KEYCODE_ROTATE = {
  Home: new THREE__namespace.Vector3(0, -1, 0),
  End: new THREE__namespace.Vector3(0, 1, 0),
  Insert: new THREE__namespace.Vector3(-1, 0, 0),
  Delete: new THREE__namespace.Vector3(1, 0, 0)
};
class SparkControls {
  constructor({ canvas }) {
    this.lastTime = 0;
    this.fpsMovement = new FpsMovement({});
    this.pointerControls = new PointerControls({ canvas });
  }
  update(control, camera) {
    const time = performance.now();
    const deltaTime = (time - (this.lastTime || time)) / 1e3;
    this.lastTime = time;
    let updated = this.fpsMovement.update(deltaTime, control);
    if (this.pointerControls.update(deltaTime, control, camera)) {
      updated = true;
    }
    return updated;
  }
}
class FpsMovement {
  constructor({
    moveSpeed,
    rollSpeed,
    stickThreshold,
    rotateSpeed,
    keycodeMoveMapping,
    keycodeRotateMapping,
    gamepadMapping,
    capsMultiplier,
    shiftMultiplier,
    ctrlMultiplier,
    xr
  } = {}) {
    this.enable = true;
    this.extraMove = new THREE__namespace.Vector3();
    this.moveSpeed = moveSpeed ?? DEFAULT_MOVEMENT_SPEED;
    this.rollSpeed = rollSpeed ?? DEFAULT_ROLL_SPEED;
    this.stickThreshold = stickThreshold ?? DEFAULT_STICK_THRESHOLD;
    this.rotateSpeed = rotateSpeed ?? DEFAULT_FPS_ROTATE_SPEED;
    this.keycodeMoveMapping = keycodeMoveMapping ?? {
      ...WASD_KEYCODE_MOVE,
      ...ARROW_KEYCODE_MOVE
    };
    this.keycodeRotateMapping = keycodeRotateMapping ?? {
      // ...QE_KEYCODE_ROTATE,
      ...ARROW_KEYCODE_ROTATE
    };
    this.gamepadMapping = gamepadMapping ?? {
      4: "rollLeft",
      5: "rollRight",
      6: "ctrl",
      7: "shift"
    };
    this.capsMultiplier = capsMultiplier ?? 10;
    this.shiftMultiplier = shiftMultiplier ?? 5;
    this.ctrlMultiplier = ctrlMultiplier ?? 1 / 5;
    this.xr = xr;
    this.keydown = {};
    this.keycode = {};
    document.addEventListener("keydown", (event) => {
      this.keydown[event.key] = true;
      this.keycode[event.code] = true;
    });
    document.addEventListener("keyup", (event) => {
      this.keydown[event.key] = false;
      this.keycode[event.code] = false;
    });
    window.addEventListener("blur", () => {
      this.keydown = {};
      this.keycode = {};
    });
  }
  // Call this method in your render loop with `control` set to the object to control
  // (`THREE.Camera` or a `THREE.Object3D` that contains it), with `deltaTime`
  // in seconds since the last update.
  update(deltaTime, control) {
    var _a, _b;
    if (!this.enable) {
      return false;
    }
    const sticks = [new THREE__namespace.Vector2(), new THREE__namespace.Vector2()];
    const gamepad = navigator.getGamepads()[0];
    if (gamepad) {
      sticks[0].set(gamepad.axes[0], gamepad.axes[1]);
      sticks[1].set(gamepad.axes[2], gamepad.axes[3]);
    }
    const gamepadButtons = (gamepad == null ? void 0 : gamepad.buttons.map((button) => button.pressed)) || [];
    const xrSources = Array.from(((_b = (_a = this.xr) == null ? void 0 : _a.getSession()) == null ? void 0 : _b.inputSources) ?? []);
    for (const source of xrSources) {
      const gamepad2 = source.gamepad;
      if (gamepad2) {
        switch (source.handedness) {
          case "none": {
            sticks[0].x += gamepad2.axes[0];
            sticks[0].y += gamepad2.axes[1];
            sticks[1].x += gamepad2.axes[2];
            sticks[1].y += gamepad2.axes[3];
            break;
          }
          case "left": {
            sticks[0].x += gamepad2.axes[2];
            sticks[0].y += gamepad2.axes[3];
            break;
          }
          case "right": {
            sticks[1].x += gamepad2.axes[2];
            sticks[1].y += gamepad2.axes[3];
            break;
          }
        }
      }
    }
    for (const stick of sticks) {
      stick.x = Math.abs(stick.x) >= this.stickThreshold ? stick.x : 0;
      stick.y = Math.abs(stick.y) >= this.stickThreshold ? stick.y : 0;
    }
    const rotate = new THREE__namespace.Vector3(
      sticks[1].x,
      sticks[1].y,
      0
    ).multiplyScalar(this.rotateSpeed);
    for (const [keycode, rot] of Object.entries(this.keycodeRotateMapping)) {
      if (this.keycode[keycode]) {
        rotate.add(rot);
      }
    }
    for (const button in this.gamepadMapping) {
      if (gamepadButtons[Number.parseInt(button)]) {
        switch (this.gamepadMapping[button]) {
          case "rollLeft":
            rotate.z += 1;
            break;
          case "rollRight":
            rotate.z -= 1;
            break;
        }
      }
    }
    rotate.multiply(
      new THREE__namespace.Vector3(this.rotateSpeed, this.rotateSpeed, this.rollSpeed)
    );
    let updated = rotate.length() > MOVEMENT_THRESHOLD;
    if (rotate.manhattanLength() > 0) {
      rotate.multiplyScalar(deltaTime);
      const eulers = new THREE__namespace.Euler().setFromQuaternion(
        control.quaternion,
        "YXZ"
      );
      eulers.y -= rotate.x;
      eulers.x = Math.max(
        -Math.PI / 2,
        Math.min(Math.PI / 2, eulers.x - rotate.y)
      );
      eulers.z = Math.max(-Math.PI, Math.min(Math.PI, eulers.z + rotate.z));
      control.quaternion.setFromEuler(eulers);
    }
    const moveVector = new THREE__namespace.Vector3(sticks[0].x, 0, sticks[0].y);
    moveVector.add(this.extraMove);
    for (const [keycode, move] of Object.entries(this.keycodeMoveMapping)) {
      if (this.keycode[keycode]) {
        moveVector.add(move);
      }
    }
    let speedMultiplier = 1;
    if (this.keydown.CapsLock) {
      speedMultiplier *= this.capsMultiplier;
    }
    if (this.keycode.ShiftLeft || this.keycode.ShiftRight) {
      speedMultiplier *= this.shiftMultiplier;
    }
    if (this.keycode.ControlLeft || this.keycode.ControlRight) {
      speedMultiplier *= this.ctrlMultiplier;
    }
    for (const button in this.gamepadMapping) {
      if (gamepadButtons[Number.parseInt(button)]) {
        switch (this.gamepadMapping[button]) {
          case "shift":
            speedMultiplier *= this.shiftMultiplier;
            break;
          case "ctrl":
            speedMultiplier *= this.ctrlMultiplier;
            break;
        }
      }
    }
    if (moveVector.length() > MOVEMENT_THRESHOLD) {
      updated = true;
    }
    moveVector.applyQuaternion(control.quaternion);
    control.position.add(
      moveVector.multiplyScalar(this.moveSpeed * speedMultiplier * deltaTime)
    );
    return updated;
  }
}
class PointerControls {
  constructor({
    // The HTML canvas element to attach pointer events to
    canvas,
    // Speed of rotation (default DEFAULT_ROTATE_SPEED)
    rotateSpeed,
    // Speed of sliding when dragging with right/middle mouse button or two fingers
    // (default DEFAULT_SLIDE_SPEED)
    slideSpeed,
    // Speed of movement when using mouse scroll wheel (default DEFAULT_SCROLL_SPEED)
    scrollSpeed,
    // Swap the direction of rotation and sliding (default: false)
    swapRotateSlide,
    // Reverse the direction of rotation (default: false)
    reverseRotate,
    // Reverse the direction of sliding (default: false)
    reverseSlide,
    // Reverse the direction of swipe gestures (default: false)
    reverseSwipe,
    // Reverse the direction of scroll wheel movement (default: false)
    reverseScroll,
    // Inertia factor for movement (default: DEFAULT_MOVE_INERTIA)
    moveInertia,
    // Inertia factor for rotation (default: DEFAULT_ROTATE_INERTIA)
    rotateInertia,
    // Pointer rolling scale factor (default: DEFAULT_POINTER_ROLL_SCALE)
    pointerRollScale,
    // Callback for double press events (default: () => {})
    doublePress,
    // Time delay in ms for press move to start (default: DEFAULT_PRESS_MOVE_DELAY_MS)
    pressMoveDelayMs,
    // Time in ms for press move to accelerate (default: DEFAULT_PRESS_MOVE_ACCEL_MS)
    pressMoveAccelMs,
    // Speed of movement on press (default: 0)
    pressMoveSpeed,
    // Speed of movement on double press (default: pressMoveSpeed * 5.0)
    doublePressMoveSpeed,
    // Speed of movement on triple press (default: doublePressMoveSpeed * 5.0)
    triplePressMoveSpeed,
    // Whether to move toward the screen center or finger when pressing to move (default: true)
    pressMoveCenter
  }) {
    this.enable = true;
    this.canvas = canvas;
    this.rotateSpeed = rotateSpeed ?? DEFAULT_ROTATE_SPEED;
    this.slideSpeed = slideSpeed ?? DEFAULT_SLIDE_SPEED;
    this.scrollSpeed = scrollSpeed ?? DEFAULT_SCROLL_SPEED;
    this.swapRotateSlide = swapRotateSlide ?? false;
    this.reverseRotate = reverseRotate ?? (isAndroid() || isIos());
    this.reverseSlide = reverseSlide ?? false;
    this.reverseSwipe = reverseSwipe ?? false;
    this.reverseScroll = reverseScroll ?? false;
    this.moveInertia = moveInertia ?? DEFAULT_MOVE_INERTIA;
    this.rotateInertia = rotateInertia ?? DEFAULT_ROTATE_INERTIA;
    this.pointerRollScale = pointerRollScale ?? DEFAULT_POINTER_ROLL_SCALE;
    this.doublePress = doublePress ?? (() => {
    });
    this.doublePressLimitMs = DOUBLE_PRESS_LIMIT_MS;
    this.doublePressDistance = DOUBLE_PRESS_DISTANCE;
    this.pressMoveDelayMs = pressMoveDelayMs ?? DEFAULT_PRESS_MOVE_DELAY_MS;
    this.pressMoveAccelMs = pressMoveAccelMs ?? DEFAULT_PRESS_MOVE_ACCEL_MS;
    this.pressMoveSpeed = pressMoveSpeed ?? 0;
    this.doublePressMoveSpeed = doublePressMoveSpeed ?? this.pressMoveSpeed * 5;
    this.triplePressMoveSpeed = triplePressMoveSpeed ?? this.doublePressMoveSpeed * 5;
    this.pressMoveCenter = pressMoveCenter ?? true;
    this.doublePressed = void 0;
    this.triplePressed = false;
    this.lastUp = null;
    this.lastLastUp = null;
    this.rotating = null;
    this.sliding = null;
    this.lastDown = null;
    this.dualPress = false;
    this.scroll = new THREE__namespace.Vector3();
    this.rotateVelocity = new THREE__namespace.Vector3();
    this.moveVelocity = new THREE__namespace.Vector3();
    canvas.addEventListener("pointerdown", (event) => {
      const position = this.getPointerPosition(event);
      const initial = position.clone();
      const last = position.clone();
      const isRotate = !this.swapRotateSlide && !this.rotating && (event.pointerType !== "mouse" || event.button === 0) || this.swapRotateSlide && this.sliding && !this.rotating && (event.pointerType !== "mouse" || event.button === 1);
      const { pointerId } = event;
      const timeStamp = performance.now();
      if (isRotate) {
        this.rotating = { initial, last, position, pointerId, timeStamp };
        this.lastDown = this.rotating;
        canvas.setPointerCapture(event.pointerId);
        this.dualPress = false;
      } else if (!this.sliding) {
        const button = event.pointerType === "mouse" ? event.button : void 0;
        this.sliding = {
          initial,
          last,
          position,
          pointerId,
          button,
          timeStamp
        };
        this.lastDown = this.sliding;
        canvas.setPointerCapture(event.pointerId);
        this.dualPress = this.rotating != null && timeStamp - this.rotating.timeStamp < DUAL_PRESS_MS;
      }
      if (this.lastUp) {
        const distance2 = this.lastUp.position.distanceTo(position);
        const intervalMs = timeStamp - this.lastUp.timeStamp;
        if (distance2 < this.doublePressDistance && intervalMs < this.doublePressLimitMs) {
          this.doublePressed = performance.now();
          this.triplePressed = false;
          if (this.lastLastUp) {
            const lastDistance = this.lastLastUp.position.distanceTo(
              this.lastUp.position
            );
            const lastIntervalMs = this.lastUp.timeStamp - this.lastLastUp.timeStamp;
            if (lastDistance < this.doublePressDistance && lastIntervalMs < this.doublePressLimitMs) {
              this.triplePressed = true;
            }
          }
        }
      }
    });
    const pointerUp = (event) => {
      var _a, _b;
      if (((_a = this.rotating) == null ? void 0 : _a.pointerId) === event.pointerId) {
        this.rotating = null;
        canvas.releasePointerCapture(event.pointerId);
        if (this.dualPress && this.sliding) {
          canvas.releasePointerCapture(this.sliding.pointerId);
          this.sliding = null;
        }
      } else if (((_b = this.sliding) == null ? void 0 : _b.pointerId) === event.pointerId) {
        this.sliding = null;
        canvas.releasePointerCapture(event.pointerId);
        if (this.dualPress && this.rotating) {
          canvas.releasePointerCapture(this.rotating.pointerId);
          this.rotating = null;
        }
      }
      this.doublePressed = void 0;
      this.triplePressed = false;
      const position = this.getPointerPosition(event);
      const lastUp = this.lastUp;
      this.lastLastUp = this.lastUp;
      const timeStamp = performance.now();
      this.lastUp = { position, timeStamp };
      if (lastUp) {
        const distance2 = lastUp.position.distanceTo(position);
        if (distance2 < this.doublePressDistance) {
          const intervalMs = timeStamp - lastUp.timeStamp;
          if (intervalMs < this.doublePressLimitMs) {
            this.doublePress({ position, intervalMs });
          }
        }
      }
    };
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", pointerUp);
    document.addEventListener("pointermove", (event) => {
      var _a, _b;
      if (((_a = this.rotating) == null ? void 0 : _a.pointerId) === event.pointerId) {
        this.rotating.position = this.getPointerPosition(event);
      } else if (((_b = this.sliding) == null ? void 0 : _b.pointerId) === event.pointerId) {
        this.sliding.position = this.getPointerPosition(event);
      }
    });
    canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
    canvas.addEventListener("wheel", (event) => {
      this.scroll.add(
        new THREE__namespace.Vector3(event.deltaX, event.deltaY, event.deltaZ)
      );
      event.preventDefault();
    });
  }
  getPointerPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE__namespace.Vector2(
      event.clientX - rect.left,
      event.clientY - rect.top
    );
  }
  update(deltaTime, control, camera) {
    var _a, _b;
    if (!this.enable) {
      return false;
    }
    const now = performance.now();
    let updated = false;
    if (this.dualPress && this.rotating && this.sliding) {
      const motion = [
        this.rotating.position.clone().sub(this.rotating.last),
        this.sliding.position.clone().sub(this.sliding.last)
      ];
      const coincidence = motion[0].dot(motion[1]);
      if (coincidence >= 0.2) {
        const totalMotion = motion[0].clone().add(motion[1]);
        const slide = new THREE__namespace.Vector3(totalMotion.x, -totalMotion.y, 0);
        slide.multiplyScalar(this.slideSpeed * (this.reverseSwipe ? 1 : -1));
        slide.applyQuaternion(control.quaternion);
        control.position.add(slide);
        this.moveVelocity = slide.clone().multiplyScalar(1 / deltaTime);
        if (slide.length() > MOVEMENT_THRESHOLD) {
          updated = true;
        }
      } else if (coincidence <= -0.2) {
        const deltaDir = this.sliding.last.clone().sub(this.rotating.last);
        const deltaDist = deltaDir.length();
        deltaDir.multiplyScalar(1 / deltaDist).normalize();
        const orthoDir = new THREE__namespace.Vector2(-deltaDir.y, deltaDir.x);
        const motionDir = [motion[0].dot(deltaDir), motion[1].dot(deltaDir)];
        const motionOrtho = [motion[0].dot(orthoDir), motion[1].dot(orthoDir)];
        const midpoint = this.rotating.last.clone().add(this.sliding.last).multiplyScalar(0.5);
        let midpointDir = new THREE__namespace.Vector3();
        const theCamera = camera ?? (control instanceof THREE__namespace.Camera ? control : void 0);
        if (theCamera) {
          const ndcMidpoint = new THREE__namespace.Vector2(
            midpoint.x / this.canvas.clientWidth * 2 - 1,
            -(midpoint.y / this.canvas.clientHeight) * 2 + 1
          );
          const raycaster = new THREE__namespace.Raycaster();
          raycaster.setFromCamera(ndcMidpoint, theCamera);
          midpointDir = raycaster.ray.direction;
        }
        const pinchOut = motionDir[1] - motionDir[0];
        const slide = midpointDir.multiplyScalar(pinchOut * this.slideSpeed);
        control.position.add(slide);
        this.moveVelocity = slide.clone().multiplyScalar(1 / deltaTime);
        if (slide.length() > MOVEMENT_THRESHOLD) {
          updated = true;
        }
        const angles = [
          Math.atan(motionOrtho[0] / (-0.5 * deltaDist)),
          Math.atan(motionOrtho[1] / (0.5 * deltaDist))
        ];
        const rotate = 0.5 * (angles[0] + angles[1]) * this.pointerRollScale;
        const eulers = new THREE__namespace.Euler().setFromQuaternion(
          control.quaternion,
          "YXZ"
        );
        eulers.z = Math.max(
          -Math.PI,
          Math.min(Math.PI, eulers.z + 0.5 * rotate)
        );
        control.quaternion.setFromEuler(eulers);
        if (Math.abs(rotate) > MOVEMENT_THRESHOLD) {
          updated = true;
        }
      }
      this.rotating.last.copy(this.rotating.position);
      this.sliding.last.copy(this.sliding.position);
    } else {
      const rotate = new THREE__namespace.Vector3();
      if (this.rotating && !this.dualPress) {
        const delta = this.rotating.position.clone().sub(this.rotating.last);
        this.rotating.last.copy(this.rotating.position);
        rotate.set(delta.x, delta.y, 0);
        rotate.multiplyScalar(this.rotateSpeed * (this.reverseRotate ? -1 : 1));
        this.rotateVelocity = rotate.clone().multiplyScalar(1 / deltaTime);
        if (rotate.length() > MOVEMENT_THRESHOLD) {
          updated = true;
        }
      } else {
        this.rotateVelocity.multiplyScalar(
          Math.exp(-deltaTime / this.rotateInertia)
        );
        rotate.addScaledVector(this.rotateVelocity, deltaTime);
        if (this.rotateVelocity.length() * 0.1 > MOVEMENT_THRESHOLD) {
          updated = true;
        }
      }
      const eulers = new THREE__namespace.Euler().setFromQuaternion(
        control.quaternion,
        "YXZ"
      );
      eulers.y -= rotate.x;
      eulers.x = Math.max(
        -Math.PI / 2,
        Math.min(Math.PI / 2, eulers.x - rotate.y)
      );
      eulers.z *= Math.exp(-0 * deltaTime);
      control.quaternion.setFromEuler(eulers);
      if (this.sliding && !this.dualPress) {
        const delta = this.sliding.position.clone().sub(this.sliding.last);
        this.sliding.last.copy(this.sliding.position);
        const slide = this.sliding.button !== 2 ? new THREE__namespace.Vector3(delta.x, 0, delta.y) : new THREE__namespace.Vector3(delta.x, -delta.y, 0);
        slide.multiplyScalar(this.slideSpeed * (this.reverseSlide ? -1 : 1));
        slide.applyQuaternion(control.quaternion);
        control.position.add(slide);
        this.moveVelocity = slide.clone().multiplyScalar(1 / deltaTime);
        if (slide.length() > MOVEMENT_THRESHOLD) {
          updated = true;
        }
      } else {
        const target = new THREE__namespace.Vector3();
        if (this.sliding || this.rotating) {
          const point = ((_a = this.lastDown) == null ? void 0 : _a.last) ?? new THREE__namespace.Vector2();
          const theCamera = camera ?? (control instanceof THREE__namespace.Camera ? control : void 0);
          if (theCamera) {
            const ndcPoint = this.pressMoveCenter ? new THREE__namespace.Vector2(0, 0) : new THREE__namespace.Vector2(
              point.x / this.canvas.clientWidth * 2 - 1,
              -(point.y / this.canvas.clientHeight) * 2 + 1
            );
            const raycaster = new THREE__namespace.Raycaster();
            raycaster.setFromCamera(ndcPoint, theCamera);
            target.copy(raycaster.ray.direction).normalize();
          }
          if (!this.doublePressed) {
            let intensity = 0;
            if (this.lastDown) {
              intensity = (now - (((_b = this.lastDown) == null ? void 0 : _b.timeStamp) ?? now) - this.pressMoveDelayMs) / this.pressMoveAccelMs;
              if (this.lastDown.position.distanceTo(this.lastDown.initial) < this.doublePressDistance) {
                if (this.pressHeld === void 0) {
                  if (intensity > 0) {
                    this.pressHeld = true;
                  }
                }
              } else if (this.pressHeld === void 0) {
                this.pressHeld = false;
              }
            }
            if (this.pressHeld) {
              target.multiplyScalar(
                this.pressMoveSpeed * Math.max(0, Math.min(1, intensity))
              );
            } else {
              target.set(0, 0, 0);
            }
          } else {
            this.pressHeld = false;
            let intensity = (performance.now() - this.doublePressed) / this.pressMoveAccelMs;
            intensity = Math.max(0, Math.min(1, intensity));
            target.multiplyScalar(
              (this.triplePressed ? this.triplePressMoveSpeed : this.doublePressMoveSpeed) * intensity
            );
          }
        } else {
          this.pressHeld = void 0;
        }
        const s = Math.exp(-deltaTime / this.moveInertia);
        this.moveVelocity.lerpVectors(target, this.moveVelocity, s);
        control.position.addScaledVector(this.moveVelocity, deltaTime);
        if (this.moveVelocity.length() * 0.1 > MOVEMENT_THRESHOLD) {
          updated = true;
        }
      }
    }
    const scroll = this.scroll.multiplyScalar(this.scrollSpeed);
    scroll.set(scroll.x, scroll.z, scroll.y);
    if (this.reverseScroll) {
      scroll.multiplyScalar(-1);
    }
    scroll.applyQuaternion(control.quaternion);
    control.position.add(scroll);
    if (scroll.length() > MOVEMENT_THRESHOLD) {
      updated = true;
    }
    this.scroll.set(0, 0, 0);
    return updated;
  }
}
const DISK_PORTAL_FRAGMENT_SHADER = `
precision highp float;
precision highp int;

#include <splatDefines>

uniform float near;
uniform float far;
uniform mat4 projectionMatrix;
uniform bool encodeLinear;
uniform float time;
uniform bool debugFlag;
uniform float maxStdDev;
uniform float minAlpha;
uniform bool disableFalloff;
uniform float falloff;

uniform vec3 diskCenter;
uniform vec3 diskNormal;
uniform float diskRadius;
uniform bool diskTwoSided;

out vec4 fragColor;

in vec4 vRgba;
in vec2 vSplatUv;
in vec3 vNdc;
flat in uint vSplatIndex;
flat in float adjustedStdDev;

void main() {
    if (diskRadius != 0.0) {
        // Portal rendering:
        // - diskRadius > 0: render "behind portal" only through the disk (discard outside or in-front-of plane).
        // - diskRadius < 0: render "in front of portal" everywhere, but discard fragments behind the plane when looking through the disk.

        // View ray direction from NDC (view space is -Z forward).
        vec3 viewDir = normalize(vec3(
            vNdc.x / projectionMatrix[0][0],
            vNdc.y / projectionMatrix[1][1],
            -1.0
        ));

        // Reconstruct view-space *axial* depth (-viewPos.z) from NDC Z.
        float ndcZ = vNdc.z;
        float depth = (2.0 * near * far) / (far + near - ndcZ * (far - near));
        // Convert axial depth to ray-parameter t (viewPos = t * viewDir).
        float rayT = depth / max(1e-6, -viewDir.z);

        float radius = abs(diskRadius);
        float radius2 = radius * radius;
        bool renderBehind = (diskRadius > 0.0);

        vec3 diskN = normalize(diskNormal);

        // Ray-plane intersection for plane (diskCenter, diskN), with ray origin at (0,0,0).
        float denom = dot(viewDir, diskN);
        bool allowPortal = diskTwoSided ? (abs(denom) > 1e-6) : (denom < -1e-6);

        bool hitsDisk = false;
        float t = 0.0;
        if (allowPortal) {
            t = dot(diskCenter, diskN) / denom;
            if (t > 0.0) {
                vec3 q = t * viewDir - diskCenter;
                hitsDisk = (dot(q, q) <= radius2);
            }
        }

        // Small bias to avoid flicker at the plane.
        float eps = 1e-4 * max(1.0, abs(t));

        if (renderBehind) {
            // Behind-pass: only render through the portal disk, and only behind the plane along the ray.
            if (!hitsDisk) discard;
            if (rayT <= t + eps) discard;
        } else {
            // Front-pass: render everything, except when the ray goes through the disk, discard what's behind the plane.
            if (hitsDisk && (rayT >= t - eps)) discard;
        }
    }

    vec4 rgba = vRgba;

    float z2 = dot(vSplatUv, vSplatUv);
    if (z2 > (adjustedStdDev * adjustedStdDev)) {
        discard;
    }

    float a = rgba.a;
    float shifted = sqrt(z2) - max(0.0, a - 1.0);
    float exponent = -0.5 * max(1.0, a) * sqr(max(0.0, shifted));
    rgba.a = min(1.0, a) * exp(exponent);

    if (rgba.a < minAlpha) {
        discard;
    }
    if (encodeLinear) {
        rgba.rgb = srgbToLinear(rgba.rgb);
    }

    #ifdef PREMULTIPLIED_ALPHA
        fragColor = vec4(rgba.rgb * rgba.a, rgba.a);
    #else
        fragColor = rgba;
    #endif
}
`;
class SparkPortals {
  constructor(options) {
    this.portalPairs = [];
    this.lastCameraWorld = new THREE__namespace.Vector3().setScalar(Number.NaN);
    this.scratch = {
      quat: new THREE__namespace.Quaternion(),
      scale: new THREE__namespace.Vector3(),
      center0: new THREE__namespace.Vector3(),
      center1: new THREE__namespace.Vector3(),
      normal0: new THREE__namespace.Vector3(),
      normal1: new THREE__namespace.Vector3(),
      centerT: new THREE__namespace.Vector3(),
      normalT: new THREE__namespace.Vector3(),
      prevCameraWorld: new THREE__namespace.Vector3(),
      currCameraWorld: new THREE__namespace.Vector3(),
      hit: new THREE__namespace.Vector3(),
      offset: new THREE__namespace.Vector3(),
      camWorld: new THREE__namespace.Matrix4(),
      newCamWorld: new THREE__namespace.Matrix4(),
      invCamLocal: new THREE__namespace.Matrix4(),
      newLocalFrame: new THREE__namespace.Matrix4(),
      cameraWorldPos: new THREE__namespace.Vector3(),
      viewDir: new THREE__namespace.Vector3(),
      portalCenter: new THREE__namespace.Vector3(),
      toPortal: new THREE__namespace.Vector3()
    };
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.localFrame = options.localFrame;
    this.defaultPortalRadius = options.defaultPortalRadius ?? 1;
    this.portalCrossEps = options.portalCrossEps ?? 1e-6;
    const sparkOpts = options.sparkOptions ?? {};
    this.portalRenderer = new SparkRenderer({
      renderer: this.renderer,
      extraUniforms: {
        diskCenter: { value: new THREE__namespace.Vector3() },
        diskNormal: { value: new THREE__namespace.Vector3() },
        diskRadius: { value: 0 },
        diskTwoSided: { value: false }
      },
      fragmentShader: DISK_PORTAL_FRAGMENT_SHADER,
      ...sparkOpts
    });
    this.scene.add(this.portalRenderer);
    this.behindRenderer = new SparkRenderer({
      renderer: this.renderer,
      ...sparkOpts
    });
    this.camera2 = this.camera.clone();
    this.scene.add(this.camera2);
  }
  /**
   * Add a new portal pair to the system.
   * @param options Optional configuration for this pair
   * @returns The created PortalPair - position the entryPortal and exitPortal as needed
   */
  addPortalPair(options) {
    const pair = {
      entryPortal: new THREE__namespace.Object3D(),
      exitPortal: new THREE__namespace.Object3D(),
      radius: (options == null ? void 0 : options.radius) ?? this.defaultPortalRadius,
      onCross: options == null ? void 0 : options.onCross,
      _entryBefore: new THREE__namespace.Matrix4(),
      _exitBefore: new THREE__namespace.Matrix4()
    };
    this.scene.add(pair.entryPortal);
    this.scene.add(pair.exitPortal);
    this.portalPairs.push(pair);
    return pair;
  }
  /**
   * Remove a portal pair from the system.
   */
  removePortalPair(pair) {
    const index = this.portalPairs.indexOf(pair);
    if (index !== -1) {
      this.scene.remove(pair.entryPortal);
      this.scene.remove(pair.exitPortal);
      this.portalPairs.splice(index, 1);
    }
  }
  /**
   * Get transform from entry portal to exit portal.
   */
  getEntryToExitTransform(pair) {
    return pair.entryPortal.matrixWorld.clone().invert().premultiply(pair.exitPortal.matrixWorld);
  }
  /**
   * Get transform from exit portal to entry portal.
   */
  getExitToEntryTransform(pair) {
    return pair.exitPortal.matrixWorld.clone().invert().premultiply(pair.entryPortal.matrixWorld);
  }
  /** Set portal disk uniforms for shader clipping */
  setPortalDiskUniforms(camera, portal, radius, twoSided) {
    camera.updateMatrixWorld(true);
    portal.updateMatrixWorld(true);
    const inverseCamera = camera.matrixWorld.clone().invert();
    const portalInCamera = portal.matrixWorld.clone().premultiply(inverseCamera);
    const portalQuat = new THREE__namespace.Quaternion();
    const uniforms = this.portalRenderer.uniforms;
    portalInCamera.decompose(
      uniforms.diskCenter.value,
      portalQuat,
      new THREE__namespace.Vector3()
    );
    uniforms.diskNormal.value.set(0, 0, 1).applyQuaternion(portalQuat);
    uniforms.diskRadius.value = radius;
    uniforms.diskTwoSided.value = twoSided;
  }
  /** Extract portal plane from matrix */
  getPortalPlane(matrix, outCenter, outNormal) {
    matrix.decompose(outCenter, this.scratch.quat, this.scratch.scale);
    outNormal.set(0, 0, 1).applyQuaternion(this.scratch.quat).normalize();
  }
  /**
   * Detect if the user path crosses over a portal. If so, return the parametric position (0,1)
   * along the segment where the crossing occurs. If not, return null.
   */
  getSegmentDiskCrossing(prevCam, currCam, beforeMatrix, afterMatrix, radius) {
    this.getPortalPlane(
      beforeMatrix,
      this.scratch.center0,
      this.scratch.normal0
    );
    this.getPortalPlane(
      afterMatrix,
      this.scratch.center1,
      this.scratch.normal1
    );
    const startPlaneDist = this.scratch.offset.copy(prevCam).sub(this.scratch.center0).dot(this.scratch.normal0);
    const endPlaneDist = this.scratch.offset.copy(currCam).sub(this.scratch.center1).dot(this.scratch.normal1);
    if (startPlaneDist > this.portalCrossEps && endPlaneDist > this.portalCrossEps || startPlaneDist < -this.portalCrossEps && endPlaneDist < -this.portalCrossEps) {
      return null;
    }
    const denom = startPlaneDist - endPlaneDist;
    if (Math.abs(denom) < this.portalCrossEps) return null;
    const t = startPlaneDist / denom;
    if (t < 0 || t > 1) return null;
    this.scratch.hit.lerpVectors(prevCam, currCam, t);
    this.scratch.centerT.copy(this.scratch.center0).lerp(this.scratch.center1, t);
    this.scratch.normalT.copy(this.scratch.normal0).lerp(this.scratch.normal1, t).normalize();
    this.scratch.offset.copy(this.scratch.hit).sub(this.scratch.centerT);
    this.scratch.offset.addScaledVector(
      this.scratch.normalT,
      -this.scratch.offset.dot(this.scratch.normalT)
    );
    if (this.scratch.offset.lengthSq() > radius * radius) return null;
    return t;
  }
  /** Teleport camera through portal */
  teleport(transform) {
    this.scratch.camWorld.copy(this.camera.matrixWorld);
    this.scratch.newCamWorld.copy(this.scratch.camWorld).premultiply(transform);
    this.scratch.invCamLocal.copy(this.camera.matrix).invert();
    this.scratch.newLocalFrame.copy(this.scratch.newCamWorld).multiply(this.scratch.invCamLocal);
    this.scratch.newLocalFrame.decompose(
      this.localFrame.position,
      this.localFrame.quaternion,
      this.localFrame.scale
    );
    this.localFrame.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
  }
  /**
   * Check for portal crossing and teleport if needed.
   * Checks all portal pairs and takes the earliest crossing.
   * Call this after updating controls but before render().
   */
  updateTeleportation() {
    if (this.portalPairs.length === 0) return;
    this.camera.getWorldPosition(this.scratch.currCameraWorld);
    if (!Number.isFinite(this.lastCameraWorld.x)) {
      this.lastCameraWorld.copy(this.scratch.currCameraWorld);
      return;
    }
    this.scratch.prevCameraWorld.copy(this.lastCameraWorld);
    let earliestT = null;
    let crossedPair = null;
    let crossedEntry = true;
    for (const pair of this.portalPairs) {
      pair.entryPortal.updateMatrixWorld(true);
      pair.exitPortal.updateMatrixWorld(true);
      pair._entryBefore.copy(pair.entryPortal.matrixWorld);
      pair._exitBefore.copy(pair.exitPortal.matrixWorld);
      const entryT = this.getSegmentDiskCrossing(
        this.scratch.prevCameraWorld,
        this.scratch.currCameraWorld,
        pair._entryBefore,
        pair.entryPortal.matrixWorld,
        pair.radius
      );
      if (entryT !== null && (earliestT === null || entryT < earliestT)) {
        earliestT = entryT;
        crossedPair = pair;
        crossedEntry = true;
      }
      const exitT = this.getSegmentDiskCrossing(
        this.scratch.prevCameraWorld,
        this.scratch.currCameraWorld,
        pair._exitBefore,
        pair.exitPortal.matrixWorld,
        pair.radius
      );
      if (exitT !== null && (earliestT === null || exitT < earliestT)) {
        earliestT = exitT;
        crossedPair = pair;
        crossedEntry = false;
      }
    }
    if (crossedPair === null) {
      this.lastCameraWorld.copy(this.scratch.currCameraWorld);
      return;
    }
    if (crossedEntry) {
      this.teleport(this.getEntryToExitTransform(crossedPair));
    } else {
      this.teleport(this.getExitToEntryTransform(crossedPair));
    }
    this.camera.getWorldPosition(this.lastCameraWorld);
    if (crossedPair.onCross) {
      Promise.resolve(crossedPair.onCross(crossedPair, crossedEntry)).catch(
        (error) => {
          console.error("Error in portal onCross callback:", error);
        }
      );
    }
  }
  /**
   * Find the most relevant portal for rendering (closest to camera view direction).
   * Returns the portal pair and which portal (entry or exit) is primary.
   */
  findPrimaryPortal() {
    if (this.portalPairs.length === 0) return null;
    this.camera.getWorldPosition(this.scratch.cameraWorldPos);
    this.camera.getWorldDirection(this.scratch.viewDir);
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestPair = null;
    let bestIsEntry = true;
    for (const pair of this.portalPairs) {
      pair.entryPortal.getWorldPosition(this.scratch.portalCenter);
      this.scratch.toPortal.copy(this.scratch.portalCenter).sub(this.scratch.cameraWorldPos);
      const entryDist = this.scratch.toPortal.length();
      const entryScore = this.scratch.toPortal.normalize().dot(this.scratch.viewDir) / entryDist;
      if (entryScore > bestScore) {
        bestScore = entryScore;
        bestPair = pair;
        bestIsEntry = true;
      }
      pair.exitPortal.getWorldPosition(this.scratch.portalCenter);
      this.scratch.toPortal.copy(this.scratch.portalCenter).sub(this.scratch.cameraWorldPos);
      const exitDist = this.scratch.toPortal.length();
      const exitScore = this.scratch.toPortal.normalize().dot(this.scratch.viewDir) / exitDist;
      if (exitScore > bestScore) {
        bestScore = exitScore;
        bestPair = pair;
        bestIsEntry = false;
      }
    }
    if (!bestPair) return null;
    return {
      pair: bestPair,
      primaryIsEntry: bestIsEntry,
      primaryPortal: bestIsEntry ? bestPair.entryPortal : bestPair.exitPortal,
      otherPortal: bestIsEntry ? bestPair.exitPortal : bestPair.entryPortal
    };
  }
  /**
   * Render the scene with portals using two-pass rendering.
   * Renders the most relevant portal pair (closest to camera view).
   * Call this instead of renderer.render() in your animation loop.
   */
  render() {
    const primary = this.findPrimaryPortal();
    if (!primary) {
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const { pair, primaryIsEntry, primaryPortal, otherPortal } = primary;
    const camera2Matrix = primaryIsEntry ? this.camera.matrixWorld.clone().premultiply(this.getEntryToExitTransform(pair)) : this.camera.matrixWorld.clone().premultiply(this.getExitToEntryTransform(pair));
    camera2Matrix.decompose(
      this.camera2.position,
      this.camera2.quaternion,
      this.camera2.scale
    );
    this.camera2.updateMatrixWorld(true);
    this.setPortalDiskUniforms(this.camera2, otherPortal, pair.radius, true);
    this.renderer.autoClear = true;
    this.behindRenderer.render(this.scene, this.camera2);
    this.setPortalDiskUniforms(this.camera, primaryPortal, -pair.radius, true);
    this.renderer.autoClear = false;
    this.portalRenderer.render(this.scene, this.camera);
  }
  /**
   * Convenience hook for animation loop.
   * Calls updateTeleportation() then render().
   */
  animateLoopHook() {
    this.updateTeleportation();
    this.render();
  }
  /** Update camera2 aspect ratio on window resize */
  updateAspect(aspect) {
    this.camera2.aspect = aspect;
    this.camera2.updateProjectionMatrix();
  }
  /** Dispose of resources */
  dispose() {
    this.scene.remove(this.portalRenderer);
    this.scene.remove(this.camera2);
    for (const pair of this.portalPairs) {
      this.scene.remove(pair.entryPortal);
      this.scene.remove(pair.exitPortal);
    }
    this.portalPairs = [];
    this.portalRenderer.dispose();
    this.behindRenderer.dispose();
  }
}
exports.DEFAULT_CONTROLLER_FAST_MULTIPLIER = DEFAULT_CONTROLLER_FAST_MULTIPLIER;
exports.DEFAULT_CONTROLLER_GETFAST = DEFAULT_CONTROLLER_GETFAST;
exports.DEFAULT_CONTROLLER_GETMOVE = DEFAULT_CONTROLLER_GETMOVE;
exports.DEFAULT_CONTROLLER_GETROTATE = DEFAULT_CONTROLLER_GETROTATE;
exports.DEFAULT_CONTROLLER_GETSLOW = DEFAULT_CONTROLLER_GETSLOW;
exports.DEFAULT_CONTROLLER_MOVE_HEADING = DEFAULT_CONTROLLER_MOVE_HEADING;
exports.DEFAULT_CONTROLLER_MOVE_SPEED = DEFAULT_CONTROLLER_MOVE_SPEED;
exports.DEFAULT_CONTROLLER_ROLL_SPEED = DEFAULT_CONTROLLER_ROLL_SPEED;
exports.DEFAULT_CONTROLLER_ROTATE_SPEED = DEFAULT_CONTROLLER_ROTATE_SPEED;
exports.DEFAULT_CONTROLLER_SLOW_MULTIPLIER = DEFAULT_CONTROLLER_SLOW_MULTIPLIER;
exports.DISK_PORTAL_FRAGMENT_SHADER = DISK_PORTAL_FRAGMENT_SHADER;
exports.ExtSplats = ExtSplats;
exports.FINGER_TIPS = FINGER_TIPS;
exports.FpsMovement = FpsMovement;
exports.HANDS = HANDS;
exports.Hand = Hand;
exports.HandMovement = HandMovement;
exports.JOINT_IDS = JOINT_IDS;
exports.JOINT_INDEX = JOINT_INDEX;
exports.JOINT_RADIUS = JOINT_RADIUS;
exports.JOINT_SEGMENTS = JOINT_SEGMENTS;
exports.JOINT_SEGMENT_STEPS = JOINT_SEGMENT_STEPS;
exports.JOINT_TIPS = JOINT_TIPS;
exports.JointEnum = JointEnum;
exports.JointSplats = JointSplats;
exports.LN_SCALE_MAX = LN_SCALE_MAX;
exports.LN_SCALE_MIN = LN_SCALE_MIN;
exports.NUM_JOINTS = NUM_JOINTS;
exports.PackedSplats = PackedSplats;
exports.PointerControls = PointerControls;
exports.Readback = Readback;
exports.RgbaArray = RgbaArray;
exports.Sint8ToFloat = Sint8ToFloat;
exports.SparkControls = SparkControls;
exports.SparkPortals = SparkPortals;
exports.SparkRenderer = SparkRenderer;
exports.SparkXr = SparkXr;
exports.SplatAccumulator = SplatAccumulator;
exports.SplatEdit = SplatEdit;
exports.SplatEditRgbaBlendMode = SplatEditRgbaBlendMode;
exports.SplatEditSdf = SplatEditSdf;
exports.SplatEditSdfType = SplatEditSdfType;
exports.SplatEdits = SplatEdits;
exports.SplatFileType = SplatFileType;
exports.SplatGenerator = SplatGenerator;
exports.SplatLoader = SplatLoader;
exports.SplatMesh = SplatMesh;
exports.SplatModifier = SplatModifier;
exports.SplatSkinning = SplatSkinning;
exports.SplatSkinningMode = SplatSkinningMode;
exports.SplatTransformer = SplatTransformer;
exports.Uint8ToFloat = Uint8ToFloat;
exports.XrHand = XrHand;
exports.XrHands = XrHands;
exports.constructAxes = constructAxes;
exports.constructGrid = constructGrid;
exports.constructSpherePoints = constructSpherePoints;
exports.defines = defines;
exports.dyno = dyno;
exports.flipPixels = flipPixels;
exports.floatToSint8 = floatToSint8;
exports.floatToUint8 = floatToUint8;
exports.fromHalf = fromHalf;
exports.generators = generators;
exports.imageSplats = imageSplats;
exports.isAndroid = isAndroid;
exports.isIos = isIos;
exports.isMobile = isMobile;
exports.isOculus = isOculus;
exports.isQuest2 = isQuest2;
exports.isVisionPro = isVisionPro;
exports.lerpHandsSnapshots = lerpHandsSnapshots;
exports.modifiers = modifiers;
exports.pixelsToPngUrl = pixelsToPngUrl;
exports.readRgbaArray = readRgbaArray;
exports.setPackedSplat = setPackedSplat;
exports.textSplats = textSplats;
exports.toHalf = toHalf;
exports.unpackSplat = unpackSplat;
exports.utils = utils;
//# sourceMappingURL=gaussian-splat-lite.cjs.map
