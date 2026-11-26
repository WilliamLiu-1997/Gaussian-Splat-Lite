export function getModelRotationX(orientation, defaultUpAxis) {
  const upAxis = orientation === "auto" ? defaultUpAxis : orientation;

  switch (upAxis) {
    case "y-up":
      return 0;
    case "y-down":
      return Math.PI;
    case "z-up":
      return -Math.PI / 2;
    case "z-down":
      return Math.PI / 2;
    default:
      throw new Error(`Unknown model orientation: ${orientation}`);
  }
}
