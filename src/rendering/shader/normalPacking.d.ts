import type { Node, TSL } from "three/webgpu";
export declare const packNormal: TSL.FnNode<[Node<"vec3">], Node<"uint">>;
export declare const unpackNormal: TSL.FnNode<[Node<"uint">], Node<"vec3">>;
