import * as THREE from "three";
import { NodeMaterial, QuadMesh } from "three/webgpu";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "../../data/defines.js";
import { createGenerateProgram } from "../tsl/GenerateProgram.js";
import { N, uniformBinding } from "../tsl/shaderUtils.js";
import { makeGenerateUniforms } from "../uniforms.js";
import { renderAccumulatorLayers } from "../webgl/AccumulatorGenerator.js";
/**
 * Rasterizes Splat records, and for stochastic targets stable sampling seeds,
 * into integer arrays.
 */
export class WebGLFallbackAccumulatorGenerator {
  constructor(stochasticSeeds) {
    this.uniforms = makeGenerateUniforms();
    this.material = new NodeMaterial();
    this.quad = new QuadMesh(this.material);
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
      if (stochasticSeeds) seed.assign(stochasticSeed);
      return accumulatorA;
    })();
    this.material.fragmentNode = stochasticSeeds
      ? N.outputStruct(first, second, seed)
      : N.outputStruct(first, second);
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.blending = THREE.NoBlending;
    this.material.toneMapped = false;
  }
  generate(options) {
    if (options.count <= 0) return;
    renderAccumulatorLayers(options, this.uniforms, () =>
      this.quad.render(options.renderer),
    );
  }
  dispose() {
    this.material.dispose();
  }
}
