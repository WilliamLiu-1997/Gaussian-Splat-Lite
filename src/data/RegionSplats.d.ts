import type { Box3 } from "three";
import { IndexedSplats } from "./IndexedSplats.js";
import type { ReorderedSplatResult } from "./defines.js";
export declare function regionAllocationSize(count: number): number;
export declare function regionTextureLayout(count: number): {
  capacity: number;
  layerSize: number;
};
/** Independently visible regions in fixed source slots. */
export declare class RegionSplats extends IndexedSplats {
  private readonly activeRanges;
  private indicesDirty;
  private boundsDirty;
  private readonly regionBounds;
  constructor(count: number, numSh: number);
  /** Records [from, to) of a region; large regions can be written in parts. */
  write(
    start: number,
    data: ReorderedSplatResult,
    from?: number,
    to?: number,
  ): void;
  setOpacity(
    start: number,
    count: number,
    opacity: number,
  ):
    | {
        visibilityChanged: boolean;
      }
    | undefined;
  /** The batch hides the region before releasing its slot. */
  release(start: number): void;
  getBoundingBox(centersOnly?: boolean, target?: Box3): Box3;
  getByteLength(): number;
  protected ensureIndices(): void;
  dispose(): void;
}
