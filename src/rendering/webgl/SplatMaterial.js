import * as THREE from "three";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry.js";
import { registerStochasticSplatMaterial } from "../StochasticSplatMaterial.js";
import { getShaders } from "./shaders.js";
/** Sorted and stochastic variants keep separate programs. */
export function createWebGLSplatMaterial(uniforms, options, stochastic) {
  const shaders = getShaders();
  const material = new THREE.ShaderMaterial({
    ...options,
    defines: {
      SPLATS_PER_INSTANCE,
      GSL_STOCHASTIC: Number(stochastic),
    },
    glslVersion: THREE.GLSL3,
    vertexShader: shaders.splatVertex,
    fragmentShader: shaders.splatFragment,
    uniforms,
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
  const material = new THREE.RawShaderMaterial().copy(source);
  material.uniforms = source.uniforms;
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
