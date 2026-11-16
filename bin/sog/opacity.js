export const MAX_MASS = 1.5625;
const EULER_GAMMA = 0.5772156649015329;
const LOG_ONE_MINUS_ALPHA = Math.log1p(-0.5 / 255);
// The renderer limits kernelShape to 5.
const MAX_POWER = Math.exp(24 / Math.E);
const MAX_KERNEL_MASS = kernelMass(MAX_POWER)[0];
const CAPPED_RADIUS_SQUARED = contourRadiusSquared(massToPower(MAX_MASS));

// Log-scale offset for mass above the SOG limit.
export function opacityLogScale(mass) {
  const radiusSquared = contourRadiusSquared(massToPower(mass));
  return 0.5 * Math.log(radiusSquared / CAPPED_RADIUS_SQUARED);
}

// Squared equal-alpha radius of the wide kernel, before edge fade and blur.
function contourRadiusSquared(power) {
  return -2 * Math.log(-Math.expm1(LOG_ONE_MINUS_ALPHA / power));
}

// Match rust/gaussian-splat-lib/src/opacity.rs before comparing kernel sizes.
function massToPower(mass) {
  if (mass >= MAX_KERNEL_MASS) return MAX_POWER;
  let power = Math.exp(mass - EULER_GAMMA) - 0.5;
  for (let i = 0; i < 3; i++) {
    const [value, slope] = kernelMass(power);
    power -= (value - mass) / slope;
  }
  return power;
}

function kernelMass(power) {
  // Full radial mass / (2π) is ψ(power + 1) + γ.
  let x = power + 1;
  let mass = EULER_GAMMA;
  let slope = 0;
  while (x < 8) {
    mass -= 1 / x;
    slope += 1 / (x * x);
    x++;
  }
  const inv = 1 / x;
  const inv2 = inv * inv;
  mass +=
    Math.log(x) -
    0.5 * inv -
    inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 * (1 / 252 - inv2 / 240)));
  slope +=
    inv +
    0.5 * inv2 +
    inv * inv2 * (1 / 6 - inv2 * (1 / 30 - inv2 * (1 / 42 - inv2 / 30)));
  return [mass, slope];
}
