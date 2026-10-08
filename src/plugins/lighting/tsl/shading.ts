import type * as THREE from "three";
import { Vector2 } from "three";
import {
  LightingModel,
  type LightingModelDirectInput,
  type Node,
  type NodeBuilder,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  type TextureNode,
  type WebGPURenderer,
} from "three/webgpu";
import { SPLAT_TEX_WIDTH_BITS } from "../../../data/defines";
import { getViews } from "../../../rendering/rendererUtils";
import type { SplatShading } from "../../../rendering/tsl/SplatMaterial";
import { N, load2D } from "../../../rendering/tsl/shaderUtils";
import { materialCamera } from "../../../rendering/tsl/tslCompat";
import { viewIndex } from "../../../rendering/tsl/viewUniforms";
import { LIGHT_FLAGS_WIDTH_BITS } from "../LightFlags";
import { LightBlock, type LightSlot, type SceneLights } from "../SceneLights";
import { VarianceMap } from "./VarianceMap";
import { type SurfaceOutputs, surfaceProjection } from "./projection";
import {
  packSurface,
  unpackSurfaceGradient,
  unpackSurfaceNormal,
} from "./surface";

type ShadowSlot = NonNullable<LightSlot["shadow"]>;
type Records = (index: number) => Node<"vec4">;

/** A turn of the filter's taps per fragment, by interleaved gradient noise. */
function filterTurn() {
  return N.fract(
    N.float(52.9829189).mul(
      N.fract(N.dot(N.screenCoordinate.xy, N.vec2(0.06711056, 0.00583715))),
    ),
  ).mul(6.28318530718);
}

/** Five taps on a Vogel disk. */
function filterTap(index: number, turn: Node<"float">) {
  const theta = turn.add(index * 2.399963229728653);
  return N.vec2(N.cos(theta), N.sin(theta)).mul(Math.sqrt((index + 0.5) / 5));
}

/** A depth map's sample tested by its sampler: the share of it that is lit. */
function compare(sample: TextureNode, z: Node<"float">) {
  return sample.compare(z) as unknown as Node<"float">;
}

/** Runs `callback` before each draw of the material being built. */
function beforeDraw(
  builder: NodeBuilder,
  callback: (frame: NodeFrame) => void,
) {
  const hook = N.uniform(0);
  hook.updateBeforeType = NodeUpdateType.OBJECT;
  hook.updateBefore = (frame) => {
    callback(frame);
    return undefined;
  };
  // Registered now, it runs after the nodes that were built before it.
  hook.build(builder);
}

/**
 * Three.js's lighting of a lit Splat material adds nothing to its color.
 * Setting up each light's own shadowed color is what has WebGPURenderer draw
 * that light's shadow map ahead of the Splats, and rebuild this material's
 * shader as the lights change. Nothing reads the color, so its shadow lookup
 * stays out of the shader.
 */
class ShadowMapRequests extends LightingModel {
  direct({ lightColor }: LightingModelDirectInput, builder: NodeBuilder) {
    lightColor.build(builder);
  }
}

class LitSplatNodeMaterial extends NodeMaterial {
  constructor(
    private readonly shade: (builder: NodeBuilder) => Node<"vec3">,
    private readonly cacheKey: () => string,
  ) {
    super();
    this.lights = true;
  }

  customProgramCacheKey() {
    return super.customProgramCacheKey() + this.cacheKey();
  }

  setupLightingModel() {
    return new ShadowMapRequests();
  }

  setupLighting(builder: NodeBuilder) {
    const requests = super.setupLighting(builder);
    return N.Fn(() => {
      // Set up, not drawn: see ShadowMapRequests. The shadow maps exist from
      // here on, for the shading to bind.
      requests.build(builder);
      return this.shade(builder);
    })();
  }
}

export type LitShadingOptions = {
  lights: SceneLights;
  encodeLinear: Node<"bool">;
  /**
   * The light flags texture of accumulator draws. Native WebGPU caches each
   * Splat's whole record instead.
   */
  flags: TextureNode<"uvec4"> | null;
  renderer: WebGPURenderer;
  /** Changes when a built shader no longer fits the scene's lights. */
  cacheKey: () => string;
  /** A draw is about to use a shader that no longer fits them. */
  onStale: () => void;
};

