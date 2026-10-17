import { isWebGPURenderer } from "../rendererUtils.js";
import { N } from "../tsl/shaderUtils.js";

/** One renderer's effect instance. Draw hooks never change projection or order. */
export class EffectBinding {
  constructor(effect, renderer) {
    this.definition = effect.create(renderer);
    const node = isWebGPURenderer(renderer);
    const implementation = node ? "tsl" : "glsl";
    if (!this.definition[implementation]) {
      this.definition.dispose?.();
      throw new Error(
        `SplatShaderEffect requires a ${implementation} implementation for this renderer`,
      );
    }
    this.normals = this.definition.normals === true;
    this.uniforms = this.definition.uniforms ?? {};
    this.nodes = {};
    if (node) {
      for (const [name, uniform] of Object.entries(this.uniforms)) {
        const get = () => uniform.value;
        const binding =
          uniform.type === "sampler2D"
            ? N.texture(uniform.value)
            : uniform.type === "samplerCube"
              ? N.cubeTexture(uniform.value)
              : N.uniform(uniform.value, uniform.type);
        binding.onObjectUpdate(get);
        binding.mergeable = false;
        this.nodes[name] = binding;
      }
    }
  }

  beforeRender(frame) {
    this.definition.onBeforeRender?.(frame);
  }

  dispose() {
    this.definition.dispose?.();
  }
}
