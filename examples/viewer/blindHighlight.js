import {
  SplatEditBlind,
  SplatEditBlindField,
  SplatEditRgbaBlendMode,
} from "gaussian-splat-lite";

export function createBlindHighlight(brightness, onChange) {
  const edit = new SplatEditBlind({
    rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA,
  });
  const selection = new SplatEditBlindField({
    field: "object_id",
    value: 0,
    color: { r: brightness, g: brightness, b: brightness },
  });
  edit.add(selection);

  function clear() {
    if (!edit.parent) return;
    edit.removeFromParent();
    onChange();
  }

  return {
    clear,
    set(object) {
      if (!object) {
        clear();
        return;
      }
      if (edit.parent === object.mesh && selection.value === object.value)
        return;
      selection.value = object.value;
      object.mesh.add(edit);
      onChange();
    },
  };
}