/**
 * Lambert diffuse from the scene's lights, with a Splat's color as its
 * albedo: the TSL counterpart of webgl/lighting.glsl, which explains the
 * records. A shader is generated for the lights as they are when Three.js
 * builds it.
 */
export function createLitShading({
  lights,
  encodeLinear,
  flags,
  renderer,
  cacheKey,
  onStale,
}: LitShadingOptions): SplatShading<SurfaceOutputs> & { dispose(): void } {
  const reversed = renderer.reversedDepthBuffer;
  const logarithmic = renderer.logarithmicDepthBuffer;
  // Octahedral view normal, view depth gradient per unit of Splat UV, flags.
  const vSurface = N.varyingProperty("uvec4", "gslSurface");
  // View position of a fragment at the depth of the Splat's center.
  const vSurfaceView = N.varyingProperty("vec3", "gslSurfaceView");
  // One blurred map for each light that needs one, whichever shaders use it.
  const varianceMaps = new Map<THREE.LightShadow, VarianceMap>();

  /**
   * How much of a light reaches a point, from its shadow's record: bias,
   * bias along the normal in view units, filter radius in map widths,
   * intensity; then the shadow camera's near and far distances.
   */
  function shadowOf(
    slot: LightSlot,
    shadow: ShadowSlot,
    map: TextureNode,
    colorMap: TextureNode | null,
    at: Records,
    view: Node<"mat4">,
    point: Node<"vec3">,
    normal: Node<"vec3">,
  ) {
    const record = at(shadow.offset);
    const range = at(shadow.offset + 1);
    const near = range.x;
    const far = range.y;
    const lit = N.float(1).toVar();
    const colorOf = (coordinate: Node<"vec2"> | Node<"vec3">) => {
      if (!colorMap) return N.vec3(N.mix(1, lit, record.w));
      const color = colorMap.sample(coordinate).toVar();
      // Three's transmitted shadow mixes toward the caster's RGB only in
      // occluded pixels, weighted by its alpha and shadow intensity.
      return N.mix(
        N.vec3(1),
        N.mix(color.rgb, N.vec3(1), lit),
        record.w.mul(color.a),
      );
    };
    const position = view.mul(N.vec4(point.add(normal.mul(record.y)), 1));
    // A map's depth and its comparison follow the renderer's depth buffer.
    const test = (z: Node<"float">, depth: Node<"float">) =>
      reversed ? N.step(depth, z) : N.step(z, depth);
    const biased = (z: Node<"float">) =>
      reversed ? z.sub(record.x) : z.add(record.x);
    if (shadow.cube) {
      // A cube around the light with world axes: `view` leads to the offset
      // from the light, and depth runs along that offset's major axis.
      const offset = position.xyz.toVar();
      const size = offset.abs();
      const depth = size.x.max(size.y).max(size.z).toVar();
      N.If(depth.lessThanEqual(far).and(depth.greaterThanEqual(near)), () => {
        const span = depth.mul(far.sub(near));
        const z = biased(
          reversed
            ? near.mul(far.sub(depth)).div(span)
            : logarithmic
              ? N.viewZToLogarithmicDepth(depth.negate(), near, far)
              : far.mul(depth.sub(near)).div(span),
        ).toVar();
        const direction = offset.normalize().toVar();
        const tap = (toward: Node<"vec3">) => {
          const sample = map.sample(toward);
          return shadow.source === "compare"
            ? compare(sample, z)
            : test(z, sample.r);
        };
        if (shadow.filter === "hard") {
          lit.assign(tap(direction));
          return;
        }
        // Taps spread across the plane facing the light.
        const axes = direction.abs();
        const tangent = direction
          .cross(
            N.select(
              axes.x.greaterThan(axes.z),
              N.vec3(0, 1, 0),
              N.vec3(1, 0, 0),
            ),
          )
          .normalize()
          .toVar();
        const bitangent = direction.cross(tangent).toVar();
        const turn = filterTurn().toVar();
        let sum: Node<"float"> = N.float(0);
        for (let i = 0; i < 5; i++) {
          const spread = filterTap(i, turn).mul(record.z);
          sum = sum.add(
            tap(
              direction.add(tangent.mul(spread.x).add(bitangent.mul(spread.y))),
            ),
          );
        }
        lit.assign(sum.mul(0.2));
      });
      return colorOf(offset.normalize());
    }

    // A spot light's map holds logarithmic depth when the renderer draws it.
    const perspective = slot.kind === "spot";
    const coord = position.xyz.div(position.w);
    const depth =
      logarithmic && perspective
        ? N.viewZToLogarithmicDepth(position.w.negate(), near, far)
        : coord.z;
    // LightShadow.matrix leads to a square with Y up; a map's rows run down.
    const uv = N.vec2(coord.x, coord.y.oneMinus()).toVar();
    const z = biased(depth).toVar();
    const inside = uv.x
      .greaterThanEqual(0)
      .and(uv.x.lessThanEqual(1))
      .and(uv.y.greaterThanEqual(0))
      .and(uv.y.lessThanEqual(1))
      .and(z.lessThanEqual(1));
    N.If(inside, () => {
      if (shadow.filter === "variance") {
        // Mean and standard deviation of depth around the texel: see
        // VarianceMap.
        const moments = map.sample(uv).rg.toVar();
        lit.assign(test(z, moments.x));
        N.If(lit.notEqual(1), () => {
          // Chebyshev's bound on the share of those depths behind this
          // one, with its low end cut against light bleeding.
          const variance = moments.y.mul(moments.y).max(0.0000001);
          const delta = z.sub(moments.x);
          const bound = variance.div(variance.add(delta.mul(delta)));
          lit.assign(N.max(lit, bound.sub(0.3).div(0.65).clamp(0, 1)));
        });
        return;
      }
      const tap = (at: Node<"vec2">) => {
        const sample = map.sample(at);
        return shadow.source === "compare"
          ? compare(sample, z)
          : test(z, sample.r);
      };
      if (shadow.filter === "hard") {
        lit.assign(tap(uv));
        return;
      }
      // The sampler filters each tap over four texels.
      const turn = filterTurn().toVar();
      let sum: Node<"float"> = N.float(0);
      for (let i = 0; i < 5; i++)
        sum = sum.add(tap(uv.add(filterTap(i, turn).mul(record.z))));
      lit.assign(sum.mul(0.2));
    });
    return colorOf(uv);
  }

  /** The lit color of a fragment, for the lights as they are now. */
  function shade(builder: NodeBuilder, splatUv: Node<"vec2">) {
    const camera = materialCamera(builder);
    const views = getViews(camera);
    // One block per view: WebXR eyes are lit from where each one is.
    const multiview = views[0] !== camera;
    const layout = lights.layout();
    const block = new LightBlock(layout, views.length);
    lights.fill(block, views);
    // Three.js's own maps, or the blur of one; rebound as it remakes them.
    const maps: {
      node: TextureNode;
      color: TextureNode | null;
      variance: VarianceMap | null;
    }[] = [];
    for (const slot of layout.slots) {
      for (const shadow of slot.cascades?.shadows ??
        (slot.shadow ? [slot.shadow] : [])) {
        const map = block.maps[shadow.index] as THREE.Texture;
        const colorMap = block.colors[shadow.index] as THREE.Texture;
        const color = renderer.shadowMap.transmitted
          ? shadow.cube
            ? N.cubeTexture(colorMap as THREE.CubeTexture)
            : N.texture(colorMap)
          : null;
        if (shadow.filter !== "variance") {
          maps.push({
            node: shadow.cube
              ? N.cubeTexture(map as THREE.CubeTexture)
              : N.texture(map),
            variance: null,
            color,
          });
          continue;
        }
        const lightShadow = lights.shadowOf(layout, shadow.index);
        let variance = varianceMaps.get(lightShadow);
        if (!variance) {
          variance = new VarianceMap(lightShadow);
          varianceMaps.set(lightShadow, variance);
        }
        maps.push({ node: N.texture(variance.texture), color, variance });
      }
    }
    // A shader built for another camera may read a map this one does not.
    for (const [lightShadow, variance] of varianceMaps) {
      if (lights.blurs(lightShadow)) continue;
      variance.dispose();
      varianceMaps.delete(lightShadow);
    }
    // Three.js has drawn the shadow maps of this draw by the time it updates
    // these uniforms, whichever object asked for them first.
    const fill = (frame: NodeFrame) => {
      const drawn = getViews(frame.camera as THREE.Camera);
      if (drawn.length > block.views || !lights.fill(block, drawn)) {
        onStale();
        return;
      }
      for (const [index, { node, color, variance }] of maps.entries()) {
        if (!variance) node.value = block.maps[index] as THREE.Texture;
        if (color) color.value = block.colors[index] as THREE.Texture;
      }
    };
    const vectors = N.uniformArray<"vec4">(
      block.vectors,
      "vec4",
    ).onObjectUpdate(fill);
    const matrices = layout.shadows
      ? N.uniformArray<"mat4">(block.matrices, "mat4").onObjectUpdate(fill)
      : null;
    beforeDraw(builder, (frame) => {
      for (const { variance } of maps)
        variance?.render(frame.renderer as WebGPURenderer);
    });
    let eye: Node<"uint"> | null = null;
    const at: Records = (index) =>
      vectors.element(eye ? eye.mul(layout.vectors).add(index) : index);

    const result = N.diffuseColor.rgb.toVar();
    // Models with receiveLight off keep their color.
    N.If(vSurface.w.bitAnd(1).notEqual(0), () => {
      if (multiview) eye = viewIndex(camera).toVar();
      // Move along the view ray to the depth of the Gaussian's surface.
      const center = vSurfaceView;
      const z = center.z
        .add(unpackSurfaceGradient(vSurface).dot(splatUv))
        .min(-1e-6);
      const point = N.select(
        N.cameraProjectionMatrix.element(2).w.equal(0),
        N.vec3(center.xy, z),
        center.mul(z.div(center.z)),
      ).toVar();
      const normal = unpackSurfaceNormal(vSurface).toVar();
      // A variable, set here: each light reads it in a branch of its own,
      // and TSL would otherwise compute it inside the first of them only.
      const shadowed = vSurface.w.bitAnd(2).notEqual(0).toVar();
      const irradiance = at(0).rgb.toVar();
      const worldPerView = at(0).w;
      for (const slot of layout.slots) {
        const colorRange = at(slot.offset);
        const place = at(slot.offset + 1);
        if (slot.kind === "hemisphere") {
          irradiance.addAssign(
            N.mix(
              at(slot.offset + 2).rgb,
              colorRange.rgb,
              normal.dot(place.xyz).mul(0.5).add(0.5),
            ),
          );
          continue;
        }
        // How strongly the light reaches a surface facing `normal`: zero
        // from behind it, out of range or outside a cone.
        let strength: Node<"float">;
        if (slot.kind === "directional") {
          strength = normal.dot(place.xyz);
        } else {
          const offset = place.xyz.sub(point).toVar();
          const viewDistance = offset.length().toVar();
          const direction = offset.div(viewDistance).toVar();
          // Lights fall off over world lengths, as in Three.js.
          const range = viewDistance.mul(worldPerView).toVar();
          const falloff = N.float(1).div(range.pow(place.w).max(0.01)).toVar();
          N.If(colorRange.w.greaterThan(0), () => {
            const ratio = range.div(colorRange.w).toVar();
            const window = N.float(1)
              .sub(ratio.mul(ratio).mul(ratio).mul(ratio))
              .clamp(0, 1)
              .toVar();
            falloff.mulAssign(window.mul(window));
          });
          strength = normal.dot(direction).max(0).mul(falloff);
          if (slot.kind === "spot") {
            const axisCone = at(slot.offset + 2);
            strength = strength.mul(
              N.smoothstep(
                axisCone.w,
                at(slot.offset + 3).x,
                direction.dot(axisCone.xyz),
              ),
            );
          }
        }
        const reach = strength.toVar();
        // Lights that do not reach the surface skip their shadow lookups.
        N.If(reach.greaterThan(0), () => {
          const lightColor =
            slot.cascades || (slot.shadow && maps[slot.shadow.index].color)
              ? colorRange.rgb.toVar()
              : colorRange.rgb;
          if (matrices) {
            const shadowAt = (shadow: ShadowSlot) =>
              shadowOf(
                slot,
                shadow,
                maps[shadow.index].node,
                maps[shadow.index].color,
                at,
                matrices.element(
                  eye
                    ? eye.mul(layout.shadows).add(shadow.index)
                    : shadow.index,
                ),
                point,
                normal,
              );
            if (slot.cascades) {
              const { node, shadows } = slot.cascades;
              const ranges = Array.from(
                { length: shadows.length },
                () => new Vector2(),
              );
              const breaks = N.uniformArray<"vec2">(
                ranges,
                "vec2",
              ).onObjectUpdate(() => {
                for (let i = 0; i < ranges.length; i++)
                  ranges[i].set(i ? node.breaks[i - 1] : 0, node.breaks[i]);
              });
              const near = N.uniform(0).onObjectUpdate(
                () => (node.camera as THREE.PerspectiveCamera).near,
              );
              const far = N.uniform(0).onObjectUpdate(() =>
                Math.min(
                  node.maxFar,
                  (node.camera as THREE.PerspectiveCamera).far,
                ),
              );
              N.If(shadowed, () => {
                const depth = N.viewZToOrthographicDepth(
                  // CSM splits use Three's view space, which drops a camera
                  // rig's scale; the Splat projection retains that scale.
                  point.z.mul(worldPerView),
                  near,
                  far,
                ).toVar();
                const attenuation = N.vec3(1).toVar();
                for (const [index, shadow] of shadows.entries()) {
                  const range = breaks.element(index).toVar();
                  if (!node.fade) {
                    N.If(
                      depth
                        .greaterThanEqual(range.x)
                        .and(depth.lessThanEqual(range.y)),
                      () => {
                        attenuation.assign(shadowAt(shadow));
                      },
                    );
                    continue;
                  }
                  const center = range.x.add(range.y).mul(0.5).toVar();
                  const edge = N.select(
                    depth.lessThan(center),
                    range.x,
                    range.y,
                  );
                  const margin = edge.mul(edge).mul(0.25).toVar();
                  const start = range.x.sub(margin.mul(0.5)).toVar();
                  const end =
                    index === shadows.length - 1
                      ? range.y
                      : range.y.add(margin.mul(0.5));
                  N.If(
                    depth.greaterThanEqual(start).and(depth.lessThanEqual(end)),
                    () => {
                      const distance = N.min(depth.sub(start), end.sub(depth));
                      const fade = distance.div(margin).clamp(0, 1);
                      const weight =
                        index === 0
                          ? N.select(depth.greaterThan(center), fade, 1)
                          : fade;
                      attenuation.subAssign(
                        shadowAt(shadow).oneMinus().mul(weight),
                      );
                    },
                  );
                }
                lightColor.mulAssign(attenuation);
              });
            } else if (slot.shadow) {
              const shadow = slot.shadow;
              N.If(shadowed, () => {
                if (maps[shadow.index].color)
                  lightColor.mulAssign(shadowAt(shadow));
                else reach.mulAssign(shadowAt(shadow).x);
              });
            }
          }
          irradiance.addAssign(lightColor.mul(reach));
        });
      }
      // Splats may blend in sRGB; light them in linear RGB either way.
      N.If(encodeLinear.not(), () => {
        result.assign(N.sRGBTransferEOTF(result));
      });
      result.assign(result.mul(irradiance).mul(0.3183098861837907));
      N.If(encodeLinear.not(), () => {
        result.assign(N.sRGBTransferOETF(result));
      });
    });
    return result;
  }

  return {
    projection: surfaceProjection(),
    record(surface, splatIndex) {
      if (!flags) throw new Error("Accumulator lighting needs light flags");
      return packSurface(
        surface.normal,
        surface.gradient,
        // One texel per accumulator row; see LightFlagsTexture.
        load2D(
          flags,
          N.ivec2(
            splatIndex
              .shiftRight(SPLAT_TEX_WIDTH_BITS)
              .bitAnd((1 << LIGHT_FLAGS_WIDTH_BITS) - 1),
            splatIndex.shiftRight(
              SPLAT_TEX_WIDTH_BITS + LIGHT_FLAGS_WIDTH_BITS,
            ),
          ),
        ).r,
      );
    },
    setVertex(data) {
      if (!data?.record) {
        vSurface.assign(N.uvec4(0));
        vSurfaceView.assign(N.vec3(0));
        return;
      }
      vSurface.assign(data.record);
      const view = (N.cameraProjectionMatrixInverse as Node<"mat4">).mul(
        data.clipPosition,
      );
      vSurfaceView.assign(view.xyz.div(view.w));
    },
    createMaterial: (splatUv) =>
      new LitSplatNodeMaterial((builder) => shade(builder, splatUv), cacheKey),
    dispose() {
      for (const variance of varianceMaps.values()) variance.dispose();
      varianceMaps.clear();
    },
  };
}
