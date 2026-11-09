import type { SplatBlindTexture } from "./defines.js";

export declare function packBlindData(
  blind: SplatBlindTexture[] | undefined,
  count: number,
  capacity: number,
): void;
export declare function getBlindTextureLayout(
  capacity: number,
  groups: number,
  sourceLayerSize: number,
): {
  width: number;
  height: number;
  depth: number;
  maxSplats: number;
};
export declare function getBlindLayerUpdates(
  capacity: number,
  groups: number,
  start: number,
  count: number,
  layerSize: number,
): Set<number>;
export declare function getBlindUploadBytes(
  capacity: number,
  groups: number,
  sourceLayerSize: number,
  firstLayer: number,
  lastLayer: number,
  dirtyLayers?: ReadonlySet<number>,
): number;
