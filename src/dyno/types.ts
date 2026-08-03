import type * as THREE from "three";

export type BoolTypes = "bool" | "bvec2" | "bvec3" | "bvec4";
export type IntTypes = "int" | "ivec2" | "ivec3" | "ivec4";
export type UintTypes = "uint" | "uvec2" | "uvec3" | "uvec4";
export type AllIntTypes = IntTypes | UintTypes;
export type FloatTypes = "float" | "vec2" | "vec3" | "vec4";
export type ScalarTypes = "uint" | "int" | "float";
export type Vector2Types = "vec2" | "ivec2" | "uvec2";
export type Vector3Types = "vec3" | "ivec3" | "uvec3";
export type Vector4Types = "vec4" | "ivec4" | "uvec4";
export type VectorTypes = Vector2Types | Vector3Types | Vector4Types;
export type MatFloatTypes =
  | "mat2"
  | "mat2x2"
  | "mat2x3"
  | "mat2x4"
  | "mat3"
  | "mat3x2"
  | "mat3x3"
  | "mat3x4"
  | "mat4"
  | "mat4x2"
  | "mat4x3"
  | "mat4x4";
export type SquareMatTypes =
  | "mat2"
  | "mat3"
  | "mat4"
  | "mat2x2"
  | "mat3x3"
  | "mat4x4";
export type AllFloatTypes = FloatTypes | MatFloatTypes;
export type SignedTypes = IntTypes | FloatTypes;
export type AllSignedTypes = SignedTypes | MatFloatTypes;
export type ValueTypes = FloatTypes | IntTypes | UintTypes;
export type AllValueTypes = AllFloatTypes | IntTypes | UintTypes;
export type SimpleTypes = BoolTypes | AllValueTypes;

export type VectorElementType<A extends VectorTypes> = A extends FloatTypes
  ? "float"
  : A extends IntTypes
    ? "int"
    : A extends UintTypes
      ? "uint"
      : never;

export type SameSizeVec<T extends ValueTypes> = T extends ScalarTypes
  ? "float"
  : T extends "vec2" | "ivec2" | "uvec2"
    ? "vec2"
    : T extends "vec3" | "ivec3" | "uvec3"
      ? "vec3"
      : T extends "vec4" | "ivec4" | "uvec4"
        ? "vec4"
        : never;

export type SameSizeUvec<T extends ValueTypes> = T extends ScalarTypes
  ? "uint"
  : T extends "vec2" | "ivec2" | "uvec2"
    ? "uvec2"
    : T extends "vec3" | "ivec3" | "uvec3"
      ? "uvec3"
      : T extends "vec4" | "ivec4" | "uvec4"
        ? "uvec4"
        : never;

export type SameSizeIvec<T extends ValueTypes> = T extends ScalarTypes
  ? "int"
  : T extends "vec2" | "ivec2" | "uvec2"
    ? "ivec2"
    : T extends "vec3" | "ivec3" | "uvec3"
      ? "ivec3"
      : T extends "vec4" | "ivec4" | "uvec4"
        ? "ivec4"
        : never;

export type SamplerTypes =
  | "sampler2D"
  | "sampler2DArray"
  | "sampler3D"
  | "samplerCube";
export type UsamplerTypes =
  | "usampler2D"
  | "usampler2DArray"
  | "usampler3D"
  | "usamplerCube";
export type IsamplerTypes =
  | "isampler2D"
  | "isampler2DArray"
  | "isampler3D"
  | "isamplerCube";
export type NormalSamplerTypes = SamplerTypes | UsamplerTypes | IsamplerTypes;
export type SamplerShadowTypes =
  | "sampler2DShadow"
  | "sampler2DArrayShadow"
  | "samplerCubeShadow";
export type AllSamplerTypes = NormalSamplerTypes | SamplerShadowTypes;
export type Sampler2DTypes =
  | "sampler2D"
  | "usampler2D"
  | "isampler2D"
  | "sampler2DShadow";
export type Sampler2DArrayTypes =
  | "sampler2DArray"
  | "usampler2DArray"
  | "isampler2DArray"
  | "sampler2DArrayShadow";
export type Sampler3DTypes = "sampler3D" | "usampler3D" | "isampler3D";
export type SamplerCubeTypes =
  | "samplerCube"
  | "usamplerCube"
  | "isamplerCube"
  | "samplerCubeShadow";

export function isBoolType(type: DynoType): boolean {
  return (
    type === "bool" || type === "bvec2" || type === "bvec3" || type === "bvec4"
  );
}

export function isScalarType(type: DynoType): boolean {
  return type === "int" || type === "uint" || type === "float";
}

