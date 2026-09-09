import * as THREE from "three";

export const WEBGPU_SPLATS_PER_INSTANCE = 128;

/** Repeated quads; position.z identifies the Splat within each instance. */
export class SplatGeometry extends THREE.InstancedBufferGeometry {
  constructor(readonly splatsPerInstance = 1) {
    super();
    const vertices = new Float32Array(splatsPerInstance * 12);
    const indices = new Uint16Array(splatsPerInstance * 6);
    for (let splat = 0; splat < splatsPerInstance; splat++) {
      for (let vertex = 0; vertex < 4; vertex++) {
        const offset = splat * 12 + vertex * 3;
        vertices[offset] = QUAD_VERTICES[vertex * 3];
        vertices[offset + 1] = QUAD_VERTICES[vertex * 3 + 1];
        vertices[offset + 2] = splat;
      }
      for (let index = 0; index < 6; index++)
        indices[splat * 6 + index] = splat * 4 + QUAD_INDICES[index];
    }
    this.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    this.setIndex(new THREE.BufferAttribute(indices, 1));
  }

  setSplatCount(count: number) {
    this.instanceCount = Math.ceil(count / this.splatsPerInstance);
  }
}

const QUAD_VERTICES = new Float32Array([
  -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
]);

// The projected covariance basis reverses handedness, so clockwise local
// triangles become counter-clockwise screen-space faces for FrontSide culling.
const QUAD_INDICES = new Uint16Array([0, 2, 1, 0, 3, 2]);
