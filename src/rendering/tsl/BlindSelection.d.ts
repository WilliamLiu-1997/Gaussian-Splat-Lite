import type { Node } from "three/webgpu";
import type { Uniforms } from "../uniforms.js";

export declare function createBlindSelection(
  uniforms: Uniforms,
): (
  sourceIndex: Node<"uint">,
  field: Node<"uvec3">,
  flags: Node<"uint">,
  bounds: Node<"uvec4">,
) => { active: Node<"bool">; distance: Node<"float"> };
