import * as THREE from "three";

// Light records are packed float32 vec4s, one block per view:
//   [0] ambient rgb | world units per view unit
//   [1] number of hemisphere, directional, point and spot lights
// then LIGHT_STRIDE vectors per light, grouped by kind in that order:
//   +0 color × intensity | cutoff distance, 0 for none
//   +1 hemisphere, directional: direction toward the light
//      point, spot: position | decay
//   +2 hemisphere: ground color × intensity
//      spot: direction toward the light | cos(angle)
//   +3 spot: cos(angle × (1 - penumbra))
// Positions and directions are in the view's space.
export const LIGHT_HEADER = 2;
export const LIGHT_STRIDE = 4;

// The fill in progress, shared with the writers below: world to its view,
// and whether a stored value has changed.
const viewMatrix = new THREE.Matrix4();
let changed = false;
const scale = new THREE.Vector3();
const position = new THREE.Vector3();
const direction = new THREE.Vector3();
const target = new THREE.Vector3();

function setRecord(records, at, x, y, z, w) {
  const offset = at * 4;
  // Records are float32: compare the values as they will be stored.
  changed ||=
    records[offset] !== Math.fround(x) ||
    records[offset + 1] !== Math.fround(y) ||
    records[offset + 2] !== Math.fround(z) ||
    records[offset + 3] !== Math.fround(w);
  records[offset] = x;
  records[offset + 1] = y;
  records[offset + 2] = z;
  records[offset + 3] = w;
}
function setColor(records, at, color, intensity, w) {
  setRecord(
    records,
    at,
    color.r * intensity,
    color.g * intensity,
    color.b * intensity,
    w,
  );
}
// Toward the sky, or from a directional or spot light's target toward it.
function setDirection(records, at, light, w) {
  direction.setFromMatrixPosition(light.matrixWorld);
  if (light.target)
    direction.sub(target.setFromMatrixPosition(light.target.matrixWorld));
  if (direction.lengthSq() > 0) direction.transformDirection(viewMatrix);
  setRecord(records, at, direction.x, direction.y, direction.z, w);
}
// CPU view conversion preserves small offsets far from world zero.
function setPosition(records, at, light, w) {
  position.setFromMatrixPosition(light.matrixWorld).applyMatrix4(viewMatrix);
  setRecord(records, at, position.x, position.y, position.z, w);
}

/** Light kinds in record order, each writing the vectors after its color. */
const KINDS = [
  {
    is: "isHemisphereLight",
    write(records, at, light) {
      setDirection(records, at + 1, light, 0);
      setColor(records, at + 2, light.groundColor, light.intensity, 0);
    },
  },
  {
    is: "isDirectionalLight",
    write(records, at, light) {
      setDirection(records, at + 1, light, 0);
    },
  },
  {
    is: "isPointLight",
    write(records, at, light) {
      setPosition(records, at + 1, light, light.decay);
    },
  },
  {
    is: "isSpotLight",
    write(records, at, light) {
      setPosition(records, at + 1, light, light.decay);
      setDirection(records, at + 2, light, Math.cos(light.angle));
      const innerCos = Math.cos(light.angle * (1 - light.penumbra));
      setRecord(records, at + 3, innerCos, 0, 0, 0);
    },
  },
];

/** Packed storage for `vectors` vec4 light records. */
export function createLightRecords(vectors) {
  return new Float32Array(vectors * 4);
}

/** Scene lights shared by a draw, placed in each view's space on the CPU. */
export class SceneLights {
  constructor() {
    this.ambient = new THREE.Color();
    // Visible lights below the root, in scene order.
    this.visible = [];
    // Those a camera sees, by kind, indexed like KINDS.
    this.byKind = KINDS.map(() => []);
    this.count = 0;
    // Retain each view's capacity when lights disappear or change layers.
    this.vectors = LIGHT_HEADER;
    this.add = (object) => {
      if (object.isLight) this.visible.push(object);
    };
  }

  /** Lists the visible lights below `root`: the one walk of the scene graph. */
  collect(root) {
    this.visible.length = 0;
    root.traverseVisible(this.add);
  }

  /** Selects the listed lights on the camera's layers, keeping scene order. */
  select(camera, shrink = false) {
    this.ambient.setScalar(0);
    for (const lights of this.byKind) lights.length = 0;
    this.count = 0;
    for (const light of this.visible) {
      if (light.intensity === 0 || !light.layers.test(camera.layers)) continue;
      if (light.isAmbientLight) {
        this.ambient.r += light.color.r * light.intensity;
        this.ambient.g += light.color.g * light.intensity;
        this.ambient.b += light.color.b * light.intensity;
        continue;
      }
      const kind = KINDS.findIndex(({ is }) => light[is]);
      if (kind < 0) continue;
      this.byKind[kind].push(light);
      this.count++;
    }
    const vectors = LIGHT_HEADER + this.count * LIGHT_STRIDE;
    this.vectors = shrink ? vectors : Math.max(this.vectors, vectors);
  }

  /** Writes one block per view; returns whether any stored value changed. */
  fill(records, views) {
    const { ambient, byKind, vectors } = this;
    changed = false;
    for (let block = 0; block < views.length; block++) {
      const view = views[block];
      // Keep the camera rig's scale, which Camera.matrixWorldInverse can drop.
      viewMatrix.copy(view.matrixWorld).invert();
      scale.setFromMatrixScale(view.matrixWorld);
      let at = block * vectors;
      setColor(records, at, ambient, 1, (scale.x + scale.y + scale.z) / 3);
      setRecord(
        records,
        at + 1,
        byKind[0].length,
        byKind[1].length,
        byKind[2].length,
        byKind[3].length,
      );
      at += LIGHT_HEADER;
      for (let kind = 0; kind < KINDS.length; kind++) {
        for (const light of byKind[kind]) {
          const { color, intensity, distance = 0 } = light;
          setColor(records, at, color, intensity, distance);
          KINDS[kind].write(records, at, light);
          at += LIGHT_STRIDE;
        }
      }
    }
    return changed;
  }
}
