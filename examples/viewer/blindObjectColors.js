import {
  SplatEditBlind,
  SplatEditBlindField,
  SplatEditRgbaBlendMode,
} from "gaussian-splat-lite";
import { Color } from "three";

export function createBlindObjectColors(objects) {
  const edit = new SplatEditBlind({
    rgbaBlendMode: SplatEditRgbaBlendMode.SET_RGBA,
    fields: objects.map(
      ({ object_id }) =>
        new SplatEditBlindField({
          field: "object_id",
          value: object_id,
          color: new Color().setHSL(Math.random(), 0.65, 0.55),
        }),
    ),
  });
  // Apply object colors before hover and selection highlights.
  edit.ordering = 0;
  return edit;
}
