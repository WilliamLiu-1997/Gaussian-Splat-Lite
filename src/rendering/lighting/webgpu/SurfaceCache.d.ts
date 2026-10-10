import type { Node } from "three/webgpu";
import type { ProjectionExtension } from "../../tsl/ProjectionProgram.js";
import type { SplatSurface } from "../../tsl/SplatMaterial.js";
import type { ProjectionCache } from "../../webgpu/ProjectionCache.js";
/**
 * Native WebGPU projects in compute kernels, so its draw never sees a
 * Gaussian's shape. Lit kernels store each Splat's normal beside the
 * projection cache, 4 bytes per Splat and eye; the draw decodes it and recovers
 * the center from the cached projection.
 */
export declare class SurfaceCache {
  private readonly normals;
  constructor(cache: ProjectionCache);
  /** Kernel side: the projection extension of one slot and its cache writes. */
  kernel(): {
    projection: ProjectionExtension<Pick<SplatSurface, "normal">>;
    write(index: Node<"uint">, surface: Pick<SplatSurface, "normal">): void;
    writeHidden(index: Node<"uint">): void;
  };
  /**
   * Draw side: `load` belongs inside the visible guard; the surface decodes
   * where shading reads it.
   */
  reader(projectionMatrix: Node<"mat4">): SplatSurface & {
    load(index: Node<"uint">, projected: { ndcAndViewZ: Node<"vec3"> }): void;
  };
  /** Lit kernels and draws need a normal for every cached record. */
  setActive(active: boolean): void;
}
