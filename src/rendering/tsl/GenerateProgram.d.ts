import type { Node } from "three/webgpu";
import type { SplatModifier } from "../SplatModifier.js";
import type { Uniforms } from "../uniforms.js";
export declare function createGenerateProgram({
  uniforms,
  modifier,
  modifierData,
  language,
}: {
  uniforms: Uniforms;
  modifier?: SplatModifier | null;
  modifierData?: boolean;
  language?: "glsl" | "wgsl";
}): ((index: Node<"uint">) => {
  accumulatorA: Node<"uvec4">;
  accumulatorB: Node<"uvec4">;
  originalCenter: Node<"vec3"> | null;
  stochasticSeed: Node<"uint">;
}) & {
  /** `isVisible` returns true to keep a camera-relative center for decoding. */
  prepare: (
    index: Node<"uint">,
    isVisible?: (center: Node<"vec3">) => Node<"bool">,
    eagerColor?: boolean,
  ) => {
    resolveRgb: () => Node<"vec3">;
    valid: Node<"bool">;
    originalCenter: Node<"vec3"> | null;
    center: Node<"vec3">;
    lnScales: Node<"vec3">;
    quaternion: Node<"vec4">;
    rgba: Node<"vec4">;
    shapeAmount: Node<"float">;
    stochasticSeed: Node<"uint">;
  };
};
