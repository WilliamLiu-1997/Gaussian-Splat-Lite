import type * as THREE from "three";
import type { Node, TSL, TextureNode, UniformNode } from "three/webgpu";
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
export declare const splatTexCoord: TSL.FnNode<[Node<"uint">], Node<"ivec3">>;
export declare const quatVec: TSL.FnNode<
  [Node<"vec4"> | THREE.Vector4, THREE.Vector3 | Node<"vec3">],
  Node<"vec3">
>;
export declare const quatQuat: TSL.FnNode<
  [Node<"vec4"> | THREE.Vector4, Node<"vec4"> | THREE.Vector4],
  Node<"vec4">
>;
export declare const decodeCenter: TSL.FnNode<[Node<"uvec4">], Node<"vec3">>;
export declare const decodeAlphaShape: TSL.FnNode<
  [Node<"uvec4">],
  Node<"vec2">
>;
export declare const decodeRgba: TSL.FnNode<
  [Node<"uvec4">, number | Node<"uint"> | Node<"float">],
  Node<"vec4">
>;
export declare const decodeLnScales: TSL.FnNode<[Node<"uvec4">], Node<"vec3">>;
export declare const decodeQuaternion: TSL.FnNode<[Node<"uint">], Node<"vec4">>;
