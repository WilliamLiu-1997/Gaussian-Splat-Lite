import type { Node } from "three/webgpu";
export declare function surfaceNormal(gaussian: {
  scales: Node<"vec3">;
  viewQuaternion: Node<"vec4">;
  viewCenter: Node<"vec3">;
  isOrthographic: Node<"bool">;
}): Node<"vec3">;
