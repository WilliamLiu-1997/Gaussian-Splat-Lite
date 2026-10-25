import type * as THREE from "three";
import type { SogLodIndex, SogLodOptions } from "./sogLod.js";
export type SogCamera = {
  modelView: number[];
  fovScale: number;
};
export type SogView = {
  /** The registered cameras that see the group; selection serves all of them. */
  cameras: SogCamera[];
  shown: boolean;
};
export type SogLodRequest = SogLodOptions & {
  view: SogView;
  lodBehindPenalty: number;
  lodDistanceShrink: number;
};
/**
 * Capture the cameras that see the group without traversing the manifest or
 * reducing matrix precision. WebXR selects detail from each eye's current pose.
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
  private readonly bound;
  private readonly typicalHalfSize;
  private readonly shrink;
  private readonly closest;
  private readonly inverseModelView;
  constructor(
    manifest: Pick<
      SogLodIndex,
      "leafBounds" | "leafOffsets" | "lods" | "lodLevels"
    >,
  );
  private prepareCameras;
  private collect;
  /** Transfer only [leaf ID, LOD ordinal] pairs in loading priority order. */
  select(request: SogLodRequest): Uint32Array;
}
