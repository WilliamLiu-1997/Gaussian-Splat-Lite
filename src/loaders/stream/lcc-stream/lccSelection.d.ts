import type { CoordinateSystem } from "three";
import type { LccIndex } from "./lccIndex.js";
export type LccView = {
  shown: boolean;
  cameras: {
    modelView: number[];
    projection: number[];
    coordinateSystem: CoordinateSystem;
    reversedDepth: boolean;
    height: number;
  }[];
};
export type LccBudgetMode = "target" | "limit";
export type LccSelectionRequest = {
  view: LccView;
  budget: number;
  splatBudgetMode: LccBudgetMode;
  lodStepDistance: number;
  maxScreenSpaceError: number;
};
export type LccSelectionResult = {
  /** Displayed detail, in loading priority order. */
  nodes: Uint32Array;
  /** Coarse coverage near the cameras that stays resident while hidden. */
  around: Uint32Array;
};
export declare class LccSelection {
  readonly empty: boolean;
  private readonly index;
  private readonly box;
  private readonly point;
  private readonly center;
  private readonly size;
  private readonly finestCount;
  private readonly units;
  private readonly coverage;
  constructor(index: LccIndex);
  select(request: LccSelectionRequest): LccSelectionResult;
  private around;
  private selectTree;
  private selectUnits;
}
