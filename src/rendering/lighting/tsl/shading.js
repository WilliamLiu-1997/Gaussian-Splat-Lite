import {
  N,
  load2D,
  uintTexture,
  uniformBinding,
} from "../../tsl/shaderUtils.js";
import { viewIndex } from "../../tsl/viewUniforms.js";
import { LIGHT_TEXTURE_WIDTH } from "../LightData.js";
import { LIGHT_HEADER, LIGHT_STRIDE } from "../SceneLights.js";
import { surfaceProjection } from "./surface.js";

/**
 * Vertex-stage Lambert shading at each Splat's center, using its color as
 * albedo. The shader walks SceneLights' records, so
 * storage sizes stay outside the shader. Keep in step with webgl/shading.glsl.
 */
export function createNodeLitShading(data, uniforms) {
  const encodeLinear = uniformBinding(uniforms, "encodeLinear", "bool");
  const texture = data.texture ? uintTexture(data.texture) : null;
  if (texture) texture.mergeable = false;
  function shade(camera, surface, rgb) {
    return N.Fn(() => {
      // Each eye reads its own block of records.
      const block = viewIndex(camera).mul(data.stride).toVar();
      const record = (index) => {
        const at = block.add(index);
        if (data.buffer) return data.buffer.element(at);
        return load2D(
          texture,
          N.ivec2(
            at.mod(LIGHT_TEXTURE_WIDTH),
            at.div(N.uint(LIGHT_TEXTURE_WIDTH)),
          ),
        );
      };
      // Read before the loops so spot-only fallback draws have a valid scale.
      const header = record(0).toVar();
      const irradiance = header.rgb.toVar();
      const worldPerView = header.w;
      const counts = N.uvec4(record(1)).toVar();
      // Read the surface only for the lights that use it.
      const normal = N.vec3(0).toVar();
      N.If(N.any(counts.notEqual(N.uvec4(0))), () => {
        normal.assign(surface.normal);
      });
      const center = N.vec3(0).toVar();
      N.If(counts.z.add(counts.w).greaterThan(0), () => {
        center.assign(surface.viewCenter);
      });
      // Lights follow one another by kind. `light(n)` is the nth vector of
      // the one at the cursor.
      const cursor = N.uint(LIGHT_HEADER).toVar();
      const light = (vector) => record(vector ? cursor.add(vector) : cursor);
      const forEachLight = (count, shadeLight) =>
        N.Loop(
          { start: N.uint(0), end: count, type: "uint", condition: "<" },
          () => {
            shadeLight();
            cursor.addAssign(LIGHT_STRIDE);
          },
        );
      // Direction to a point or spot light, and its diffuse term with falloff.
      const punctual = (colorCutoff, positionDecay) => {
        const offset = positionDecay.xyz.sub(center).toVar();
        const viewDistance = offset.length().toVar();
        const direction = offset.div(viewDistance.max(1e-6)).toVar();
        // Decay and cutoff are in world units, whatever the camera rig's scale.
        const range = viewDistance.mul(worldPerView).toVar();
        const falloff = N.float(1)
          .div(range.pow(positionDecay.w).max(0.01))
          .toVar();
        const cutoff = colorCutoff.w;
        N.If(cutoff.greaterThan(0), () => {
          const ratio = range.div(cutoff).toVar();
          const window = N.float(1)
            .sub(ratio.mul(ratio).mul(ratio).mul(ratio))
            .clamp(0, 1)
            .toVar();
          falloff.mulAssign(window.mul(window));
        });
        const diffuse = normal.dot(direction).max(0).mul(falloff).toVar();
        return { direction, diffuse };
      };
      // Hemisphere
      forEachLight(counts.x, () => {
        const sky = normal.dot(light(1).xyz).mul(0.5).add(0.5);
        irradiance.addAssign(N.mix(light(2).rgb, light(0).rgb, sky));
      });
      // Directional
      forEachLight(counts.y, () => {
        irradiance.addAssign(light(0).rgb.mul(normal.dot(light(1).xyz).max(0)));
      });
      // Point
      forEachLight(counts.z, () => {
        const colorCutoff = light(0).toVar();
        const positionDecay = light(1).toVar();
        const { diffuse } = punctual(colorCutoff, positionDecay);
        irradiance.addAssign(colorCutoff.rgb.mul(diffuse));
      });
      // Spot
      forEachLight(counts.w, () => {
        const colorCutoff = light(0).toVar();
        const positionDecay = light(1).toVar();
        const axisCone = light(2).toVar();
        const innerCos = light(3).x.toVar();
        const { direction, diffuse } = punctual(colorCutoff, positionDecay);
        const angleCos = direction.dot(axisCone.xyz).toVar();
        const cone = N.float(0).toVar();
        // Zero penumbra is a hard cone; smoothstep requires distinct edges.
        N.If(innerCos.greaterThan(axisCone.w), () => {
          cone.assign(N.smoothstep(axisCone.w, innerCos, angleCos));
        }).Else(() => {
          cone.assign(N.step(axisCone.w, angleCos));
        });
        irradiance.addAssign(colorCutoff.rgb.mul(diffuse.mul(cone)));
      });
      // Light in linear RGB even when source colors blend in sRGB.
      const color = rgb.toVar();
      N.If(encodeLinear.not(), () => {
        color.assign(N.sRGBTransferEOTF(color));
      });
      color.assign(color.mul(irradiance).mul(1 / Math.PI));
      N.If(encodeLinear.not(), () => {
        color.assign(N.sRGBTransferOETF(color));
      });
      return color;
    })();
  }
  return { projection: surfaceProjection, shade };
}
