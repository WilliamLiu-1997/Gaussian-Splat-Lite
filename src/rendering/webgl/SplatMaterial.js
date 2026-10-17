import * as THREE from "three";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry.js";
import { registerStochasticSplatMaterial } from "../StochasticSplatMaterial.js";
import { effectGLSL } from "../shader/glsl.js";
import { getShaders } from "./shaders.js";
/** Sorted and stochastic variants keep separate programs. */
export function createWebGLSplatMaterial(
  uniforms,
  options,
  stochastic,
  effect = null,
) {
  const shaders = getShaders();
  const hooks = effectGLSL(effect);
  const effectUniforms = Object.fromEntries(
    Object.entries(effect?.uniforms ?? {}).map(([name, uniform]) => [
      `effect_${name}`,
      uniform,
    ]),
  );
  const material = new THREE.ShaderMaterial({
    ...options,
    defines: {
      SPLATS_PER_INSTANCE,
      GSL_STOCHASTIC: Number(stochastic),
      GSL_EFFECT: Number(!!effect),
    },
    glslVersion: THREE.GLSL3,
    vertexShader: shaders.splatVertex
      .replace("#pragma GSL_EFFECT_VERTEX_PARS", hooks.vertexPars)
      .replace("#pragma GSL_EFFECT_VERTEX", hooks.vertex),
    fragmentShader: shaders.splatFragment
      .replace("#pragma GSL_EFFECT_FRAGMENT_PARS", hooks.fragmentPars)
      .replace("#pragma GSL_EFFECT_OPACITY", hooks.opacity)
      .replace("#pragma GSL_EFFECT_FRAGMENT", hooks.fragment),
    uniforms: { ...uniforms, ...effectUniforms },
    side: THREE.FrontSide,
    allowOverride: false,
  });
  if (stochastic) {
    registerStochasticSplatMaterial(material, (renderer) =>
      createCoverageVariant(material, renderer),
    );
  }
  return material;
}

/** Shares the existing Splat shader and uniforms, adding four-sample coverage. */
function createCoverageVariant(source, renderer) {
  // RawShaderMaterial lets the extension precede precision declarations.
  // Three still supplies projectionMatrix and logDepthBufFC as usual.
  // Effect uniforms can contain render-target textures. Share their bindings
  // instead of asking ShaderMaterial.copy() to clone textures it cannot own.
  const material = new THREE.RawShaderMaterial().copy({
    ...source,
    uniforms: {},
    uniformsGroups: [],
  });
  material.uniforms = source.uniforms;
  material.uniformsGroups = source.uniformsGroups;
  material.defines = {
    ...source.defines,
    GSL_COVERAGE_SAMPLES: 4,
    USE_LOGARITHMIC_DEPTH_BUFFER: renderer.capabilities.logarithmicDepthBuffer,
    USE_REVERSED_DEPTH_BUFFER: renderer.capabilities.reversedDepthBuffer,
  };
  material.vertexShader = `#define varying out\nprecision highp float;\nprecision highp usampler2D;\nuniform mat4 projectionMatrix;\nuniform bool isOrthographic;\nin vec3 position;\n${source.vertexShader}`;
  material.fragmentShader = `#extension GL_OES_sample_variables : require\n#define varying in\n${source.fragmentShader}`;
  return material;
}
