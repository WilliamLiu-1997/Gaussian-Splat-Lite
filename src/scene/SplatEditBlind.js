import { Object3D } from "three";
import { getBlindFieldLayout } from "../data/blindFields.js";

// A Blind selection fills one SplatEdits record (six RGBA32UI texels). Its
// header flags keep the SDF type, invert and RGBA mask bits; the generate
// shaders read the Blind bits below, and splatGenerate.glsl repeats them.
export const BLIND_SDF_TYPE = 8;
/** The field exists and the options are valid; shaders skip other records. */
export const BLIND_ACTIVE = 1 << 9;
export const BLIND_ENCODING_SHIFT = 10;
export const BLIND_HAS_LOWER = 1 << 12;
export const BLIND_HAS_UPPER = 1 << 13;
const SDF_INVERT = 1 << 8;
const SDF_RGBA_MASK_SHIFT = 16;
const F32_MAX = 3.4028234663852886e38;

const record = new Uint32Array(24);
const floats = new Float32Array(record.buffer);

const isBound = (bound, unbounded) =>
  bound === undefined || bound === unbounded || Number.isFinite(bound);

/** A min above max is valid and selects nothing. */
function isValid({ field, value, min, max }) {
  return (
    typeof field === "string" &&
    field !== "" &&
    (value === undefined
      ? isBound(min, Number.NEGATIVE_INFINITY) &&
        isBound(max, Number.POSITIVE_INFINITY)
      : Number.isFinite(value) && min === undefined && max === undefined)
  );
}

/** Select Gaussians by an exact SOG v3 Blind value or an inclusive range. */
export class SplatEditBlind extends Object3D {
  constructor(options) {
    super();
    if (!isValid(options))
      throw new Error(
        "SplatEditBlind requires a field and either a finite value or a min/max range",
      );
    this.field = options.field;
    this.value = options.value;
    this.min = options.min;
    this.max = options.max;
    this.invert = options.invert ?? false;
    this.color = options.color ?? {};
    this.opacity = options.opacity;
  }
}

// Integer fields subtract the integer anchor on the GPU before converting to
// float, so adjacent u32 values stay distinct above 2^24.
function setBound(slot, value, integer, maxValue) {
  const bound = Math.min(F32_MAX, Math.max(-F32_MAX, value));
  if (!integer) {
    floats[slot] = bound;
    return;
  }
  record[slot] = Math.min(maxValue, Math.max(0, Math.floor(bound)));
  floats[slot + 2] = bound - record[slot];
}

/** @internal Encode one record, reusing the SDF transform slots for the field and its bounds.
 * Invalid options or a missing field leave the record inactive. The result is reused. */
export function encodeBlindSelection(selection, fields) {
  const { field, value, min, max, color, opacity, invert } = selection;
  record.fill(0);
  const mask =
    (color.r === undefined ? 0 : 1) |
    (color.g === undefined ? 0 : 2) |
    (color.b === undefined ? 0 : 4) |
    (opacity === undefined ? 0 : 8);
  record[3] =
    BLIND_SDF_TYPE | (invert ? SDF_INVERT : 0) | (mask << SDF_RGBA_MASK_SHIFT);
  floats[16] = color.r ?? 0;
  floats[17] = color.g ?? 0;
  floats[18] = color.b ?? 0;
  floats[19] = opacity ?? 0;
  if (!isValid(selection)) return record;
  for (let group = 0; group < fields.length; group++) {
    const definition = getBlindFieldLayout(fields[group]).lookup.get(field);
    if (!definition) continue;
    const lower = value ?? min;
    const upper = value ?? max;
    if (lower > upper) {
      // Empty ranges use inverted ALL, preserving RGBA for the parent's inversion.
      record[3] = (invert ? 0 : SDF_INVERT) | (mask << SDF_RGBA_MASK_SHIFT);
      floats[23] = 1;
      return record;
    }
    const { shift, mask: fieldMask, encoding, range } = definition;
    const integer = encoding === 0;
    record[0] = group;
    record[1] = shift;
    record[2] = fieldMask;
    let flags = BLIND_ACTIVE | (encoding << BLIND_ENCODING_SHIFT);
    // Shaders skip a missing bound, so they never see an infinity.
    if (lower !== undefined && lower !== Number.NEGATIVE_INFINITY) {
      flags |= BLIND_HAS_LOWER;
      setBound(8, lower, integer, fieldMask);
    }
    if (upper !== undefined && upper !== Number.POSITIVE_INFINITY) {
      flags |= BLIND_HAS_UPPER;
      setBound(9, upper, integer, fieldMask);
    }
    // Normalized fields reuse the integer residual slots for decoding.
    if (encoding === 3) {
      floats[10] = range[0];
      floats[11] = range[1];
    }
    record[3] |= flags;
    return record;
  }
  return record;
}
