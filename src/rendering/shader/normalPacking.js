import { N } from "../tsl/shaderUtils.js";

export const packNormal = N.Fn(([normal]) => {
  const n = normal
    .div(normal.x.abs().add(normal.y.abs()).add(normal.z.abs()))
    .toVar();
  const sign = N.vec2(
    N.select(n.x.greaterThanEqual(0), 1, -1),
    N.select(n.y.greaterThanEqual(0), 1, -1),
  );
  return N.packSnorm2x16(
    N.select(
      n.z.greaterThanEqual(0),
      n.xy,
      N.vec2(1).sub(n.yx.abs()).mul(sign),
    ),
  );
});

export const unpackNormal = N.Fn(([packed]) => {
  const xy = N.unpackSnorm2x16(packed);
  const n = N.vec3(xy, N.float(1).sub(xy.x.abs()).sub(xy.y.abs())).toVar();
  const t = n.z.negate().max(0);
  n.x.addAssign(N.select(n.x.greaterThanEqual(0), t.negate(), t));
  n.y.addAssign(N.select(n.y.greaterThanEqual(0), t.negate(), t));
  return n.normalize();
});
