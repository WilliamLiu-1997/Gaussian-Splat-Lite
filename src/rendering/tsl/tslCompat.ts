import type { Camera, Texture, ToneMapping } from "three";
import * as TSL from "three/tsl";
import type {
  ComputeNode,
  IndirectStorageBufferAttribute,
  Node,
  NodeBuilder,
  StorageBufferAttribute,
  StorageBufferNode,
  TextureNode,
  WorkgroupInfoNode,
} from "three/webgpu";

// @types/three r186 omits these fluent operations. Keep the additions on
// interfaces used by these shaders, preserving their result types.
declare module "three/src/nodes/core/Node.js" {
  interface IntegerExtensions<TInteger> {
    min(value: Node<TInteger> | number): Node<TInteger>;
    max(value: Node<TInteger> | number): Node<TInteger>;
  }
  interface IntOrVecExtensions<TNodeType> {
    shiftRight(value: Node<TNodeType> | number): Node<TNodeType>;
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
// original overloads. These assertions do not wrap or replace runtime nodes.
type Compatibility = {
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

export const N = TSL as unknown as Omit<typeof TSL, keyof Compatibility> &
  Compatibility;

/** Packed integer texture loads are incorrectly declared as vec4 upstream. */
export function uintTexture(texture: Texture): TextureNode<"uvec4"> {
  return TSL.texture<"uvec4">(texture).setSampler(false);
}

/** NodeBuilder.camera is present when building a material shader. */
export function materialCamera(builder: NodeBuilder): Camera {
  return (builder as NodeBuilder & { camera: Camera }).camera;
}

export type ResolveOutputNode = ReturnType<typeof TSL.renderOutput> & {
  getToneMapping(): ToneMapping;
  setToneMapping(value: ToneMapping): void;
};

/** r186 supports an indirect attribute, but its declaration lists only counts. */
export function setIndirectDispatch(
  node: ComputeNode,
  dispatch: IndirectStorageBufferAttribute,
) {
  (node as { dispatchSize: unknown }).dispatchSize = dispatch;
}
