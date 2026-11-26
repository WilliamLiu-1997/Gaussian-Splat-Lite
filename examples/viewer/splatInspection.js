import { createBlindHover } from "./blindHover.js";
import { createJsonTree } from "./jsonTree.js";

export function createSplatInspection(context) {
  const tree = createJsonTree(["blind"]);
  return createBlindHover({
    ...context,
    view: {
      title: "Splat data",
      element: tree.element,
      canInspect({ blindFields, extra, sceneExtra }) {
        return (
          blindFields.length > 0 ||
          extra !== undefined ||
          sceneExtra !== undefined
        );
      },
      show({ splats: { extra, sceneExtra } }, blind) {
        if (
          !Object.keys(blind ?? {}).length &&
          extra === undefined &&
          sceneExtra === undefined
        )
          return false;
        tree.update({ blind, extra, sceneExtra });
        return true;
      },
    },
  });
}
