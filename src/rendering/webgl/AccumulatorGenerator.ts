import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "../../data/defines";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
  setRendererRenderTarget,
} from "../rendererUtils";
import { type Uniforms, makeGenerateUniforms } from "../uniforms";
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

export function generateWebGLAccumulator(
  options: AccumulatorRenderOptions<THREE.WebGLRenderer>,
) {
  const material = getMaterial();
  fullScreenQuad.material = material;
  renderAccumulatorLayers(options, material.uniforms, () =>
    fullScreenQuad.render(options.renderer),
  );
}

export type AccumulatorRenderOptions<
  Renderer extends
    GaussianSplatCompatibleRenderer = GaussianSplatCompatibleRenderer,
> = {
  renderer: Renderer;
  target: THREE.WebGLArrayRenderTarget;
  base: number;
  count: number;
};

/** Draw row-aligned ranges into array layers with either WebGL renderer API. */
export function renderAccumulatorLayers(
  { renderer, target, base, count }: AccumulatorRenderOptions,
  uniforms: Uniforms,
  draw: () => void,
) {
  const nodeRenderer = isWebGPURenderer(renderer) ? renderer : null;
  const previous = {
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(),
    level: renderer.getActiveMipmapLevel(),
    xr: renderer.xr.enabled,
    autoClear: renderer.autoClear,
    scissorTest: renderer.getScissorTest(),
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
    nodeRenderer?.setScissorTest(true);
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
    setRendererRenderTarget(
      renderer,
      previous.target,
      previous.face,
      previous.level,
    );
    nodeRenderer?.setMRT(previous.mrt);
    renderer.xr.enabled = previous.xr;
    renderer.autoClear = previous.autoClear;
    nodeRenderer?.setScissorTest(previous.scissorTest);
  }
}
