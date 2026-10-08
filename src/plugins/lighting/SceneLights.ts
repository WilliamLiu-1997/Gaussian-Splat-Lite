import * as THREE from "three";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
} from "../../rendering/rendererUtils";

type LightKind = "hemisphere" | "directional" | "point" | "spot";

type SceneLight = THREE.Light & {
  isAmbientLight?: boolean;
  isHemisphereLight?: boolean;
  isDirectionalLight?: boolean;
  isPointLight?: boolean;
  isSpotLight?: boolean;
  groundColor?: THREE.Color;
  shadow?: THREE.LightShadow;
  target?: THREE.Object3D;
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
};

/**
 * How a shadow map is read. Three.js documents `LightShadow.map` as the depth
 * its shadow camera sees and `LightShadow.matrix` as the way into it; this is
 * what its renderers add to that, read from the map itself where it says so.
 */
export type ShadowMapKind = {
  /** A point light's map: a cube around the light. */
  cube: boolean;
  /**
   * compare: depth, tested by the sampler. depth: plain depth. moments: the
   * mean and standard deviation of depth, in the map's color texture.
   */
  source: "compare" | "depth" | "moments";
  filter: "hard" | "pcf" | "variance";
};

/**
 * What Three.js's CSMShadowNode addon documents of itself: a light for each
 * cascade, and where the view's depth range splits between them.
 */
export type CascadedShadowNode = {
  id: number;
  cascades: number;
  fade: boolean;
  breaks: number[];
  maxFar: number;
  camera: THREE.Camera | null;
  lights: { shadow: THREE.LightShadow }[];
};

export type LightSlot = {
  kind: LightKind;
  /** First vec4 of the light's record within a view's block. */
  offset: number;
  shadow: (ShadowMapKind & { index: number; offset: number }) | null;
  /** WebGPU CSM exposes each cascade's shadow through its public lights. */
  cascades?: {
    node: CascadedShadowNode;
    shadows: NonNullable<LightSlot["shadow"]>[];
  };
};

/** The shape of a scene's lighting; lit shaders are generated from it. */
export type LightLayout = {
  key: string;
  slots: LightSlot[];
  /** vec4 count of one view's block. */
  vectors: number;
  shadows: number;
};

// vec4 per light: color and range first, then position or direction.
const RECORD_SIZE: Record<LightKind, number> = {
  hemisphere: 3,
  directional: 2,
  point: 2,
  spot: 4,
};
const KINDS = Object.keys(RECORD_SIZE) as LightKind[];
const SHADOW_RECORD_SIZE = 2;

function kindOf(light: SceneLight): LightKind | null {
  if (light.isHemisphereLight) return "hemisphere";
  if (light.isDirectionalLight) return "directional";
  if (light.isPointLight) return "point";
  if (light.isSpotLight) return "spot";
  return null;
}

/**
 * What the shadow map Three.js keeps for a light holds, or null without one.
 * A map's texture tells how to sample it; variance maps differ by renderer:
 * WebGLRenderer blurs depth into the color texture and leaves no depth, while
 * WebGPURenderer keeps its blurred copy to itself and leaves the depth.
 */
function describeShadowMap(
  renderer: GaussianSplatCompatibleRenderer,
  light: SceneLight,
): ShadowMapKind | null {
  if (!renderer.shadowMap.enabled || !light.castShadow) return null;
  const { shadow } = light;
  // A caller's own shadow node renders and samples elsewhere.
  if (!shadow || shadow.shadowNode !== undefined) return null;
  return describeShadowTexture(renderer, shadow);
}

/**
 * A light's cascaded shadow node, or null. It is told by its fields, not by
 * its class: an application may load its own copy of the addon.
 */
function cascadedShadowNode(
  shadow: THREE.LightShadow | undefined,
): CascadedShadowNode | null {
  const node = shadow?.shadowNode as Partial<CascadedShadowNode> | undefined;
  return node !== undefined &&
    typeof node.cascades === "number" &&
    Array.isArray(node.breaks) &&
    Array.isArray(node.lights)
    ? (node as CascadedShadowNode)
    : null;
}

