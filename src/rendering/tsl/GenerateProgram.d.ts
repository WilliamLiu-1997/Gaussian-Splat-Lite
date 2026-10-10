import type { Node } from "three/webgpu";
import type { Uniforms } from "../uniforms.js";
export declare function createGenerateProgram({
  uniforms,
}: {
  uniforms: Uniforms;
}): ((index: Node<"uint">) => {
  accumulatorA: Node<"uvec4">;
  accumulatorB: Node<"uvec4">;
  stochasticSeed: Node<"uint">;
}) & {
  prepare: (index: Node<"uint">) => {
    resolveRgb: () => Node<"vec3">;
    valid: Node<"bool">;
    center: Node<"vec3">;
    lnScales: Node<"vec3">;
    quaternion: Node<"vec4">;
    rgba: Node<"vec4">;
    shapeAmount: Node<"float">;
    stochasticSeed: Node<"uint">;
  };
};
