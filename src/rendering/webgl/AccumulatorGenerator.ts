import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "../../data/defines";
import type { Uniforms as GenerateUniforms } from "../uniforms";
import { makeGenerateUniforms } from "../uniforms";
import { getShaders } from "./shaders";
import splatGenerate from "./shaders/splatGenerate.glsl";
import { IDENT_VERTEX_SHADER } from "./textureUtils";

let webGLMaterial: THREE.RawShaderMaterial | null = null;
const fullScreenQuad = new FullScreenQuad(
  new THREE.RawShaderMaterial({ visible: false }),
);

export function createWebGLAccumulatorTarget(
  width: number,
  height: number,
  depth: number,
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
  return target;
}

function getMaterial() {
  let material = webGLMaterial;
  if (!material) {
    getShaders();
    material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: IDENT_VERTEX_SHADER,
      fragmentShader: splatGenerate,
      uniforms: makeGenerateUniforms(),
      depthTest: false,
      depthWrite: false,
    });
    webGLMaterial = material;
  }
  return material;
}

export function getWebGLGenerateUniforms() {
  return getMaterial().uniforms;
}

export function generateWebGLAccumulator({
  renderer,
  target,
  base,
  count,
}: {
  renderer: THREE.WebGLRenderer;
  target: THREE.WebGLArrayRenderTarget;
  base: number;
  count: number;
}) {
  const material = getMaterial();
  const uniforms = material.uniforms as GenerateUniforms;
  fullScreenQuad.material = material;
  const renderState = saveRenderState(renderer);
  const nextBase =
    Math.ceil((base + count) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
  const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
  uniforms.targetBase.value = base;
  uniforms.targetCount.value = count;

  try {
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
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      fullScreenQuad.render(renderer);
      base += SPLAT_TEX_WIDTH * (yEnd - yStart);
    }
  } finally {
    resetRenderState(renderer, renderState);
  }
}

function saveRenderState(renderer: THREE.WebGLRenderer) {
  return {
    target: renderer.getRenderTarget(),
    activeCubeFace: renderer.getActiveCubeFace(),
    activeMipmapLevel: renderer.getActiveMipmapLevel(),
    xrEnabled: renderer.xr.enabled,
    autoClear: renderer.autoClear,
  };
}

function resetRenderState(
  renderer: THREE.WebGLRenderer,
  state: ReturnType<typeof saveRenderState>,
) {
  renderer.setRenderTarget(
    state.target,
    state.activeCubeFace,
    state.activeMipmapLevel,
  );
  renderer.xr.enabled = state.xrEnabled;
  renderer.autoClear = state.autoClear;
}
