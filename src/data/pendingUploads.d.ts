import type * as THREE from "three";
import type { IndexedSplats } from "./IndexedSplats.js";
/**
 * Streaming groups list sources whose written layers await upload. The Splat
 * renderer finds the list while walking the scene and uploads before drawing,
 * so storage reaches the GPU when written rather than on first display.
 */
export declare const PENDING_UPLOADS: unique symbol;
/** Upload budget until the scheduler's dirty layers are submitted. */
export declare class PendingUploads extends Set<IndexedSplats> {
  constructor(group: THREE.Object3D);
  get byteLength(): number;
  canAdd(bytes: number): boolean;
}
