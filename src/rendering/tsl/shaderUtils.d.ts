import type * as THREE from "three";
import type { Node, TextureNode, UniformNode } from "three/webgpu";
import type { Uniforms } from "../uniforms.js";
export * as N from "three/tsl";
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
export declare const E: number;
/** Texture loads without a sampler, preserving the texture's integer format. */
export declare function uintTexture(
  texture: THREE.Texture,
): TextureNode<"uvec4">;
export declare function uniformBinding<Type extends UniformType>(
  uniforms: Uniforms,
  name: string,
  type: Type,
): UniformNode<Type, unknown>;
export declare function textureBinding(
  uniforms: Uniforms,
  name: string,
): TextureNode<"uvec4">;
export declare function load2D<T extends TextureNode<unknown>>(
  binding: T,
  coord: Node<"ivec2">,
): T;
export declare function loadArray<T extends TextureNode<unknown>>(
  binding: T,
  coord: Node<"ivec3">,
): T;
export declare const splatTexCoord: import("three/src/nodes/TSL.js").FnNode<
  [Node<"uint">],
  import("three/webgpu").VarNode<
    "ivec3",
    import("three/webgpu").JoinNode<"ivec3">
  >
>;
export declare const quatVec: import("three/src/nodes/TSL.js").FnNode<
  [Node<"vec4"> | THREE.Vector4, THREE.Vector3 | Node<"vec3">],
  Node<"vec3">
>;
export declare const quatQuat: import("three/src/nodes/TSL.js").FnNode<
  [Node<"vec4"> | THREE.Vector4, Node<"vec4"> | THREE.Vector4],
  import("three/webgpu").VarNode<
    "vec4",
    import("three/webgpu").JoinNode<"vec4">
  >
>;
export declare const decodeCenter: import("three/src/nodes/TSL.js").FnNode<
  [Node<"uvec4">],
  Node<"vec3">
>;
export declare const decodeAlphaShape: import("three/src/nodes/TSL.js").FnNode<
  [Node<"uvec4">],
  Node<"vec2">
>;
export declare const decodeRgba: import("three/src/nodes/TSL.js").FnNode<
  [Node<"uvec4">, number | Node<"uint"> | Node<"float">],
  import("three/webgpu").VarNode<
    "vec4",
    import("three/webgpu").JoinNode<"vec4">
  >
>;
export declare const decodeLnScales: import("three/src/nodes/TSL.js").FnNode<
  [Node<"uvec4">],
  import("three/webgpu").VarNode<
    "vec3",
    import("three/webgpu").JoinNode<"vec3">
  >
>;
export declare const decodeQuaternion: import("three/src/nodes/TSL.js").FnNode<
  [Node<"uint">],
  import("three/webgpu").VarNode<
    "vec4",
    import("three/webgpu").JoinNode<"vec4">
  >
>;
