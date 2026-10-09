import * as THREE from "three";
import {
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_MIN_HEIGHT,
  SPLAT_TEX_WIDTH,
} from "./defines.js";
// Keep rows compact for small sources and power-of-two layers for large ones.
// 256 layers is the WebGL2 minimum; larger devices need no special layout.
export function getTextureSize(numSplats, maxLayers = 256) {
  const width = SPLAT_TEX_WIDTH;
  const rows = Math.ceil(Math.max(1, numSplats) / width);
  const height =
    rows <= SPLAT_TEX_HEIGHT
      ? Math.max(SPLAT_TEX_MIN_HEIGHT, rows)
      : Math.min(
          SPLAT_TEX_HEIGHT,
          2 ** Math.ceil(Math.log2(Math.ceil(rows / maxLayers))),
        );
  const depth = Math.ceil(Math.max(1, numSplats) / (width * height));
  return { width, height, depth, maxSplats: width * height * depth };
}
export const emptyUintTexture = /* @__PURE__ */ (() => {
  const texture = new THREE.DataTexture(
    new Uint32Array(4),
    1,
    1,
    THREE.RGBAIntegerFormat,
    THREE.UnsignedIntType,
  );
  texture.needsUpdate = true;
  return texture;
})();
export const emptySplatTexture = /* @__PURE__ */ (() => {
  const { width, height, depth, maxSplats } = getTextureSize(1);
  const texture = new THREE.DataArrayTexture(
    new Uint32Array(maxSplats * 4),
    width,
    height,
    depth,
  );
  texture.format = THREE.RGBAIntegerFormat;
  texture.type = THREE.UnsignedIntType;
  texture.needsUpdate = true;
  return texture;
})();
