import type * as THREE from "three";

/** Vectors of a view's block before its lights. */
export declare const LIGHT_HEADER = 2;
/** Vectors of one light. */
export declare const LIGHT_STRIDE = 4;
/** Packed storage for `vectors` vec4 light records. */
export declare function createLightRecords(vectors: number): Float32Array;

/** Scene lights shared by a draw, placed in each view's space on the CPU. */
export declare class SceneLights {
  private readonly ambient;
  private readonly visible;
  private readonly byKind;
  private count;
  /** Allocated vectors per view; shrinks only when explicitly requested. */
  readonly vectors: number;
  private readonly add;
  /** Lists the visible lights below `root`: the one walk of the scene graph. */
  collect(root: THREE.Object3D): void;
  /** Selects the listed lights on the camera's layers, keeping scene order. */
  select(camera: THREE.Camera, shrink?: boolean): void;
  /** Writes one block per view; returns whether any stored value changed. */
  fill(records: Float32Array, views: readonly THREE.Camera[]): boolean;
}
