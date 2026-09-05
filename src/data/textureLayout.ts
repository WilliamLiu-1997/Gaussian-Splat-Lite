import * as THREE from "three";
import {
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_MIN_HEIGHT,
  SPLAT_TEX_WIDTH,
} from "./defines";

// Compute a texture array size that is large enough to fit numSplats. The most
// common 2D texture size in WebGL2 is 4096x4096 which only allows for 16M splats,
// so Gaussian Splat Lite stores Gsplat data in a 2D texture array, which most platforms support
// up to 2048x2048x2048 = 8G splats. Allocations that fit within a single 2D texture
// array layer will be rounded up to fill an entire texture row. Once a texture
// array layer is filled, the allocation will be rounded up to fill an entire layer.
// This is done so the entire set of splats can be covered by min/max coords across
// each dimension.
export function getTextureSize(numSplats: number): {
  width: number;
  height: number;
  depth: number;
  maxSplats: number;
} {
  // Compute a texture array size that is large enough to fit numSplats.
  // The width is always 2048, the height sized to fit the splats but no larger than 2048.
  // The depth is the number of layers needed to fit the splats.
  // maxSplats is computed as the new total available splats that can be stored.
  const width = SPLAT_TEX_WIDTH;
  const height = Math.max(
    SPLAT_TEX_MIN_HEIGHT,
    Math.min(SPLAT_TEX_HEIGHT, Math.ceil(numSplats / width)),
  );
  const depth = Math.ceil(numSplats / (width * height));
  const maxSplats = width * height * depth;
  return { width, height, depth, maxSplats };
}

export const emptySplatTexture = (() => {
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