function describeShadowTexture(
  renderer: GaussianSplatCompatibleRenderer,
  shadow: THREE.LightShadow,
): ShadowMapKind | null {
  const depth = shadow.map?.depthTexture as
    | (THREE.DepthTexture & { isCubeTexture?: boolean })
    | null
    | undefined;
  if (!depth) return null;
  const cube = depth.isCubeTexture === true;
  const { type } = renderer.shadowMap;
  if (depth.compareFunction)
    return {
      cube,
      source: "compare",
      filter: type === THREE.BasicShadowMap ? "hard" : "pcf",
    };
  if (type === THREE.VSMShadowMap && !cube)
    return {
      cube,
      source: isWebGPURenderer(renderer) ? "depth" : "moments",
      filter: "variance",
    };
  return { cube, source: "depth", filter: "hard" };
}

function shadowKey(shadow: ShadowMapKind | null) {
  return shadow
    ? `${shadow.cube ? "c" : "f"}${shadow.source[0]}${shadow.filter[0]}`
    : "-";
}

function shadowRecords(slot: LightSlot) {
  return slot.cascades?.shadows ?? (slot.shadow ? [slot.shadow] : []);
}

const viewMatrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const direction = new THREE.Vector3();
const target = new THREE.Vector3();
const scale = new THREE.Vector3();

/**
 * One layout's uniform values: a block of vec4 for each view, a matrix for
 * each view and shadow, and each shadow's map.
 */
export class LightBlock {
  readonly vectors: THREE.Vector4[];
  readonly matrices: THREE.Matrix4[];
  readonly maps: (THREE.Texture | null)[];
  readonly colors: (THREE.Texture | null)[];

  constructor(
    readonly layout: LightLayout,
    readonly views: number,
  ) {
    this.vectors = Array.from(
      { length: views * layout.vectors },
      () => new THREE.Vector4(),
    );
    this.matrices = Array.from(
      { length: views * layout.shadows },
      () => new THREE.Matrix4(),
    );
    this.maps = new Array(layout.shadows).fill(null);
    this.colors = new Array(layout.shadows).fill(null);
  }
}

/**
 * The lights of one render, read from the scene as Three.js reads them, and
 * placed in each view's own space with double precision: lit Splats take
 * nothing from Three.js's lighting but its shadow maps.
 */
export class SceneLights {
  private readonly ambient = new THREE.Color();
  private readonly lights: { light: SceneLight; kind: LightKind }[] = [];
  // Every visible light of the rendered root, on whatever layers.
  private readonly all: SceneLight[] = [];

  constructor(private readonly renderer: GaussianSplatCompatibleRenderer) {}

  /** Lists the lights `camera`'s layers see, as a render of `root` does. */
  collect(root: THREE.Object3D, camera: THREE.Camera) {
    const { ambient, lights, all } = this;
    ambient.setScalar(0);
    lights.length = 0;
    all.length = 0;
    root.traverseVisible((object) => {
      const light = object as SceneLight;
      if (!light.isLight) return;
      all.push(light);
      if (!light.layers.test(camera.layers)) return;
      if (light.isAmbientLight) {
        ambient.r += light.color.r * light.intensity;
        ambient.g += light.color.g * light.intensity;
        ambient.b += light.color.b * light.intensity;
        return;
      }
      const kind = kindOf(light);
      if (kind) lights.push({ light, kind });
    });
    // Stable, so lights of a kind keep their scene order.
    lights.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  }

  /** Whether the render draws a shadow map for any of the listed lights. */
  get castsShadows() {
    return (
      this.renderer.shadowMap.enabled &&
      this.lights.some(({ light }) => light.castShadow)
    );
  }

