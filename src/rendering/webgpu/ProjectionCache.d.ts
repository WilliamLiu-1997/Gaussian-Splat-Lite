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
/**
 * View X/Y of a point from its NDC and view Z under any projection: the 2x2
 * system that remains once clip W is eliminated.
 */
export declare function unprojectXY(
  ndc: Node<"vec2">,
  viewZ: Node<"float">,
  projectionMatrix: Node<"mat4">,
): Node<"vec2">;
/** Native projected records: compact layout, paired codec and texture ownership. */
export declare class ProjectionCache {
  readonly textures: StorageArrayTexture[];
  private readonly channels;
  readonly size: THREE.Vector4;
  private readonly dimensions;
  resize(size: ReturnType<typeof getProjectionCacheSize>): void;
  /**
   * One more uint32 per record, for data that only some kernels write and
   * some draws read. The cache sizes it: every record while active, and one
   * texel until first activated. Its texture object never changes.
   */
  addChannel(): {
    write(index: Node<"uint">, value: Node<"uint">): void;
    read(index: Node<"uint">): Node<"uint">;
    setActive(active: boolean): void;
  };
  /**
   * Active channels take the cache's size. Inactive ones keep their storage
   * for the next activation, or with `shrink` release it down to one texel.
   * Returns whether any storage changed.
   */
  fitChannels(shrink?: boolean): boolean;
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
    /** Projection of the drawn eye. */
    projectionMatrix: Node<"mat4">,
  ): {
    /** For draws that need the center back in view space. */
    ndcAndViewZ: Node<"vec3">;
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
export {};
