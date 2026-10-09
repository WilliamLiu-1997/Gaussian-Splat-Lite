import type { Camera, Texture } from "three";
import * as TSL from "three/tsl";
import type {
  ComputeNode,
  IndirectStorageBufferAttribute,
  NodeBuilder,
} from "three/webgpu";
import type {
  PatchedComputeNode,
  PatchedNodeBuilder,
  PatchedTSL,
  PatchedTextureNode,
} from "../../patches/threeTypes";

export type { UniformType } from "../../patches/threeTypes";

export const N = TSL as unknown as PatchedTSL;

/** Packed integer texture loads are incorrectly declared as vec4 upstream. */
export function uintTexture(texture: Texture): PatchedTextureNode<"uvec4"> {
  return TSL.texture<"uvec4">(texture).setSampler(
    false,
  ) as PatchedTextureNode<"uvec4">;
}

/** NodeBuilder.camera is present when building a material shader. */
export function materialCamera(builder: NodeBuilder): Camera {
  return (builder as PatchedNodeBuilder).camera as Camera;
}

/** RenderPipeline adds this identity to the shader-building context. */
export function renderPipelineState(builder: NodeBuilder) {
  return (builder as PatchedNodeBuilder).context.renderPipelineState;
}

/** Three.js takes an indirect attribute; @types/three r186 lists only counts. */
export function setIndirectDispatch(
  node: ComputeNode,
  dispatch: IndirectStorageBufferAttribute,
) {
  (node as PatchedComputeNode).dispatchSize = dispatch;
}
