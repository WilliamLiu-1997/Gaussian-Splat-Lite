import type * as THREE from "three";
import type { SogLodIndex } from "./sogLod.js";
export type SogCamera = {
  modelView: number[];
  projection: number[];
  coordinateSystem: THREE.CoordinateSystem;
  reversedDepth: boolean;
};
export type SogView = {
  /** The registered cameras that see the group; selection serves all of them. */
  cameras: SogCamera[];
  shown: boolean;
};
/**
 * Capture the cameras that see the group without traversing the manifest or
 * reducing matrix precision. WebXR selects detail from each eye's current pose and frustum.
 */
export declare function captureSogView(
  cameras: readonly THREE.Camera[],
  group: THREE.Object3D,
): SogView;
/** Stable key of a view, for skipping unchanged selection requests. */
export declare function getSogViewKey(view: SogView): string;
/** Worker traversal state keeps leaf identities stable between selections. */
export declare class SogVisibility {
  private readonly manifest;
  private readonly leaves;
  private readonly cameras;
  private readonly clip;
  private readonly bound;
  private readonly closest;
  private readonly inverseModelView;
  constructor(
    manifest: Pick<
      SogLodIndex,
      "nodes" | "leafOffsets" | "lods" | "upgradeRatios"
    >,
  );
  private prepareCameras;
  private collect;
  /** Transfer only [leaf ID, LOD ordinal] pairs in loading priority order. */
  select(view: SogView, budget: number): Uint32Array;
}
