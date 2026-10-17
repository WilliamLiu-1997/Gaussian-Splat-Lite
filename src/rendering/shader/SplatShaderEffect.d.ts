import type * as THREE from "three";
import type { CubeTextureNode, Node, TextureNode } from "three/webgpu";
import type { GaussianSplatRenderer } from "../GaussianSplatRenderer.js";
import type { GaussianSplatCompatibleRenderer } from "../rendererUtils.js";

type UniformValues = {
  float: number;
  int: number;
  uint: number;
  bool: boolean;
  vec2: THREE.Vector2;
  vec3: THREE.Vector3 | THREE.Color;
  vec4: THREE.Vector4;
  mat3: THREE.Matrix3;
  mat4: THREE.Matrix4;
  sampler2D: THREE.Texture;
  samplerCube: THREE.CubeTexture;
};
export type SplatEffectUniform = {
  [Type in keyof UniformValues]: { type: Type; value: UniformValues[Type] };
}[keyof UniformValues];
type EffectUniforms = Record<string, SplatEffectUniform>;
type UniformNode<Uniform extends SplatEffectUniform> = Uniform extends {
  type: "sampler2D";
}
  ? TextureNode
  : Uniform extends { type: "samplerCube" }
    ? CubeTextureNode
    : Node<Uniform["type"]>;
export type SplatEffectContext<
  Uniforms extends EffectUniforms = EffectUniforms,
> = {
  /** Unpremultiplied linear RGB. */
  color: Node<"vec3">;
  /** Splat center in the current eye's view space, not a surface intersection. */
  viewCenter: Node<"vec3">;
  /** Approximate covariance normal; request normals: true to use it. */
  viewNormal?: Node<"vec3">;
  camera: THREE.Camera;
  uniforms: { [Name in keyof Uniforms]: UniformNode<Uniforms[Name]> };
};
export type SplatFragmentContext<
  Uniforms extends EffectUniforms = EffectUniforms,
> = SplatEffectContext<Uniforms> & {
  /** Effective Gaussian alpha before coverage; opacity may only reduce it. */
  alpha: Node<"float">;
  splatUv: Node<"vec2">;
  /** Normalized coordinates in the full framebuffer, origin at its top left. */
  screenUV: Node<"vec2">;
};
export type SplatEffectFrame = {
  renderer: GaussianSplatCompatibleRenderer;
  splatRenderer: GaussianSplatRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
};
export type SplatShaderDefinition<
  Uniforms extends EffectUniforms = EffectUniforms,
> = {
  normals?: boolean;
  uniforms?: Uniforms;
  tsl?: {
    shadeSplat?(context: SplatEffectContext<Uniforms>): Node<"vec3">;
    opacity?(context: SplatFragmentContext<Uniforms>): Node<"float">;
    shadeFragment?(context: SplatFragmentContext<Uniforms>): Node<"vec3">;
  };
  glsl?: {
    /** Shared helper functions. Uniforms are declared as effect_<name>. */
    declarations?: string;
    /** Function body returning vec3, with a SplatContext named splat. */
    shadeSplat?: string;
    /** Function body returning float in [0, splat.alpha]. */
    opacity?: string;
    /** Function body returning vec3. */
    shadeFragment?: string;
  };
  onBeforeRender?: (frame: SplatEffectFrame) => void;
  /** Factory-owned resources only; application textures remain application-owned. */
  dispose?: () => void;
};
export declare class SplatShaderEffect<
  Uniforms extends EffectUniforms = EffectUniforms,
> {
  private readonly definition;
  constructor(
    definition:
      | SplatShaderDefinition<Uniforms>
      | ((context: {
          renderer: GaussianSplatCompatibleRenderer;
        }) => SplatShaderDefinition<Uniforms>),
  );
  create(
    renderer: GaussianSplatCompatibleRenderer,
  ): SplatShaderDefinition<Uniforms>;
}
export {};
