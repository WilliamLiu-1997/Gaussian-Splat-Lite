import type { Camera, DataTexture, RenderTarget, Texture } from "three";
import type * as TSL from "three/tsl";
import type {
  Backend,
  ComputeNode,
  IndirectStorageBufferAttribute,
  Node,
  NodeBuilder,
  StorageBufferAttribute,
  StorageBufferNode,
  TextureNode,
  UniformNode,
  WorkgroupInfoNode,
} from "three/webgpu";

// Type-only corrections for incomplete @types/three r186 declarations.
// Keep fluent additions on the interfaces used by these shaders,
// preserving their result types.
declare module "three/src/nodes/core/Node.js" {
  interface IntegerExtensions<TInteger> {
    min(value: Node<TInteger> | number): Node<TInteger>;
    max(value: Node<TInteger> | number): Node<TInteger>;
  }
  interface IntOrVecExtensions<TNodeType> {
    clamp(low: Node<TNodeType>, high: Node<TNodeType>): Node<TNodeType>;
  }
  interface NumOrBoolVec4Extensions<TNumOrBool> {
    element(index: Node<"int"> | Node<"uint"> | number): Node<TNumOrBool>;
  }
  interface Mat4Extensions {
    element(index: Node<"int"> | Node<"uint"> | number): Node<"vec4">;
  }
  interface FloatOrVecExtensions<TNodeType> {
    negateAssign(): Node<TNodeType>;
  }
}

// TextureNodeInterface is not exported, so extend the public alias.
export type PatchedTextureNode<TNodeType = "vec4"> = TextureNode<TNodeType> & {
  mergeable: boolean;
};

export type PatchedNodeBuilder = Omit<NodeBuilder, "context"> & {
  camera: Camera | null;
  context: { renderPipelineState?: object };
};

export type PatchedComputeNode = Omit<ComputeNode, "dispatchSize"> & {
  dispatchSize: ComputeNode["dispatchSize"] | IndirectStorageBufferAttribute;
};

export type PatchedRenderTarget = RenderTarget & {
  isXRRenderTarget?: boolean;
};

export type PatchedBackend = Backend & {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  updateTexture(
    texture: DataTexture,
    options: {
      width: number;
      height: number;
      image: DataTexture["image"];
    },
  ): void;
};

export type WebGPUDeviceLimits = {
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxTextureArrayLayers: number;
  maxTextureDimension2D: number;
  maxComputeWorkgroupsPerDimension: number;
};

export type PatchedWebGPUBackend = PatchedBackend & {
  device: { limits: WebGPUDeviceLimits };
};

export type UniformType =
  | "bool"
  | "float"
  | "int"
  | "uint"
  | "vec2"
  | "vec3"
  | "vec4"
  | "mat3"
  | "mat4";

type FloatToUint = {
  float: "uint";
  vec2: "uvec2";
  vec3: "uvec3";
  vec4: "uvec4";
};
type UintToFloat = {
  uint: "float";
  uvec2: "vec2";
  uvec3: "vec3";
  uvec4: "vec4";
};
type UintWorkgroup = WorkgroupInfoNode & {
  element(index: Node<"uint"> | Node<"int"> | number): Node<"uint">;
  setName(name: string): UintWorkgroup;
};

// Only override incomplete declarations; every other export keeps Three's
// original overloads. This type does not wrap or replace runtime nodes.
type Compatibility = {
  uniform: typeof TSL.uniform &
    (<Type extends UniformType>(
      value: unknown,
      type: Type,
    ) => UniformNode<Type, unknown>);
  passTexture: typeof TSL.passTexture &
    ((pass: Node, texture: Texture) => TextureNode);
  convertColorSpace(
    value: Node<"vec4">,
    source: string,
    target: string,
  ): Node<"vec4">;
  floatBitsToUint<T extends keyof FloatToUint>(
    value: Node<T>,
  ): Node<FloatToUint[T]>;
  uintBitsToFloat<T extends keyof UintToFloat>(
    value: Node<T>,
  ): Node<UintToFloat[T]>;
  packHalf2x16(value: Node<"vec2">): Node<"uint">;
  unpackHalf2x16(value: Node<"uint">): Node<"vec2">;
  packSnorm2x16(value: Node<"vec2">): Node<"uint">;
  unpackSnorm2x16(value: Node<"uint">): Node<"vec2">;
  storage(
    value: StorageBufferAttribute,
    type: "uint",
    count?: number,
  ): StorageBufferNode<"uint">;
  workgroupArray(type: "uint", count: number): UintWorkgroup;
  builtin(name: "gl_ViewID_OVR"): Node<"uint">;
  countOneBits(value: Node<"uint">): Node<"uint">;
  ivec2: typeof TSL.ivec2 &
    ((x: Node<"uint">, y: Node<"uint">) => Node<"ivec2">);
  ivec3: typeof TSL.ivec3 &
    ((x: Node<"uint">, y: Node<"uint">, z: Node<"uint">) => Node<"ivec3">);
  Loop: typeof TSL.Loop &
    (<Name extends string, Type extends "int" | "uint">(
      params: {
        name: Name;
        type: Type;
        start: Node<Type>;
        end: Node<Type>;
        condition: string;
      },
      callback: (inputs: Record<Name, Node<Type>>) => void,
    ) => ReturnType<typeof TSL.Loop>);
};

export type PatchedTSL = Omit<typeof TSL, keyof Compatibility> & Compatibility;
