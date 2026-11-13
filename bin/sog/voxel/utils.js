function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const frac = value - floor;
  const eps = 1e-12;
  if (frac > 0.5 + eps) {
    return floor + 1;
  }
  if (frac < 0.5 - eps) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

export { roundHalfToEven };
