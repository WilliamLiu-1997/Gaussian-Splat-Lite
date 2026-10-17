import { getViews, isWebGPURenderer } from "../../rendering/rendererUtils.js";
import { SplatShaderEffect } from "../../rendering/shader/SplatShaderEffect.js";
import { LIGHT_TEXTURE_WIDTH, LightData } from "./LightData.js";
import { SceneLights } from "./SceneLights.js";
import glsl from "./shading.glsl";
import { createRelightShader } from "./shading.js";

/** Optional diffuse scene lighting, implemented entirely through shader hooks. */
export class SplatRelight extends SplatShaderEffect {
  constructor() {
    super(({ renderer }) => {
      const lights = new SceneLights();
      const data = new LightData(lights, renderer);
      return {
        normals: true,
        uniforms: data.texture
          ? { lights: { type: "sampler2D", value: data.texture } }
          : {},
        tsl: { shadeSplat: createRelightShader(data) },
        glsl: {
          declarations: `#define GSL_LIGHT_TEXTURE_WIDTH ${LIGHT_TEXTURE_WIDTH}\n${glsl}`,
          shadeSplat:
            "return relight(splat.color, splat.viewCenter, splat.viewNormal);",
        },
        onBeforeRender({ scene, camera, splatRenderer }) {
          let root = splatRenderer;
          while (root !== scene && root.parent) root = root.parent;
          lights.collect(root);
          lights.select(camera);
          data.update(isWebGPURenderer(renderer) ? getViews(camera) : [camera]);
        },
        dispose: () => data.dispose(),
      };
    });
  }
}
