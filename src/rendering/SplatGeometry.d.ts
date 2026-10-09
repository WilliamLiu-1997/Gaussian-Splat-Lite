import * as THREE from "three";
export declare const SPLATS_PER_INSTANCE = 128;
/** Repeated quads; position.z identifies the Splat within each instance. */
export declare class SplatGeometry extends THREE.InstancedBufferGeometry {
  constructor();
  setSplatCount(count: number): void;
}