  /**
   * Which lights the rendered scene has and which of them cast shadows, to
   * whatever camera. While this stays as it is, Three.js releases no shadow
   * map a built shader reads; a camera whose layers select other lights
   * changes nothing here.
   */
  get shape() {
    const { shadowMap } = this.renderer;
    const transmitted =
      isWebGPURenderer(this.renderer) && this.renderer.shadowMap.transmitted;
    return `${shadowMap.enabled ? shadowMap.type : "-"}:${Number(transmitted)}:${this.all
      .map((light) => {
        if (!light.castShadow) return `${light.id}-`;
        const node = cascadedShadowNode(light.shadow);
        if (node)
          return `${light.id}c${node.id}:${node.cascades}:${Number(node.fade)}`;
        return light.id + (light.shadow?.shadowNode ? "n" : "s");
      })
      .join()}`;
  }

  /** Whether a light of the rendered scene has a variance map of `shadow`. */
  blurs(shadow: THREE.LightShadow) {
    if (!this.renderer.shadowMap.enabled) return false;
    return this.all.some(
      (light) =>
        (light.shadow === shadow &&
          describeShadowMap(this.renderer, light)?.filter === "variance") ||
        (light.castShadow &&
          cascadedShadowNode(light.shadow)?.lights.some(
            (cascade) =>
              cascade.shadow === shadow &&
              describeShadowTexture(this.renderer, shadow)?.filter ===
                "variance",
          ) === true),
    );
  }

  /** The shadow of the light that casts shadow `index` of a layout. */
  shadowOf(layout: LightLayout, index: number) {
    for (const [at, slot] of layout.slots.entries()) {
      for (const [cascade, record] of shadowRecords(slot).entries()) {
        if (record.index === index)
          return (
            slot.cascades
              ? slot.cascades.node.lights[cascade]
              : this.lights[at].light
          ).shadow as THREE.LightShadow;
      }
    }
    throw new Error("A light layout has no such shadow");
  }

  /** The listed lights' layout, with the shadow maps Three.js holds now. */
  layout(): LightLayout {
    // The first vec4 of a block is the ambient light and the view's scale.
    let vectors = 1;
    let shadows = 0;
    const slots: LightSlot[] = this.lights.map(({ light, kind }) => {
      const slot: LightSlot = { kind, offset: vectors, shadow: null };
      vectors += RECORD_SIZE[kind];
      const shadow =
        kind === "hemisphere" ? null : describeShadowMap(this.renderer, light);
      if (shadow) {
        slot.shadow = { ...shadow, index: shadows++, offset: vectors };
        vectors += SHADOW_RECORD_SIZE;
      } else if (
        kind === "directional" &&
        this.renderer.shadowMap.enabled &&
        light.castShadow &&
        isWebGPURenderer(this.renderer)
      ) {
        const node = cascadedShadowNode(light.shadow);
        const kinds =
          node?.lights.map((cascade) =>
            describeShadowTexture(this.renderer, cascade.shadow),
          ) ?? [];
        // The node makes its lights when a shader first builds it.
        if (node && kinds.length > 0 && kinds.every((kind) => kind !== null)) {
          const records = kinds.map((kind) => {
            const record = { ...kind, index: shadows++, offset: vectors };
            vectors += SHADOW_RECORD_SIZE;
            return record;
          });
          slot.cascades = { node, shadows: records };
        }
      }
      return slot;
    });
    return {
      key: slots
        .map(
          (slot) =>
            slot.kind[0] +
            (slot.cascades
              ? `c${Number(slot.cascades.node.fade)}${slot.cascades.shadows.map(shadowKey).join("")}`
              : shadowKey(slot.shadow)),
        )
        .join(""),
      slots,
      vectors,
      shadows,
    };
  }

