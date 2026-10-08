import type { Node } from "three/webgpu";
import { N } from "../../../rendering/tsl/shaderUtils";

/**
 * Lighting data of a Splat in one view, as a flat varying or cache record:
 * its octahedral view normal, the view depth gradient per unit of Splat UV,
 * and its model's light flags (see ../LightFlags.ts).
 */
export const packSurface = N.Fn(
  ([normal, gradient, flags]: [Node<"vec3">, Node<"vec2">, Node<"uint">]) => {
    const n = normal
      .div(normal.x.abs().add(normal.y.abs()).add(normal.z.abs()))
      .toVar();
    const folded = N.vec2(1)
      .sub(n.yx.abs())
      .mul(
        N.vec2(
          N.select(n.x.greaterThanEqual(0), 1, -1),
          N.select(n.y.greaterThanEqual(0), 1, -1),
        ),
      );
    const bits = N.floatBitsToUint(gradient);
    return N.uvec4(
      N.packSnorm2x16(N.select(n.z.greaterThanEqual(0), n.xy, folded)),
      bits.x,
      bits.y,
      flags,
    );
  },
);

export const unpackSurfaceNormal = N.Fn(([surface]: [Node<"uvec4">]) => {
  const folded = N.unpackSnorm2x16(surface.x);
  const normal = N.vec3(
    folded,
    N.float(1).sub(folded.x.abs()).sub(folded.y.abs()),
  ).toVar();
  const t = normal.z.negate().max(0);
  normal.x.addAssign(N.select(normal.x.greaterThanEqual(0), t.negate(), t));
  normal.y.addAssign(N.select(normal.y.greaterThanEqual(0), t.negate(), t));
  return normal.normalize();
});

export function unpackSurfaceGradient(surface: Node<"uvec4">) {
  return N.uintBitsToFloat(surface.yz);
}
