import { createGenerateProgram } from "../tsl/GenerateProgram.js";
import { createProjectionProgram } from "../tsl/ProjectionProgram.js";
import { N, uniformBinding } from "../tsl/shaderUtils.js";
import { INVALID_SORT_KEY, RADIX_SORT_MODE_IDS } from "./RadixSort.js";

const WORKGROUP_SIZE = 256;

/** Builds a projection graph from bindings owned by ProjectedSplats. */
export function createProjectionKernel({
  uniforms,
  eyeCount,
  keys,
  seeds,
  sortValues,
  counter,
  cache,
}) {
  const u = (name, type) => uniformBinding(uniforms, name, type);
  const generate = createGenerateProgram({ uniforms });
  const focalAdjustment = u("focalAdjustment", "float");
  // Eye 0 reads the unsuffixed uniforms; later eyes append their index.
  const eyes = Array.from({ length: eyeCount }, (_, eye) =>
    eye ? `${eye}` : "",
  ).map((suffix) => {
    const renderSize = u(`renderSize${suffix}`, "vec2");
    return {
      project: createProjectionProgram(uniforms, {
        projectionMatrix: u(`projectionMatrix${suffix}`, "mat4"),
        renderToViewQuat: u(`renderToViewQuat${suffix}`, "vec4"),
        renderToViewPos: u(`renderToViewPos${suffix}`, "vec3"),
        renderToViewScale: u(`renderToViewScale${suffix}`, "float"),
        near: u(`near${suffix}`, "float"),
        far: u(`far${suffix}`, "float"),
        renderSize,
      }),
      pixelScale: renderSize.mul(focalAdjustment).mul(0.5),
    };
  });
  const viewStride = u("viewStride", "uint");
  const direction = u("sortDirection", "vec3");
  const sortOffset = u("sortOffset", "vec3");
  const radial = u("sortRadial", "bool");
  const sortMode = u("sortMode", "uint");
  const front = sortMode.equal(N.uint(RADIX_SORT_MODE_IDS.front));
  const stochastic = u("stochastic", "bool");
  const centerRange = u("clipXY", "float").abs().max(1).mul(1.000001);
  return N.Fn(() => {
    const index = N.uint(N.instanceIndex);
    // Sorted draws key each Splat at its mapping index, not its atomic slot.
    // The first radix pass compacts keys in mapping order, so equal keys
    // keep source order every frame.
    const sorted = stochastic.not().or(u("stochasticOrdering", "bool")).toVar();
    const mappingIndex = u("targetBase", "uint").add(index).toVar();
    // Decode, edit and evaluate color once, then project for each eye.
    const generated = generate.prepare(index);
    const projected = eyes.map(({ project }) => {
      const projection = project(generated, false);
      const extent = projection.axis1.abs().add(projection.axis2.abs());
      const ndc = projection.clipCenter.xy.div(projection.clipCenter.w);
      // Reject only quads wholly outside the viewport; clipXY and every
      // existing visual cutoff remain part of the shared projection math.
      const onscreen = N.all(ndc.abs().lessThanEqual(extent.add(1)));
      return { projection, ndc, visible: projection.valid.and(onscreen) };
    });
    // Shared culling keeps Splats any eye draws.
    const visible = projected
      .slice(1)
      .reduce((any, eye) => any.or(eye.visible), projected[0].visible);
    N.If(visible, () => {
      const rgb = generated.resolveRgb().toVar();
      // Compact survivors and their stable seeds into the same slots.
      const slot = N.atomicAdd(counter.element(0), N.uint(1)).toVar();
      projected.forEach(({ projection, ndc, visible: eyeVisible }, eye) => {
        const cacheIndex = viewStride.mul(eye).add(slot);
        const write = () => {
          projection.rgba.rgb.assign(rgb);
          cache.write(
            cacheIndex,
            projection,
            ndc,
            eyes[eye].pixelScale,
            centerRange,
          );
        };
        if (eyeCount > 1) {
          N.If(eyeVisible, write).Else(() => {
            cache.writeHidden(cacheIndex);
          });
        } else {
          write();
        }
      });
      N.If(stochastic, () => {
        seeds.element(slot).assign(generated.stochasticSeed);
      });
      // Sorted blending orders back to front by depth or distance;
      // stochastic ordering uses front-to-back depth.
      N.If(sorted, () => {
        const center = generated.center.add(sortOffset);
        const metric = N.select(
          radial.and(front.not()),
          center.dot(center),
          center.dot(direction),
        );
        const bits = N.floatBitsToUint(metric);
        // Non-finite metrics draw last; INVALID_SORT_KEY marks absence.
        const key = N.uint(INVALID_SORT_KEY - 1).toVar();
        N.If(
          bits.bitAnd(N.uint(0x7fffffff)).lessThan(N.uint(0x7f800000)),
          () => {
            // Signed float bits in ascending order, preserved across
            // negative view depths; inverted for back-to-front keys.
            const ascending = N.select(
              bits.bitAnd(N.uint(0x80000000)).notEqual(0),
              bits.bitXor(N.uint(0xffffffff)),
              bits.bitXor(N.uint(0x80000000)),
            );
            key.assign(
              ascending.bitXor(N.select(front, N.uint(0), N.uint(0xffffffff))),
            );
          },
        );
        // Discard low mantissa bits before storing the key: front keys keep
        // 16 bits and fast keys 24. Projection/depth cache precision is
        // independent of this sorting approximation.
        const shift = N.select(
          front,
          N.uint(16),
          N.select(
            sortMode.equal(N.uint(RADIX_SORT_MODE_IDS.fast)),
            N.uint(8),
            N.uint(0),
          ),
        );
        keys.element(mappingIndex).assign(key.shiftRight(shift));
        sortValues.element(mappingIndex).assign(slot);
      });
    }).Else(() => {
      N.If(sorted, () => {
        keys.element(mappingIndex).assign(N.uint(INVALID_SORT_KEY));
      });
    });
  })()
    .compute(1, [WORKGROUP_SIZE])
    .setName(
      eyeCount > 1
        ? `Splat generate project compact ${eyeCount} eyes`
        : "Splat generate project compact",
    );
}
