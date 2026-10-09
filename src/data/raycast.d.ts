import type { Vector3 } from "three";
/** Picking uses the same f32 ray and world-distance parameter as WASM. */
export declare class SplatRaycastQuery {
  private readonly origin;
  private readonly direction;
  private readonly near;
  private readonly far;
  constructor(origin: Vector3, direction: Vector3, near: number, far: number);
  /** Visit consecutive candidate records in one Morton-ordered chunk. */
  forEachRange(
    bounds: Float32Array,
    count: number,
    callback: RaycastRangeCallback,
  ): void;
  private intersects;
}
export type RaycastRangeCallback = (start: number, count: number) => void;
