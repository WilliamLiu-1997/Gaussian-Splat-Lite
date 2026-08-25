// Gsplats are stored in textures that are 2^11 x 2^11 x up to 2^11
// Most WebGL2 implementations support 2D textures up to 2^12 x 2^12 (max 16M Gsplats)
// 2D array textures and 3D textures up to 2^11 x 2^11 x 2^11 (max 8G Gsplats),
// so we use 2D array textures for our representation for higher limits.

export const SPLAT_TEX_WIDTH_BITS = 11;
export const SPLAT_TEX_HEIGHT_BITS = 11;

export const SPLAT_TEX_WIDTH = 1 << SPLAT_TEX_WIDTH_BITS; // 2048
export const SPLAT_TEX_HEIGHT = 1 << SPLAT_TEX_HEIGHT_BITS; // 2048
export const SPLAT_TEX_MIN_HEIGHT = 1;

export enum SplatFileType {
  PLY = "ply",
  SPZ = "spz",
}

export type SplatExtra = {
  sh1?: Uint32Array;
  sh2?: Uint32Array;
  sh3a?: Uint32Array;
  sh3b?: Uint32Array;
};

export type SplatResult = {
  numSplats: number;
  splatArrays: [Uint32Array, Uint32Array];
  sortCenters?: Float32Array;
  extra: SplatExtra;
};
