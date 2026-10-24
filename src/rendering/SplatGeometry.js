import * as THREE from "three";
export const SPLATS_PER_INSTANCE = 128;
/** Repeated triangles or quads; position.z identifies the Splat in each instance. */
export class SplatGeometry extends THREE.InstancedBufferGeometry {
  constructor(triangle = false) {
    super();
    const corners = triangle ? TRIANGLE_CORNERS : QUAD_CORNERS;
    const order = triangle ? TRIANGLE_INDICES : QUAD_INDICES;
    const vertexCount = corners.length / 2;
    const vertices = new Float32Array(SPLATS_PER_INSTANCE * vertexCount * 3);
    const indices = new Uint16Array(SPLATS_PER_INSTANCE * order.length);
    for (let splat = 0; splat < SPLATS_PER_INSTANCE; splat++) {
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        const offset = (splat * vertexCount + vertex) * 3;
        vertices[offset] = corners[vertex * 2];
        vertices[offset + 1] = corners[vertex * 2 + 1];
        vertices[offset + 2] = splat;
      }
      for (let index = 0; index < order.length; index++)
        indices[splat * order.length + index] =
          splat * vertexCount + order[index];
    }
    this.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    this.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  setSplatCount(count) {
    this.instanceCount = Math.ceil(count / SPLATS_PER_INSTANCE);
  }
}
const QUAD_CORNERS = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
// The equilateral triangle around the unit circle covers the same ellipse as
// the quad: it costs one triangle instead of two, and about 30% more area.
const TRIANGLE_CORNERS = new Float32Array([
  -Math.sqrt(3),
  -1,
  Math.sqrt(3),
  -1,
  0,
  2,
]);
// The projected covariance basis reverses handedness, so clockwise local
// triangles become counter-clockwise screen-space faces for FrontSide culling.
const QUAD_INDICES = new Uint16Array([0, 2, 1, 0, 3, 2]);
const TRIANGLE_INDICES = new Uint16Array([0, 2, 1]);
