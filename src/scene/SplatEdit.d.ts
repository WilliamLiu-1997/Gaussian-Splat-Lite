import * as THREE from "three";
import type { SplatBlindField } from "../data/defines.js";
import type { SplatEditBlind } from "./SplatEditBlind.js";
export type SplatEditSelection = SplatEditSdf | SplatEditBlind;
export declare enum SplatEditSdfType {
  ALL = "all",
  PLANE = "plane",
  SPHERE = "sphere",
  BOX = "box",
  ELLIPSOID = "ellipsoid",
  CYLINDER = "cylinder",
  CAPSULE = "capsule",
  INFINITE_CONE = "infinite_cone",
}
/** RGBA-only operations supported by the edit pipeline. */
export declare enum SplatEditRgbaBlendMode {
  MULTIPLY_RGBA = "multiply_rgba",
  SET_RGBA = "set_rgba",
  ADD_RGBA = "add_rgba",
}
export type SplatEditSdfColor = {
  r?: number;
  g?: number;
  b?: number;
};
export type SplatEditSdfOptions = {
  type?: SplatEditSdfType;
  invert?: boolean;
  opacity?: number;
  color?: SplatEditSdfColor;
  radius?: number;
};
/** A signed-distance shape carrying optional color and opacity channels. */
export declare class SplatEditSdf extends THREE.Object3D {
  type: SplatEditSdfType;
  invert: boolean;
  opacity?: number;
  color: SplatEditSdfColor;
  radius: number;
  constructor(options?: SplatEditSdfOptions);
}
export type SplatEditOptions = {
  name?: string;
  rgbaBlendMode?: SplatEditRgbaBlendMode;
  sdfSmooth?: number;
  softEdge?: number;
  invert?: boolean;
  sdfs?: SplatEditSelection[];
};
/** An ordered RGBA operation evaluated over SDF shapes or Blind selections. */
export declare class SplatEdit extends THREE.Object3D {
  ordering: number;
  rgbaBlendMode: SplatEditRgbaBlendMode;
  sdfSmooth: number;
  softEdge: number;
  invert: boolean;
  sdfs: SplatEditSelection[] | null;
  static nextOrdering: number;
  constructor(options?: SplatEditOptions);
  addSdf(sdf: SplatEditSelection): void;
  removeSdf(sdf: SplatEditSelection): void;
}
export type SplatEditGroup = {
  edit: SplatEdit;
  sdfs: SplatEditSelection[];
};
/** Encodes SDF geometry/RGBA and edit operations as regular integer textures. */
export declare class SplatEdits {
  hasBlind: boolean;
  maxSdfs: number;
  numSdfs: number;
  sdfData: Uint32Array;
  sdfTexture: THREE.DataTexture;
  maxEdits: number;
  numEdits: number;
  editData: Uint32Array;
  editTexture: THREE.DataTexture;
  constructor({
    maxSdfs,
    maxEdits,
  }?: {
    maxSdfs?: number | undefined;
    maxEdits?: number | undefined;
  });
  dispose(): void;
  update(
    groups: SplatEditGroup[],
    coordinateOrigin?: THREE.Vector3,
    shrinkResources?: boolean,
    blindFields?: SplatBlindField[][],
  ): {
    updated: boolean;
  };
  private ensureCapacity;
  private encodeEdit;
  private encodeSdf;
  private setSdfUint;
  private setSdfFloat;
  private setEditUint;
  private setEditFloat;
  static emptyTexture: THREE.DataTexture;
}
