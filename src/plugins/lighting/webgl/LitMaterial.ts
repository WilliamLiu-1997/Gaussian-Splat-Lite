import * as THREE from "three";
import type { SplatMaterialOptions } from "../../../rendering/backend";
import { type Uniforms, emptyOrdering } from "../../../rendering/uniforms";
import { createWebGLSplatMaterial } from "../../../rendering/webgl/SplatMaterial";
import { getShaders } from "../../../rendering/webgl/shaders";
import {
  LightBlock,
  type LightLayout,
  type LightSlot,
  type SceneLights,
} from "../SceneLights";
import lighting from "./lighting.glsl";
import surfaceVertex from "./surfaceVertex.glsl";
import surfaceVertexPars from "./surfaceVertexPars.glsl";

// Where the Splat shaders leave room for a shaded variant's code.
const DECLARATIONS = "#include <splatShadingPars>";
const MAIN = "#include <splatShading>";

function insert(source: string, declarations: string, main: string) {
  if (!source.includes(DECLARATIONS) || !source.includes(MAIN))
    throw new Error("Splat shaders lost their shading includes");
  return source.replace(DECLARATIONS, declarations).replace(MAIN, main);
}

type ShadowSlot = NonNullable<LightSlot["shadow"]>;

// How lighting.glsl samples each kind of shadow map.
function shadowSampler(shadow: ShadowSlot) {
  const type = shadow.cube ? "samplerCube" : "sampler2D";
  return shadow.source === "compare" ? `${type}Shadow` : type;
}

function shadowFunction(shadow: ShadowSlot) {
  const name = shadow.cube ? "gslCubeShadow" : "gslShadow";
  if (shadow.source === "compare")
    return name + (shadow.filter === "pcf" ? "Pcf" : "Hard");
  return name + (shadow.source === "moments" ? "Moments" : "Depth");
}

/** GLSL that lights one fragment by a layout's lights: see lighting.glsl. */
function shadeSource(layout: LightLayout) {
  const samplers: string[] = [];
  const lines: string[] = [];
  for (const slot of layout.slots) {
    const at = (index: number) => `gslLight[${slot.offset + index}]`;
    if (slot.kind === "hemisphere") {
      lines.push(
        `irradiance += mix(${at(2)}.rgb, ${at(0)}.rgb, 0.5 * dot(normal, ${at(1)}.xyz) + 0.5);`,
      );
      continue;
    }
    lines.push(
      slot.kind === "directional"
        ? `light = gslDirectionalLight(${at(1)}, normal);`
        : slot.kind === "point"
          ? `light = gslPointLight(${at(0)}, ${at(1)}, point, normal);`
          : `light = gslSpotLight(${at(0)}, ${at(1)}, ${at(2)}, ${at(3)}, point, normal);`,
    );
    let reach = "light.w";
    const { shadow } = slot;
    if (shadow) {
      const map = `gslShadowMap${shadow.index}`;
      samplers.push(`uniform highp ${shadowSampler(shadow)} ${map};`);
      const range = shadow.cube ? `, gslLight[${shadow.offset + 1}]` : "";
      reach += ` * (shadowed ? ${shadowFunction(shadow)}(${map}, gslShadowView[${shadow.index}], gslLight[${shadow.offset}]${range}, point, normal) : 1.0)`;
    }
    // Lights that do not reach the surface skip their shadow lookups.
    lines.push(`if (light.w > 0.0) irradiance += ${at(0)}.rgb * (${reach});`);
  }
  return `${samplers.join("\n")}

// Lambert diffuse from the scene's lights, the Splat's color its albedo.
vec3 splatShade(vec3 color) {
    // Models with receiveLight off keep their color.
    if ((vSurface.w & 1u) == 0u) return color;
    // Move along the view ray to the depth of the Gaussian's surface.
    vec3 point = vSurfaceView;
    float z = min(point.z + dot(uintBitsToFloat(vSurface.yz), vSplatUv), -1e-6);
    point = isOrthographic ? vec3(point.xy, z) : point * (z / point.z);
    vec3 normal = decodeSurfaceNormal(vSurface.x);
    bool shadowed = (vSurface.w & 2u) != 0u;
    vec3 irradiance = gslLight[0].rgb;
    vec4 light;
    ${lines.join("\n    ")}
    // Splats may blend in sRGB; light them in linear RGB either way.
    vec3 albedo = encodeLinear ? color : gslSrgbToLinear(color);
    vec3 lit = albedo * irradiance * 0.3183098861837907;
    return encodeLinear ? lit : gslLinearToSrgb(lit);
}`;
}

/**
 * The lit Splat material of WebGLRenderer: the unlit shaders with the surface
 * and lighting code of this folder inserted, regenerated when the scene's
 * lights change shape. Unlit draws keep the material they always had.
 */
export class WebGLLitMaterial {
  readonly material: THREE.ShaderMaterial;
  private block: LightBlock | null = null;
  private readonly fragment: string;

  constructor(
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    reversedDepth: boolean,
  ) {
    const shaders = getShaders();
    this.fragment = shaders.splatFragment;
    this.material = createWebGLSplatMaterial(
      {
        ...uniforms,
        // Light flags of each accumulator row; see LightFlags.ts.
        splatFlags: { value: emptyOrdering },
        projectionInverse: { value: new THREE.Matrix4() },
        gslLight: { value: [] },
        gslShadowView: { value: [] },
      },
      options,
      {
        splatVertex: insert(
          shaders.splatVertex,
          surfaceVertexPars,
          surfaceVertex,
        ),
        splatFragment: shaders.splatFragment,
      },
    );
    this.material.defines.GSL_REVERSED_DEPTH = Number(reversedDepth);
  }

  get key() {
    return this.block?.layout.key;
  }

  /** Lights `layout` from the next draw on, compiling a shader for it. */
  setLayout(layout: LightLayout) {
    if (layout.key === this.key) return;
    const { material } = this;
    const block = new LightBlock(layout, 1);
    this.block = block;
    material.fragmentShader = insert(
      this.fragment,
      lighting + shadeSource(layout),
      "rgba.rgb = splatShade(rgba.rgb);",
    );
    material.defines.GSL_LIGHT_VECTORS = layout.vectors;
    material.defines.GSL_SHADOWS = layout.shadows;
    material.uniforms.gslLight.value = block.vectors;
    material.uniforms.gslShadowView.value = block.matrices;
    for (const name in material.uniforms)
      if (name.startsWith("gslShadowMap")) delete material.uniforms[name];
    for (let index = 0; index < layout.shadows; index++)
      material.uniforms[`gslShadowMap${index}`] = { value: null };
    material.needsUpdate = true;
  }

  select(stochastic: boolean) {
    const { material } = this;
    if (material.defines.GSL_STOCHASTIC !== Number(stochastic)) {
      material.defines.GSL_STOCHASTIC = Number(stochastic);
      material.needsUpdate = true;
    }
    return material;
  }

  /** Loads the lights of a draw by `camera`; false if they cannot draw. */
  fill(lights: SceneLights, camera: THREE.Camera, flags: THREE.Texture) {
    const { block, material } = this;
    if (!block || !lights.fill(block, [camera])) return false;
    block.maps.forEach((map, index) => {
      material.uniforms[`gslShadowMap${index}`].value = map;
    });
    material.uniforms.splatFlags.value = flags;
    material.uniforms.projectionInverse.value.copy(
      camera.projectionMatrixInverse,
    );
    return true;
  }

  dispose() {
    this.material.dispose();
  }
}
