import * as THREE from "three";
import { SplatEdit } from "../scene/SplatEdit";

/** Filter capture data without changing visibility while sorting is pending. */
export function captureSceneView(
  scene: THREE.Scene,
  hideObjects: readonly THREE.Object3D[],
): THREE.Scene {
  if (hideObjects.length === 0) return scene;

  const hidden = new Set(hideObjects);
  const view = new THREE.Scene();
  view.matrixWorldAutoUpdate = scene.matrixWorldAutoUpdate;
  view.updateMatrixWorld = (force) => scene.updateMatrixWorld(force);

  const filter =
    (callback: (object: THREE.Object3D) => void) =>
    (object: THREE.Object3D) => {
      // Captures use the same visible edits as the display.
      if (!(object instanceof SplatEdit)) {
        let ancestor: THREE.Object3D | null = object;
        while (ancestor) {
          if (hidden.has(ancestor)) return;
          ancestor = ancestor.parent;
        }
      }
      callback(object);
    };
  view.traverse = (callback) => scene.traverse(filter(callback));
  view.traverseVisible = (callback) => scene.traverseVisible(filter(callback));
  return view;
}
