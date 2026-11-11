import type * as THREE from "three";
import type { LodTreeIndex, LodView } from "../chunk-stream/lodTree.js";

type PreparedCamera = {
  modelView: THREE.Matrix4;
  cameraPosition: THREE.Vector3;
  fovScale: number;
};
/**
 * Capture the cameras that see the group without traversing the manifest or
 * reducing matrix precision. WebXR selects detail from each eye's current pose.
 */
export declare function captureSogView(
  cameras: readonly THREE.Camera[],
  group: THREE.Object3D,
): LodView;
/** Stable key of a view, for skipping unchanged selection requests. */
export declare function getSogViewKey(view: LodView): string;
/** One input's tree bounds and median region size. */
export declare class SogVisibility {
  private readonly manifest;
  private readonly cameras;
  private readonly bound;
  private readonly typicalHalfSize;
  private readonly shrink;
  private readonly closest;
  private readonly inverseModelView;
  private readonly sourceTransform;
  constructor(manifest: Pick<LodTreeIndex, "nodeBounds">);
  prepareCameras(view: LodView, transform: number[]): PreparedCamera[];
  measure(
    id: number,
    cameras: PreparedCamera[],
    lodBehindPenalty: number,
    lodDistanceShrink: number,
  ): number;
}

export {};
