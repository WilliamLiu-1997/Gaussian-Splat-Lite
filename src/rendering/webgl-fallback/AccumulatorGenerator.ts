import * as THREE from "three";
import * as TSL from "three/tsl";
import { NodeMaterial, QuadMesh, type WebGPURenderer } from "three/webgpu";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "../../data/defines";
import { createGenerateProgram } from "../tsl/GenerateProgram";
import { type TSLNode, uniformBinding } from "../tsl/shaderUtils";
import { makeGenerateUniforms } from "../uniforms";
import {
  type AccumulatorRenderOptions,
  createWebGLAccumulatorTarget,
  renderAccumulatorLayers,
} from "../webgl/AccumulatorGenerator";

const N = TSL as Record<string, TSLNode>;

export function createWebGLFallbackAccumulatorTarget(
  width: number,
  height: number,
  depth: number,
) {
  // The r186 fallback backend recognizes array attachments only at depth > 1.
  return createWebGLAccumulatorTarget(width, height, Math.max(2, depth));
}

/** Rasterizes Splat records and stable sampling seeds into integer arrays. */
export class WebGLFallbackAccumulatorGenerator {
  readonly uniforms = makeGenerateUniforms();
  private readonly material = new NodeMaterial();
  private readonly quad = new QuadMesh(this.material);

  constructor() {
    const targetBase = uniformBinding(this.uniforms, "targetBase", "uint");
    const targetLayer = uniformBinding(this.uniforms, "targetLayer", "uint");
    const generate = createGenerateProgram({ uniforms: this.uniforms });
    const second = N.property("uvec4", "gslAccumulatorB");
    const seed = N.property("uint", "gslAccumulatorSeed");
    const first = N.Fn(() => {
      // TSL texture loads and scissor rectangles use the same top-left origin.
      const pixel = N.uvec2(N.screenCoordinate.xy);
      const index = targetLayer
        .mul(SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT)
        .add(pixel.y.mul(SPLAT_TEX_WIDTH))
        .add(pixel.x)
        .sub(targetBase);
      const { accumulatorA, accumulatorB, stochasticSeed } = generate(index);
      second.assign(accumulatorB);
      seed.assign(stochasticSeed);
      return accumulatorA;
    })();
    this.material.fragmentNode = N.outputStruct(first, second, seed);
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.blending = THREE.NoBlending;
    this.material.toneMapped = false;
  }

  generate(options: AccumulatorRenderOptions<WebGPURenderer>) {
    if (options.count <= 0) return;
    renderAccumulatorLayers(options, this.uniforms, () =>
      this.quad.render(options.renderer),
    );
  }

  dispose() {
    this.material.dispose();
  }
}
