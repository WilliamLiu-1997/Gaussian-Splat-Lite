// Viewer defaults, not guarantees of the file formats: the PlayCanvas streamed
// examples use Z-up captures; ordinary files retain the viewer's Y-down default.
// The source-axis selector overrides either default for differently oriented data.
export function getModelRotationX(orientation, streamed = false) {
  const upAxis =
    orientation === "auto" ? (streamed ? "z-up" : "y-down") : orientation;

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
