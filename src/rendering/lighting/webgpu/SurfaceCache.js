import { N, decodeOctahedral } from "../../tsl/shaderUtils.js";
import { unprojectXY } from "../../webgpu/ProjectionCache.js";
import { surfaceNormal } from "../tsl/surface.js";

/** Octahedral unit vector in one uint32. */
const packNormal = N.Fn(([normal]) => {
  const n = normal
    .div(normal.x.abs().add(normal.y.abs()).add(normal.z.abs()))
    .toVar();
  const folded = N.vec2(1)
    .sub(n.yx.abs())
    .mul(
      N.vec2(
        N.select(n.x.greaterThanEqual(0), 1, -1),
        N.select(n.y.greaterThanEqual(0), 1, -1),
      ),
    );
  return N.packSnorm2x16(N.select(n.z.greaterThanEqual(0), n.xy, folded));
});
const unpackNormal = N.Fn(([packed]) =>
  decodeOctahedral(N.unpackSnorm2x16(packed)),
);
/** View-space center from cached NDC and view Z, by the drawn eye's projection. */
const unprojectCenter = N.Fn(([ndcAndViewZ, matrix]) =>
  N.vec3(unprojectXY(ndcAndViewZ.xy, ndcAndViewZ.z, matrix), ndcAndViewZ.z),
);

/**
 * Native WebGPU projects in compute kernels, so its draw never sees a
 * Gaussian's shape. Lit kernels store each Splat's normal beside the
 * projection cache, 4 bytes per Splat and eye; the draw decodes it and recovers
 * the center from the cached projection.
 */
export class SurfaceCache {
  constructor(cache) {
    // One texture, shared by every precompiled shaded kernel.
    this.normals = cache.addChannel();
  }

  /** Kernel side: the projection extension of one slot and its cache writes. */
  kernel() {
    const { normals } = this;
    return {
      projection: {
        declare: () => ({ normal: N.vec3(0, 0, 1).toVar() }),
        assign: (surface, gaussian) =>
          surface.normal.assign(surfaceNormal(gaussian)),
      },
      write: (index, surface) =>
        normals.write(index, packNormal(surface.normal)),
      writeHidden: (index) => normals.write(index, N.uint(0)),
    };
  }

  /**
   * Draw side: `load` belongs inside the visible guard; the surface decodes
   * where shading reads it.
   */
  reader(projectionMatrix) {
    const { normals } = this;
    const ndcAndViewZ = N.vec3(0).toVar();
    const cacheIndex = N.uint(0).toVar();
    return {
      load(index, projected) {
        ndcAndViewZ.assign(projected.ndcAndViewZ);
        cacheIndex.assign(index);
      },
      normal: unpackNormal(normals.read(cacheIndex)),
      viewCenter: unprojectCenter(ndcAndViewZ, projectionMatrix),
    };
  }

  /** Lit kernels and draws need a normal for every cached record. */
  setActive(active) {
    this.normals.setActive(active);
  }
}