  /**
   * Fills a block for the views of one draw. Returns false when a shadow map
   * of its layout is gone or of another kind: the block's shader cannot then
   * draw. A block made before a map existed draws, without that shadow.
   */
  fill(block: LightBlock, views: readonly THREE.Camera[]) {
    const { layout, vectors, matrices, maps, colors } = block;
    const { lights, ambient } = this;
    if (layout.slots.length !== lights.length) return false;
    for (const [index, slot] of layout.slots.entries()) {
      const { light, kind } = lights[index];
      if (slot.kind !== kind) return false;
      for (const [cascade, shadow] of shadowRecords(slot).entries()) {
        const lightShadow = (
          slot.cascades ? slot.cascades.node.lights[cascade] : light
        ).shadow as THREE.LightShadow;
        const current = describeShadowTexture(this.renderer, lightShadow);
        if (shadowKey(current) !== shadowKey(shadow)) return false;
        const map = lightShadow.map as THREE.RenderTarget;
        maps[shadow.index] =
          shadow.source === "moments" ? map.texture : map.depthTexture;
        colors[shadow.index] = map.texture;
      }
    }
    for (let view = 0; view < block.views; view++) {
      const eye = views[Math.min(view, views.length - 1)];
      const base = view * layout.vectors;
      // The view space Splats draw in keeps a camera rig's scale, which
      // Camera.matrixWorldInverse can drop.
      viewMatrix.copy(eye.matrixWorld).invert();
      scale.setFromMatrixScale(eye.matrixWorld);
      const worldPerView = (scale.x + scale.y + scale.z) / 3;
      vectors[base].set(ambient.r, ambient.g, ambient.b, worldPerView);
      for (const [index, slot] of layout.slots.entries()) {
        const { light } = lights[index];
        const at = base + slot.offset;
        const { color, intensity } = light;
        vectors[at].set(
          color.r * intensity,
          color.g * intensity,
          color.b * intensity,
          light.distance ?? 0,
        );
        position.setFromMatrixPosition(light.matrixWorld);
        // Toward the light: a hemisphere light's sky, or a directional or
        // spot light's position seen from its target.
        direction.copy(position);
        if (light.target)
          direction.sub(target.setFromMatrixPosition(light.target.matrixWorld));
        if (direction.lengthSq() > 0) direction.transformDirection(viewMatrix);
        if (slot.kind === "hemisphere" || slot.kind === "directional") {
          vectors[at + 1].set(direction.x, direction.y, direction.z, 0);
          const ground = light.groundColor;
          if (ground)
            vectors[at + 2].set(
              ground.r * intensity,
              ground.g * intensity,
              ground.b * intensity,
              0,
            );
        } else {
          // Subtracting the view's origin here keeps positions far from the
          // world origin exact.
          position.applyMatrix4(viewMatrix);
          vectors[at + 1].set(
            position.x,
            position.y,
            position.z,
            light.decay ?? 0,
          );
        }
        if (slot.kind === "spot") {
          const angle = light.angle ?? 0;
          vectors[at + 2].set(
            direction.x,
            direction.y,
            direction.z,
            Math.cos(angle),
          );
          vectors[at + 3].set(
            Math.cos(angle * (1 - (light.penumbra ?? 0))),
            0,
            0,
            0,
          );
        }
        for (const [cascade, record] of shadowRecords(slot).entries()) {
          const shadow = (
            slot.cascades ? slot.cascades.node.lights[cascade] : light
          ).shadow as THREE.LightShadow;
          const camera = shadow.camera as THREE.PerspectiveCamera;
          const at = base + record.offset;
          // Bias along the normal in view units; filter radius in map widths.
          vectors[at].set(
            shadow.bias,
            shadow.normalBias / worldPerView,
            shadow.radius / shadow.mapSize.x,
            shadow.intensity,
          );
          vectors[at + 1].set(camera.near, camera.far, 0, 0);
          // Composed here, the world's translation never reaches float32.
          matrices[view * layout.shadows + record.index].multiplyMatrices(
            shadow.matrix,
            eye.matrixWorld,
          );
        }
      }
    }
    return true;
  }
}
