import { createBlindHighlight } from "./blindHighlight.js";
import { createBlindHover } from "./blindHover.js";

export function createObjectInspection(context) {
  const fields = document.createElement("dl");
  const hover = createBlindHighlight(0.12, context.requestRender);
  const selection = createBlindHighlight(0.3, context.requestRender);
  let displayedObject;

  return createBlindHover({
    ...context,
    view: {
      title: "Blind data",
      element: fields,
      canInspect: ({ blindFields }) => blindFields.length > 0,
      hover(mesh, blind, pinned) {
        if (
          !mesh ||
          (pinned &&
            mesh === displayedObject?.mesh &&
            blind.object_id === displayedObject.value)
        ) {
          hover.clear();
        } else {
          hover.set({ mesh, value: blind.object_id });
        }
      },
      pin() {
        selection.set(displayedObject);
      },
      clearSelection() {
        selection.clear();
        displayedObject = null;
      },
      show(mesh, blind) {
        const entries = Object.entries(blind ?? {});
        if (!entries.length) return false;
        displayedObject = { mesh, value: blind.object_id };
        const { extra, sceneExtra } = mesh.splats;
        const names = {
          object_id: extra?.labeling?.objects ?? sceneExtra?.labeling?.objects,
          part_id: extra?.labeling?.parts ?? sceneExtra?.labeling?.parts,
        };
        fields.replaceChildren();
        for (const [name, value] of entries) {
          const label = document.createElement("dt");
          const data = document.createElement("dd");
          const records = names[name];
          const displayName = Array.isArray(records)
            ? records.find((record) => record?.[name] === value)?.name
            : undefined;
          label.textContent = name;
          data.textContent =
            typeof displayName === "string" && displayName
              ? `${displayName} (${value})`
              : String(value);
          fields.append(label, data);
        }
        return true;
      },
    },
  });
}
