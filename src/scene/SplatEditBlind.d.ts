import { Object3D } from "three";
import type { SplatBlindField } from "../data/defines.js";
import type { SplatEditSdfColor } from "./SplatEdit.js";

export type SplatEditBlindOptions = {
  /** Original field name in SOG v3 metadata. */
  field: string;
  /** Exact finite match; cannot be combined with min/max. */
  value?: number;
  /** Inclusive lower bound; omit or use -Infinity for none. */
  min?: number;
  /** Inclusive upper bound; omit or use Infinity for none. A max below min selects nothing. */
  max?: number;
  invert?: boolean;
  color?: SplatEditSdfColor;
  opacity?: number;
};

/** Select Gaussians by an exact SOG v3 Blind value or an inclusive range.
 * Later changes to an invalid combination disable the selection until they are valid again. */
export declare class SplatEditBlind extends Object3D {
  field: string;
  value?: number;
  min?: number;
  max?: number;
  invert: boolean;
  color: SplatEditSdfColor;
  opacity?: number;
  /** Throws for a missing field, a non-finite value, or a value combined with min/max. */
  constructor(options: SplatEditBlindOptions);
}

/** @internal Blind record flags shared with the generate shaders. */
export declare const BLIND_SDF_TYPE: 8;
/** @internal */
export declare const BLIND_ACTIVE: number;
/** @internal */
export declare const BLIND_ENCODING_SHIFT: 10;
/** @internal */
export declare const BLIND_HAS_LOWER: number;
/** @internal */
export declare const BLIND_HAS_UPPER: number;
/** @internal Encode one SplatEdits record; the returned array is reused. */
export declare function encodeBlindSelection(
  selection: SplatEditBlind,
  fields: SplatBlindField[][],
): Uint32Array;
