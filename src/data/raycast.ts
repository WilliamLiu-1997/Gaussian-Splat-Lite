import type { Vector3 } from "three";
import { SPLAT_BOUNDS_BLOCK_SIZE } from "./defines";

/** Picking uses the same f32 ray and world-distance parameter as WASM. */
export class SplatRaycastQuery {
  private readonly origin: Float32Array;
  private readonly direction: Float32Array;
  private readonly near: number;
  private readonly far: number;

  constructor(origin: Vector3, direction: Vector3, near: number, far: number) {
    this.origin = Float32Array.of(origin.x, origin.y, origin.z);
    this.direction = Float32Array.of(direction.x, direction.y, direction.z);
    this.near = Math.fround(near);
    this.far = Math.fround(far);
  }

  /** Visit consecutive candidate records in one Morton-ordered chunk. */
  forEachRange(
    bounds: Float32Array,
    count: number,
    callback: RaycastRangeCallback,
  ) {
    let start = -1;
    for (let base = 0; base < count; base += SPLAT_BOUNDS_BLOCK_SIZE) {
      if (this.intersects(bounds, (base / SPLAT_BOUNDS_BLOCK_SIZE) * 6)) {
        if (start < 0) start = base;
      } else if (start >= 0) {
        callback(start, base - start);
        start = -1;
      }
    }
    if (start >= 0) callback(start, count - start);
  }

  private intersects(bounds: Float32Array, offset: number) {
    if (bounds[offset] > bounds[offset + 3]) return false;
    // Invalid bounds retain the per-Splat path.
    for (let i = offset; i < offset + 6; i++) {
      if (!Number.isFinite(bounds[i])) return true;
    }
    let near = this.near;
    let far = this.far;
    for (let axis = 0; axis < 3; axis++) {
      const origin = this.origin[axis];
      const direction = this.direction[axis];
      const min = bounds[offset + axis];
      const max = bounds[offset + axis + 3];
      // Enclose rounding in the f32 sphere/ellipsoid arithmetic, including
      // cancellation for distant rays and very thin Splats.
      const padding =
        1e-5 * (Math.abs(origin) + Math.max(Math.abs(min), Math.abs(max)));
      if (direction === 0) {
        if (origin < min - padding || origin > max + padding) return false;
      } else {
        const a = (min - padding - origin) / direction;
        const b = (max + padding - origin) / direction;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
        if (near > far) return false;
      }
    }
    return true;
  }
}

export type RaycastRangeCallback = (start: number, count: number) => void;
