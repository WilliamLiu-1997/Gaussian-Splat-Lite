import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "../../data/defines.js";
import { glslModifier } from "../SplatModifier.js";
import { isWebGPURenderer } from "../rendererUtils.js";
import { makeGenerateUniforms } from "../uniforms.js";
import { getShaders } from "./shaders.js";
import splatGenerate from "./shaders/splatGenerate.glsl";
import { IDENT_VERTEX_SHADER } from "./textureUtils.js";
// Default generate programs, keyed by their output attachments.
const webGLMaterials = [];
let webGLUniforms = null;
const fullScreenQuad = new FullScreenQuad(
  new THREE.RawShaderMaterial({ visible: false }),
);
/** Sorted rendering needs no seed layer; stochastic draws read one per Splat. */
export function createWebGLAccumulatorTarget(
  width,
  height,
  depth,
  stochasticSeeds,
  modifierData = false,
) {
  const target = new THREE.WebGLArrayRenderTarget(width, height, depth, {
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
    format: THREE.RGBAIntegerFormat,
    type: THREE.UnsignedIntType,
  });
  target.scissorTest = true;
  const second = target.texture.clone();
  target.textures = [target.texture, second];
  target.stochasticSeeds = stochasticSeeds;
  target.modifierData = modifierData;
  if (stochasticSeeds || modifierData) {
    const seeds = target.texture.clone();
    seeds.format = modifierData
      ? THREE.RGBAIntegerFormat
      : THREE.RedIntegerFormat;
    seeds.name = "SplatAccumulator.stochasticSeeds";
    target.textures.push(seeds);
  }
  return target;
}
/** Whether an accumulator target stores stochastic sampling seeds. */
export function hasStochasticSeeds(target) {
  return target.stochasticSeeds;
}
function getMaterial(target, modifier) {
  const index =
    Number(target.stochasticSeeds) + 2 * Number(target.modifierData);
  const create = () => {
    getShaders();
    const uniforms = { ...getWebGLGenerateUniforms() };
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: IDENT_VERTEX_SHADER,
      fragmentShader: glslModifier(splatGenerate, modifier, "Work", uniforms),
      // Built-in values are shared; modifier parameters belong to their binding.
      uniforms,
      defines: {
        GSL_STOCHASTIC_SEEDS: Number(target.stochasticSeeds),
        GSL_MODIFIER_DATA: Number(target.modifierData),
      },
      depthTest: false,
      depthWrite: false,
    });
  };
  if (modifier) return modifier.resource(`classic-${index}`, create);
  webGLMaterials[index] ??= create();
  return webGLMaterials[index];
}
export function getWebGLGenerateUniforms() {
  webGLUniforms ??= makeGenerateUniforms();
  return webGLUniforms;
}
export function generateWebGLAccumulator(options) {
  const material = getMaterial(options.target, options.modifier);
  fullScreenQuad.material = material;
  renderAccumulatorLayers(options, material.uniforms, () =>
    fullScreenQuad.render(options.renderer),
  );
}
/** Draw row-aligned ranges into array layers with either WebGL renderer API. */
export function renderAccumulatorLayers(
  { renderer, target, base, count },
  uniforms,
  draw,
) {
  const nodeRenderer = isWebGPURenderer(renderer) ? renderer : null;
  const previous = {
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(),
    level: renderer.getActiveMipmapLevel(),
    xr: renderer.xr.enabled,
    autoClear: renderer.autoClear,
    mrt: nodeRenderer?.getMRT() ?? null,
  };
  uniforms.targetBase.value = base;
  uniforms.targetCount.value = count;
  const nextBase =
    Math.ceil((base + count) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
  const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
  try {
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    nodeRenderer?.setMRT(null);
    while (base < nextBase) {
      const layer = Math.floor(base / layerSize);
      uniforms.targetLayer.value = layer;
      const layerBase = layer * layerSize;
      const yStart = Math.floor((base - layerBase) / SPLAT_TEX_WIDTH);
      const yEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((nextBase - layerBase) / SPLAT_TEX_WIDTH),
      );
      target.scissor.set(0, yStart, SPLAT_TEX_WIDTH, yEnd - yStart);
      renderer.setRenderTarget(target, layer);
      draw();
      base += SPLAT_TEX_WIDTH * (yEnd - yStart);
    }
  } finally {
    renderer.setRenderTarget(previous.target, previous.face, previous.level);
    nodeRenderer?.setMRT(previous.mrt);
    renderer.xr.enabled = previous.xr;
    renderer.autoClear = previous.autoClear;
  }
}
