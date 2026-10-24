import * as THREE from "three";
export declare const SPLATS_PER_INSTANCE = 128;
/** Repeated triangles or quads; position.z identifies the Splat in each instance. */
export declare class SplatGeometry extends THREE.InstancedBufferGeometry {
  constructor(triangle?: boolean);
  setSplatCount(count: number): void;
}
