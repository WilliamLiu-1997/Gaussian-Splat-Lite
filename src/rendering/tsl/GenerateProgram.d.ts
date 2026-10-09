import type { Node } from "three/webgpu";
import type { Uniforms } from "../uniforms.js";
export declare function createGenerateProgram({
  uniforms,
}: {
  uniforms: Uniforms;
}): ((index: Node<"uint">) => {
  accumulatorA: import("three/webgpu").VarNode<
    "uvec4",
    import("three/webgpu").VarNode<
      "uvec4",
      import("three/webgpu").ConstNode<"uvec4", import("three").Vector4>
    >
  >;
  accumulatorB: import("three/webgpu").VarNode<
    "uvec4",
    import("three/webgpu").VarNode<
      "uvec4",
      import("three/webgpu").ConstNode<"uvec4", import("three").Vector4>
    >
  >;
  stochasticSeed: import("three/webgpu").VarNode<
    "uint",
    import("three/webgpu").VarNode<
      "uint",
      import("three/webgpu").ConstNode<"uint", number>
    >
  >;
}) & {
  prepare: (index: Node<"uint">) => {
    resolveRgb: () => Node<"vec3">;
    valid: import("three/webgpu").VarNode<
      "bool",
      import("three/webgpu").VarNode<
        "bool",
        import("three/webgpu").ConstNode<"bool", boolean>
      >
    >;
    center: import("three/webgpu").VarNode<
      "vec3",
      import("three/webgpu").VarNode<
        "vec3",
        import("three/webgpu").ConstNode<"vec3", import("three").Vector3>
      >
    >;
    lnScales: import("three/webgpu").VarNode<
      "vec3",
      import("three/webgpu").VarNode<
        "vec3",
        import("three/webgpu").ConstNode<"vec3", import("three").Vector3>
      >
    >;
    quaternion: import("three/webgpu").VarNode<
      "vec4",
      import("three/webgpu").VarNode<
        "vec4",
        import("three/webgpu").ConstNode<"vec4", import("three").Vector4>
      >
    >;
    rgba: import("three/webgpu").VarNode<
      "vec4",
      import("three/webgpu").VarNode<
        "vec4",
        import("three/webgpu").ConstNode<"vec4", import("three").Vector4>
      >
    >;
    shapeAmount: import("three/webgpu").VarNode<
      "float",
      import("three/webgpu").VarNode<
        "float",
        import("three/webgpu").ConstNode<"float", number>
      >
    >;
    stochasticSeed: import("three/webgpu").VarNode<
      "uint",
      import("three/webgpu").VarNode<
        "uint",
        import("three/webgpu").ConstNode<"uint", number>
      >
    >;
  };
};
