import type { Node, TSL } from "three/webgpu";

export declare const encodeQuatSmallestThree32: TSL.FnNode<
  [Node<"vec4">],
  Node<"uint">
>;
export declare const decodeQuatSmallestThree32: TSL.FnNode<
  [Node<"uint">],
  Node<"vec4">
>;