export function isIntType(type: DynoType): boolean {
  return (
    type === "int" || type === "ivec2" || type === "ivec3" || type === "ivec4"
  );
}

export function isUintType(type: DynoType): boolean {
  return (
    type === "uint" || type === "uvec2" || type === "uvec3" || type === "uvec4"
  );
}

export function isFloatType(type: DynoType): boolean {
  return (
    type === "float" || type === "vec2" || type === "vec3" || type === "vec4"
  );
}

export function isMatFloatType(type: DynoType): boolean {
  return (
    type === "mat2" ||
    type === "mat2x2" ||
    type === "mat2x3" ||
    type === "mat2x4" ||
    type === "mat3" ||
    type === "mat3x2" ||
    type === "mat3x3" ||
    type === "mat3x4" ||
    type === "mat4" ||
    type === "mat4x2" ||
    type === "mat4x3" ||
    type === "mat4x4"
  );
}

export function isAllFloatType(type: DynoType): boolean {
  return isFloatType(type) || isMatFloatType(type);
}

export function isVector2Type(type: DynoType): boolean {
  return type === "vec2" || type === "ivec2" || type === "uvec2";
}

export function isVector3Type(type: DynoType): boolean {
  return type === "vec3" || type === "ivec3" || type === "uvec3";
}

export function isVector4Type(type: DynoType): boolean {
  return type === "vec4" || type === "ivec4" || type === "uvec4";
}

export function isVectorType(type: DynoType): boolean {
  return isVector2Type(type) || isVector3Type(type) || isVector4Type(type);
}

export function isMat2(type: DynoType): boolean {
  return type === "mat2" || type === "mat2x2";
}
export function isMat3(type: DynoType): boolean {
  return type === "mat3" || type === "mat3x3";
}
export function isMat4(type: DynoType): boolean {
  return type === "mat4" || type === "mat4x4";
}

export function vectorElementType<A extends VectorTypes>(
  type: A,
): VectorElementType<A> {
  switch (type) {
    case "vec2":
      return "float" as VectorElementType<A>;
    case "vec3":
      return "float" as VectorElementType<A>;
    case "vec4":
      return "float" as VectorElementType<A>;
    case "ivec2":
      return "int" as VectorElementType<A>;
    case "ivec3":
      return "int" as VectorElementType<A>;
    case "ivec4":
      return "int" as VectorElementType<A>;
    case "uvec2":
      return "uint" as VectorElementType<A>;
    case "uvec3":
      return "uint" as VectorElementType<A>;
    case "uvec4":
      return "uint" as VectorElementType<A>;
    default:
      throw new Error(`Invalid vector type: ${type}`);
  }
}

