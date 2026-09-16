import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { Line2 as WebGPULine2 } from "three/addons/lines/webgpu/Line2.js";
import { LineSegments2 as WebGPULineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { Line2NodeMaterial } from "three/webgpu";

// XZ reference at Y = 0; scaled to the loaded model in frameSplat.
const referenceBaseSize = 10;
function createReferenceMaterial(webGPU, color, linewidth) {
  const Material = webGPU ? Line2NodeMaterial : LineMaterial;
  const material = new Material({
    color,
    linewidth,
    worldUnits: false,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    toneMapped: false,
    alphaToCoverage: false,
  });
  material.userData.referenceColor = color;
  return material;
}

function createGrid(webGPU) {
  const halfSize = referenceBaseSize / 2;
  const positions = [];
  // Ten ticks on each side; leave the center lines to the colored axes.
  for (let i = -10; i <= 10; i++) {
    if (i === 0) continue;
    const offset = (i * referenceBaseSize) / 20;
    positions.push(-halfSize, 0, offset, halfSize, 0, offset);
    positions.push(offset, 0, -halfSize, offset, 0, halfSize);
  }
  const geometry = new LineSegmentsGeometry().setPositions(positions);
  const Line = webGPU ? WebGPULineSegments2 : LineSegments2;
  const line = new Line(geometry, createReferenceMaterial(webGPU, 0x666666, 1));
  line.raycast = () => {};
  return line;
}

function createAxes(webGPU) {
  const group = new THREE.Group();
  const halfSize = referenceBaseSize / 2;
  const Line = webGPU ? WebGPULine2 : Line2;
  for (const [color, positions] of [
    [0xff0000, [-halfSize, 0, 0, halfSize, 0, 0]],
    [0x0000ff, [0, 0, -halfSize, 0, 0, halfSize]],
  ]) {
    const geometry = new LineGeometry().setPositions(positions);
    const material = createReferenceMaterial(webGPU, color, 1.5);
    const line = new Line(geometry, material);
    line.raycast = () => {};
    group.add(line);
  }
  return group;
}

export function createReferenceHelpers() {
  const group = new THREE.Group();
  const webGL = new THREE.Group();
  const webGPU = new THREE.Group();
  webGL.add(createGrid(false), createAxes(false));
  webGPU.add(createGrid(true), createAxes(true));
  webGL.visible = false;
  group.add(webGL, webGPU);

  return {
    group,
    get visible() {
      return group.visible;
    },
    setVisible(visible) {
      group.visible = visible;
    },
    setBackend(usesNodeRenderer) {
      webGL.visible = !usesNodeRenderer;
      webGPU.visible = usesNodeRenderer;
    },
    setFrame(center, size) {
      group.position.copy(center);
      group.scale.setScalar(size / referenceBaseSize);
    },
    syncColors() {
      // Reapply sRGB colors when working space changes instead of
      // reinterpreting the RGB components from the previous space.
      group.traverse((object) => {
        const material = object.material;
        if (!material) return;
        material.color.setHex(
          material.userData.referenceColor,
          THREE.SRGBColorSpace,
        );
        material.needsUpdate = true;
      });
    },
    dispose() {
      group.removeFromParent();
      group.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      group.clear();
    },
  };
}
