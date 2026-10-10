import type * as THREE from "three";
import type { Node } from "three/webgpu";
import type { NodeMaterial, TextureNode } from "three/webgpu";
import type { Uniforms } from "../uniforms.js";
export type ProjectedVertexData = {
  clipPosition: Node<"vec4">;
  /** Source color space; this material applies encodeLinear. */
  rgba: Node<"vec4">;
  splatUv: Node<"vec2">;
  /** Stochastic variant only. */
  stochasticSeed?: Node<"uint">;
  /** A wide kernel's low 16 bits hold its edge fade as a half. */
  supportRadiusSquared: Node<"float">;
  kernelPower: Node<"float">;
  viewportOrigin: Node<"vec2">;
};
export type SplatNodeMaterial = NodeMaterial & {
  uniforms: Uniforms;
};
/**
 * Sorted and stochastic variants compile separate graphs, so sorted drawing
 * carries no coverage varyings, seed loads or mode branches.
 */
export declare function createSplatNodeMaterial({
  uniforms,
  orderingNode,
  vertexData,
  premultipliedAlpha,
  transparent,
  depthTest,
  depthWrite,
  stochastic,
}: {
  uniforms: Uniforms;
  /** CPU ordering for drawing from accumulator textures. */
  orderingNode?: TextureNode<"uvec4">;
  /** Replaces accumulator projection, e.g. with a GPU projection cache. */
  vertexData?: (
    camera: THREE.Camera,
    stochastic: boolean,
  ) => ProjectedVertexData;
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
  stochastic: boolean;
}): SplatNodeMaterial;