export function vectorDim<A extends VectorTypes>(type: A): number {
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

export function sameSizeVec<T extends ValueTypes>(type: T): SameSizeVec<T> {
  if (isScalarType(type)) {
    return "float" as SameSizeVec<T>;
  }
  if (isVector2Type(type)) {
    return "vec2" as SameSizeVec<T>;
  }
  if (isVector3Type(type)) {
    return "vec3" as SameSizeVec<T>;
  }
  if (isVector4Type(type)) {
    return "vec4" as SameSizeVec<T>;
  }
  throw new Error(`Invalid vector type: ${type}`);
}

export function sameSizeUvec<T extends ValueTypes>(type: T): SameSizeUvec<T> {
  if (isScalarType(type)) {
    return "uint" as SameSizeUvec<T>;
  }
  if (isVector2Type(type)) {
    return "uvec2" as SameSizeUvec<T>;
  }
  if (isVector3Type(type)) {
    return "uvec3" as SameSizeUvec<T>;
  }
  if (isVector4Type(type)) {
    return "uvec4" as SameSizeUvec<T>;
  }
  throw new Error(`Invalid vector type: ${type}`);
}

export function sameSizeIvec<T extends ValueTypes>(type: T): SameSizeIvec<T> {
  if (isScalarType(type)) {
    return "int" as SameSizeIvec<T>;
  }
  if (isVector2Type(type)) {
    return "ivec2" as SameSizeIvec<T>;
  }
  if (isVector3Type(type)) {
    return "ivec3" as SameSizeIvec<T>;
  }
  if (isVector4Type(type)) {
    return "ivec4" as SameSizeIvec<T>;
  }
  throw new Error(`Invalid vector type: ${type}`);
}

export type BaseType = SimpleTypes | AllSamplerTypes;
export type UserType = { type: string };
export type DynoType = BaseType | UserType;

export type DynoJsType<T extends DynoType> = T extends "bool"
  ? boolean
  : T extends "uint"
    ? number
    : T extends "int"
      ? number
      : T extends "float"
        ? number
        : T extends "bvec2"
          ? [boolean, boolean]
          : T extends "uvec2"
            ? THREE.Vector2 | [number, number] | Uint32Array
            : T extends "ivec2"
              ? THREE.Vector2 | [number, number] | Int32Array
              : T extends "vec2"
                ? THREE.Vector2 | [number, number] | Float32Array
                : T extends "bvec3"
                  ? [boolean, boolean, boolean]
                  : T extends "uvec3"
                    ? THREE.Vector3 | [number, number, number] | Uint32Array
                    : T extends "ivec3"
                      ? THREE.Vector3 | [number, number, number] | Int32Array
                      : T extends "vec3"
                        ?
                            | THREE.Vector3
                            | THREE.Color
                            | [number, number, number]
                            | Float32Array
                        : T extends "bvec4"
                          ? [boolean, boolean, boolean, boolean]
                          : T extends "uvec4"
                            ?
                                | THREE.Vector4
                                | [number, number, number, number]
                                | Uint32Array
                            : T extends "ivec4"
                              ?
                                  | THREE.Vector4
                                  | [number, number, number, number]
                                  | Int32Array
                              : T extends "vec4"
                                ?
                                    | THREE.Vector4
                                    | THREE.Quaternion
                                    | [number, number, number, number]
                                    | Float32Array
                                : T extends "mat2"
                                  ? THREE.Matrix2 | Float32Array
                                  : T extends "mat2x2"
                                    ? THREE.Matrix2 | Float32Array
                                    : T extends "mat2x3"
                                      ? Float32Array
                                      : T extends "mat2x4"
                                        ? Float32Array
                                        : T extends "mat3"
                                          ? THREE.Matrix3 | Float32Array
                                          : T extends "mat3x2"
                                            ? Float32Array
                                            : T extends "mat3x3"
                                              ? THREE.Matrix3 | Float32Array
                                              : T extends "mat3x4"
                                                ? Float32Array
                                                : T extends "mat4"
                                                  ? THREE.Matrix4 | Float32Array
                                                  : T extends "mat4x2"
                                                    ? Float32Array
                                                    : T extends "mat4x3"
                                                      ? Float32Array
                                                      : T extends "mat4x4"
                                                        ?
                                                            | THREE.Matrix4
                                                            | Float32Array
                                                        : T extends "usampler2D"
                                                          ? THREE.Texture
                                                          : T extends "isampler2D"
                                                            ? THREE.Texture
                                                            : T extends "sampler2D"
                                                              ? THREE.Texture
                                                              : T extends "sampler2DShadow"
                                                                ? THREE.Texture
                                                                : T extends "usampler2DArray"
                                                                  ? THREE.DataArrayTexture
                                                                  : T extends "isampler2DArray"
                                                                    ? THREE.DataArrayTexture
                                                                    : T extends "sampler2DArray"
                                                                      ? THREE.DataArrayTexture
                                                                      : T extends "sampler2DArrayShadow"
                                                                        ? THREE.Texture
                                                                        : T extends "usampler3D"
                                                                          ? THREE.DataArrayTexture
                                                                          : T extends "isampler3D"
                                                                            ? THREE.DataArrayTexture
                                                                            : T extends "sampler3D"
                                                                              ? THREE.DataArrayTexture
                                                                              : T extends "usamplerCube"
                                                                                ? THREE.DataArrayTexture
                                                                                : T extends "isamplerCube"
                                                                                  ? THREE.DataArrayTexture
                                                                                  : T extends "samplerCube"
                                                                                    ? THREE.DataArrayTexture
                                                                                    : T extends "samplerCubeShadow"
                                                                                      ? THREE.Texture
                                                                                      : unknown;

export function typeLiteral(type: DynoType): string {
  if (typeof type === "string") {
    return type;
  }
  if (typeof type === "object" && type.type) {
    return type.type;
  }
  throw new Error(`Invalid DynoType: ${String(type)}`);
}

export function numberAsInt(value: number): string {
  return Math.trunc(value).toString();
}

export function numberAsUint(value: number): string {
  const v = Math.max(0, Math.trunc(value));
  return `${v.toString()}u`;
}

export function numberAsFloat(value: number): string {
  return value === Number.POSITIVE_INFINITY
    ? "INFINITY"
    : value === Number.NEGATIVE_INFINITY
      ? "-INFINITY"
      : Number.isInteger(value)
        ? value.toFixed(1)
        : value.toString();
}
