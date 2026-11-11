import { Object3D } from "three";
import type { SplatEditRgbaBlendMode } from "./SplatEdit.js";
import type { SplatEditBlindField } from "./SplatEditBlindField.js";

export type SplatEditBlindOptions = {
  name?: string;
  rgbaBlendMode?: SplatEditRgbaBlendMode;
  softEdge?: number;
  invert?: boolean;
  fields?: SplatEditBlindField[];
};

/** An ordered RGBA operation evaluated over Blind field selections. */
export declare class SplatEditBlind extends Object3D {
  ordering: number;
  rgbaBlendMode: SplatEditRgbaBlendMode;
  softEdge: number;
  invert: boolean;
  fields: SplatEditBlindField[] | null;
  constructor(options?: SplatEditBlindOptions);
  addField(field: SplatEditBlindField): void;
  removeField(field: SplatEditBlindField): void;
}
