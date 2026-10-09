import type * as THREE from "three";
import type { Node } from "three/webgpu";
import type { StorageArrayTexture } from "three/webgpu";
import type { SplatProjection } from "../tsl/ProjectionProgram.js";
type TextureLimits = {
  maxTextureDimension2D: number;
  maxTextureArrayLayers: number;
};
export declare function getProjectionCacheSize(
  count: number,
  limits: TextureLimits,
): {
  width: number;
  height: number;
  depth: number;
};
/** Native projected records: compact layout, paired codec and texture ownership. */
export declare class ProjectionCache {
  readonly textures: StorageArrayTexture[];
  readonly size: THREE.Vector4;
  private readonly dimensions;
  resize(size: ReturnType<typeof getProjectionCacheSize>): void;
  write(
    index: Node<"uint">,
    projection: SplatProjection,
    ndc: Node<"vec2">,
    pixelScale: Node<"vec2">,
    centerRange: Node<"float">,
  ): void;
  /**
   * A shared WebXR slot another eye draws: a transparent record whose
   * corners collapse to one point, behind a perspective camera.
   */
  writeHidden(index: Node<"uint">): void;
  read(
    index: Node<"uint">,
    pixelScale: Node<"vec2">,
    centerRange: Node<"float">,
    /** NDC translation from the cached projection to the drawn one. */
    jitter: Node<"vec2">,
  ): {
    clipPosition: import("three/webgpu").VarNode<
      "vec4",
      import("three/webgpu").JoinNode<"vec4">
    >;
    rgba: import("three/webgpu").VarNode<
      "vec4",
      import("three/webgpu").JoinNode<"vec4">
    >;
    splatUv: Node<"vec2">;
    supportRadiusSquared: Node<"float">;
    kernelPower: Node<"float">;
  };
  dispose(): void;
}
